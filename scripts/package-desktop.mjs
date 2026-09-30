#!/usr/bin/env node
/**
 * 把 pi-web 打成 macOS app。
 *
 * 思路：pi-web 本质是「一个 Next 服务 + 一堆 Node 依赖」，所以 app 里要装的是
 * 一份能独立运行的运行时，而不是把源码塞进去。运行时目录结构：
 *
 *   src-tauri/runtime/
 *     bin/node                    当前这台机器上的 node（独立二进制，只依赖系统框架）
 *     app/bin/pi-web.js           启动器
 *     app/.next/                  构建产物（丢掉 cache，536M -> 33M）
 *     app/public/
 *     app/node_modules/           生产依赖，按平台裁掉其它系统的原生二进制
 *     app/package.json
 *
 * 用法：
 *   node scripts/package-desktop.mjs                 # 全流程
 *   node scripts/package-desktop.mjs --skip-build    # 复用现有 .next
 *   node scripts/package-desktop.mjs --reuse-runtime # 故意复用已组装好的运行时
 *   node scripts/package-desktop.mjs --assemble-only # 只组装运行时，不调 tauri
 *   node scripts/package-desktop.mjs --verify        # 打包后再启动一次，确认服务真的起来
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, readdirSync, copyFileSync, chmodSync, realpathSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DESKTOP = join(REPO, "desktop");
const TAURI_DIR = join(DESKTOP, "src-tauri");
const RUNTIME = join(TAURI_DIR, "runtime");
const APP_DIR = join(RUNTIME, "app");

const args = new Set(process.argv.slice(2));

// 版本门槛的唯一来源：app 启动时用的就是 bin/node-version.js
const require_ = createRequire(import.meta.url);
const { isNodeVersionSupported, MIN_NODE_VERSION } = require_("../bin/node-version.js");
const flag = (name) => args.has(`--${name}`);
const value = (name, fallback) => {
  for (const a of args) if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  return fallback;
};

const ARCH = value("arch", process.arch); // arm64 | x64
const OTHER_ARCH = ARCH === "arm64" ? "x64" : "arm64";

const log = (msg) => console.log(`  ${msg}`);
const step = (msg) => console.log(`\n▸ ${msg}`);
const sh = (cmd, argv, opts = {}) =>
  execFileSync(cmd, argv, { stdio: "inherit", cwd: REPO, ...opts });

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(p);
      else total += statSync(p).size;
    }
  };
  walk(dir);
  return total;
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}M`;

/**
 * 裁掉非本平台的原生二进制。
 *
 * 这是体积的大头：pi-coding-agent 把 esbuild、Next 把 swc 的
 * 全平台二进制都装进了 node_modules，光这两样就 ~400M，
 * 而 app 只需要当前架构那一份。npm 用 optionalDependencies 装这些包，
 * 运行时代码按 process.platform/arch 去 require，所以删掉别的平台是安全的。
 */
function prunePatterns() {
  const platforms = [
    "linux-x64", "linux-arm64", "linux-arm", "linux-ia32", "linux-ppc64", "linux-ppc64le",
    "linux-riscv64", "linux-s390x", "linux-mips64el", "linux-mipsel", "linux-loong64",
    "win32-x64", "win32-arm64", "win32-ia32",
    "android-arm64", "android-arm", "android-x64", "android-ia32",
    "freebsd-x64", "freebsd-arm64", "openbsd-x64", "netbsd-x64", "sunos-x64",
  ];
  // 当前架构不用的那一个 darwin 变体也裁掉（arm64 机器上删 x64，反之亦然）
  const patterns = [...platforms, `darwin-${OTHER_ARCH}`];
  return patterns.flatMap((p) => [
    `--exclude=${p}`,
    `--exclude=@esbuild/${p}`,
    `--exclude=prebuilds/${p}`,
    `--exclude=${p}.exe`,
  ]);
}

function copyTree(src, dest, extraArgs = []) {
  mkdirSync(dest, { recursive: true });
  // 用 rsync 而不是 cp：可以直接跳过不想要的分支，不必先复制 1.2G 再删
  execFileSync("rsync", ["-a", ...extraArgs, `${src}/`, `${dest}/`], { stdio: "inherit" });
}

/**
 * 让 npm 自己算出「生产依赖闭包」的顶层包名。
 *
 * 直接整份复制 node_modules 会把 dev 依赖也带进去（实测多出 979M：mermaid 84M、
 * typescript 23M、@img 26M、playwright-core 13M…）。而运行时的真实需求是：
 * 客户端代码早被 webpack 打进 .next/static 了，服务端只需要生产依赖。
 * 让 npm 回答这个问题比手写一份白名单可靠。
 */
function prodTopLevelNames() {
  const root = realpathSync(REPO);
  const out = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
    cwd: root,
    encoding: "utf8",
    // npm ls 在依赖树不完美时会返回非 0，但 stdout 仍然是可用的
    stdio: ["ignore", "pipe", "ignore"],
  });
  const prefix = `${root}/node_modules/`;
  const names = new Set();
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes("/node_modules/")) continue; // 嵌套依赖随它的父包一起保留
    names.add(rest);
  }
  return names;
}

/** 把运行时里的 node_modules 裁到生产闭包（顶层维度）。 */
function pruneToProdDeps() {
  const nm = join(APP_DIR, "node_modules");
  const keep = prodTopLevelNames();
  if (keep.size === 0) {
    log("⚠ 算不出生产闭包（npm ls 没输出），保留全部 node_modules");
    return;
  }

  let removed = 0;
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue; // .bin / .package-lock.json / .modules.yaml
    if (entry.startsWith("@")) {
      const scopeDir = join(nm, entry);
      for (const sub of readdirSync(scopeDir)) {
        if (keep.has(`${entry}/${sub}`)) continue;
        rmSync(join(scopeDir, sub), { recursive: true, force: true });
        removed += 1;
      }
      if (readdirSync(scopeDir).length === 0) rmSync(scopeDir, { recursive: true, force: true });
      continue;
    }
    if (keep.has(entry)) continue;
    rmSync(join(nm, entry), { recursive: true, force: true });
    removed += 1;
  }
  log(`按生产闭包裁掉 ${removed} 个顶层包（保留 ${keep.size} 个）`);
}

/**
 * esbuild 把全平台二进制都装进 node_modules（`@esbuild/<platform>`），
 * 运行只会用当前架构那一份。实测这是最大的一块 —— pi-coding-agent 内嵌的
 * 还带 aix-ppc64 / openharmony-arm64 / netbsd-arm64 这类冷门平台，
 * 用黑名单枚举列不完整，所以改成「只留当前架构」的白名单做法。
 */
function pruneForeignBinaries() {
  const nm = join(APP_DIR, "node_modules");
  const keep = `darwin-${ARCH}`;
  const esbuildDirs = [];

  const collect = (dir) => {
    const candidate = join(dir, "node_modules", "@esbuild");
    if (existsSync(candidate)) esbuildDirs.push(candidate);
  };
  if (existsSync(join(nm, "@esbuild"))) esbuildDirs.push(join(nm, "@esbuild"));
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      const scopeDir = join(nm, entry);
      for (const sub of readdirSync(scopeDir)) collect(join(scopeDir, sub));
    } else {
      collect(join(nm, entry));
    }
  }

  let removed = 0;
  for (const dir of esbuildDirs) {
    for (const platform of readdirSync(dir)) {
      if (platform === keep) continue;
      rmSync(join(dir, platform), { recursive: true, force: true });
      removed += 1;
    }
  }
  log(`清掉 ${removed} 个非 ${keep} 的 esbuild 平台包`);
}

/**
 * 清掉悬空软链接。
 *
 * node_modules/.bin 里全是指向具体包的软链，按生产闭包裁完之后会留下指向
 * 已删包的断链。tauri-build 会遍历资源目录，遇到断链直接报
 * 「resource path ... doesn't exist」而失败；即使留到运行时，npm 的
 * postinstall 之类也会被这种目录弄碍。
 */
function pruneDanglingLinks() {
  const nm = join(APP_DIR, "node_modules");
  const binDir = join(nm, ".bin");
  if (!existsSync(binDir)) return;
  let removed = 0;
  for (const entry of readdirSync(binDir)) {
    const target = join(binDir, entry);
    // existsSync 会跟随软链：断链返回 false
    if (existsSync(target)) continue;
    rmSync(target, { force: true });
    removed += 1;
  }
  if (removed > 0) log(`清掉 ${removed} 个悬空软链接（node_modules/.bin）`);
}

function stepBuild() {
  step("构建 Next 产物");
  sh("npm", ["run", "build"], { env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
}

/**
 * 选一份可以打进包里的 node。
 *
 * 不能直接用 process.execPath。原因是 app 里的 Rust 壳会把
 * `<runtime>/bin` 插到它拉起的子进程 PATH 最前面（见 main.rs 的 child_path），
 * 而 pi agent 往往就跑在那条进程链里 —— 于是本脚本看到的 `node` 可能是
 * 「上一个版本的 app 包里那份 node」，变成用旧包的 node 去造新包。
 * （两份内容通常一样，但这是个说不清的循环依赖，直接排除。）
 *
 * 版本门槛用 bin/node-version.js 里那份，不在这里再写一遍 ——
 * app 启动时就是按那个门槛拦截的，两边必须一致。
 */
function nodeCandidates() {
  return [
    process.env.PI_DESKTOP_NODE,
    process.execPath,
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
}

/** 候选在本地的可用性检查；通过则返回 { path, version }，否则返回一句排除理由。 */
function checkNodeCandidate(candidate) {
  if (candidate.includes(".app/Contents/") || candidate.includes("src-tauri/runtime")) {
    return `${candidate}（在 app 包里）`;
  }
  if (!existsSync(candidate)) {
    return `${candidate}（不存在）`;
  }
  let version;
  try {
    version = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim();
  } catch (err) {
    return `${candidate}（跑不起来：${err?.message ?? err}）`;
  }
  if (!isNodeVersionSupported(version)) {
    return `${candidate}（${version} 低于 ${MIN_NODE_VERSION}）`;
  }
  return { path: candidate, version };
}

/**
 * 把选中的 node 装到 dest，并**按复制出来那份验收**。
 *
 * 踩过的坑：homebrew 的 node 26 是共享库构建 —— `/opt/homebrew/bin/node` 只有
 * 132 KB，真正的实现在 `@rpath/libnode.147.dylib` 里（还挂着 libuv / llhttp / abseil
 * 一堆 `/opt/homebrew/opt/...` 绝对路径）。这种候选**原地跑 `--version` 完全正常**，
 * 但单独 copyFileSync 出来就 dyld 报缺库。当时本函数只看原路径，于是包照打不误，
 * app 却在启动页永远等下去（Rust 壳拉起的 node 秒崩、端口一直不监听）。
 * 所以验收必须在**目标位置**做，失败的候选直接顺延到下一个。
 */
function installNodeBinary(dest) {
  const rejected = [];
  for (const candidate of nodeCandidates()) {
    const checked = checkNodeCandidate(candidate);
    if (typeof checked === "string") {
      rejected.push(checked);
      continue;
    }
    copyFileSync(checked.path, dest);
    chmodSync(dest, 0o755);
    try {
      const version = execFileSync(dest, ["--version"], { encoding: "utf8" }).trim();
      return { path: checked.path, version };
    } catch (err) {
      const detail = String(err?.stderr ?? err?.message ?? err)
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      rejected.push(`${checked.path}（复制出来跑不起来：${detail ?? "未知错误"}）`);
      rmSync(dest, { force: true });
    }
  }

  throw new Error(
    [
      "找不到能用的 node 二进制。",
      "要求是「单独复制出来仍然能跑」的独立二进制（只依赖系统框架）。",
      "homebrew 的 node 26+ 是共享库构建（@rpath/libnode.*.dylib + 一堆",
      "/opt/homebrew/opt/... 绝对路径），复制单个文件必然缺库；遇到过就绕开它：",
      "  cp \"<某个能跑的 node>\" ~/Library/Caches/pi-desktop/node",
      "  PI_DESKTOP_NODE=~/Library/Caches/pi-desktop/node node scripts/package-desktop.mjs",
      `已排除：${rejected.join("、")}`,
    ].join("\n"),
  );
}

function stepAssemble() {
  step("组装运行时");
  // 组装必须是默认行为，跳过要人明说。
  // 曾经这里写的是「--verify 模式下且运行时已存在就跳过」—— 而打包那次正好是
  // --skip-build --verify，于是组装整步被跳过，app 里装的是上一版 .next，
  // 源码里删掉的组件在 app 里依旧活着。跳过组装可以，但不能是某个模式的副作用。
  if (flag("reuse-runtime") && existsSync(join(APP_DIR, "node_modules"))) {
    log("按 --reuse-runtime 复用已组装好的运行时");
    return;
  }
  rmSync(RUNTIME, { recursive: true, force: true });
  mkdirSync(APP_DIR, { recursive: true });

  // 1) node：拿一份干净的、非 app 包内的 node（只依赖系统框架的独立二进制）
  const nodeDir = join(RUNTIME, "bin");
  mkdirSync(nodeDir, { recursive: true });
  const { path: nodeSrc, version: nodeVersion } = installNodeBinary(join(nodeDir, "node"));
  log(`node        ${nodeSrc} (${nodeVersion}) → runtime/bin/node`);

  // 2) 启动器与包元数据
  copyTree(join(REPO, "bin"), join(APP_DIR, "bin"));
  copyFileSync(join(REPO, "package.json"), join(APP_DIR, "package.json"));
  log("bin/ package.json");

  // 3) 构建产物：只丢 cache —— 那 536M 是构建期缓存，运行时用不到；
  //    trace / trace-build / diagnostics / types 同理，只有分析工具会读；
  //    dev 是 `next dev` 留下的开发产物（跑过 dev server 后能到 739M，
  //    而且 next build 不会替我们清掉它）。
  copyTree(join(REPO, ".next"), join(APP_DIR, ".next"), [
    "--exclude=/cache",
    "--exclude=/dev",
    "--exclude=/trace",
    "--exclude=/trace-build",
    "--exclude=/diagnostics",
    "--exclude=/types",
  ]);
  log(".next/ (已剔除 cache / dev 等构建期目录)");

  // 4) 静态资源
  copyTree(join(REPO, "public"), join(APP_DIR, "public"));
  log("public/");

  // 5) 生产依赖（先按平台裁剪减少复制量，复制完再按 npm 的生产闭包精确裁一遍）
  step("复制 node_modules（裁剪非本平台二进制）");
  copyTree(join(REPO, "node_modules"), join(APP_DIR, "node_modules"), prunePatterns());
  log("node_modules/ 已复制");

  step("裁剪 node_modules");
  pruneForeignBinaries();
  pruneToProdDeps();
  pruneDanglingLinks();

  // node-pty 的 spawn-helper 在部分版本里不带可执行位（上游 prepare-terminal.js
  // 就是为这个打的补丁）。Rust 壳启动时还会再确认一次，这里先修一遍更保险。
  for (const rel of [
    `node_modules/node-pty/prebuilds/darwin-${ARCH}/spawn-helper`,
    "node_modules/node-pty/build/Release/spawn-helper",
  ]) {
    const p = join(APP_DIR, rel);
    if (existsSync(p)) chmodSync(p, 0o755);
  }

  const total = dirSize(RUNTIME);
  const parts = ["bin", "app/.next", "app/node_modules", "app/public"];
  for (const p of parts) {
    const full = join(RUNTIME, p);
    if (existsSync(full)) log(`  ${p.padEnd(20)} ${mb(dirSize(full))}`);
  }
  log(`运行时合计 ${mb(total)}`);
  assertRuntimeMatchesBuild();
}

/**
 * 组装完对一下 BUILD_ID。
 *
 * 这是「源码改了但包里是旧构建」的最后一道闸。上面那个跳过组装的坑，
 * 如果当时有这个检查，当场就会报出来，而不是等你启动 app 才发现地图还在。
 */
function assertRuntimeMatchesBuild() {
  const repoBuildId = join(REPO, ".next", "BUILD_ID");
  const runtimeBuildId = join(APP_DIR, ".next", "BUILD_ID");
  if (!existsSync(repoBuildId) || !existsSync(runtimeBuildId)) {
    throw new Error("运行时缺少 .next/BUILD_ID，组装不完整");
  }
  const repo = readFileSync(repoBuildId, "utf8").trim();
  const runtime = readFileSync(runtimeBuildId, "utf8").trim();
  if (repo !== runtime) {
    throw new Error(
      `运行时与源码不同步：仓库 .next/BUILD_ID=${repo}，运行时=${runtime}` +
        "—— 包里会是旧构建，请重新组装",
    );
  }
  log(`BUILD_ID 与源码一致：${runtime}`);
}

function stepIcons() {
  const target = join(TAURI_DIR, "icons", "icon.icns");
  // 图标源：优先 fork 自己的 desktop/icon.png（由 scripts/make-icon.py 生成），
  // 没有才回落到上游 PWA 用的 public/icons/icon-512.png。
  const forkMaster = join(REPO, "desktop", "icon.png");
  const source = existsSync(forkMaster)
    ? forkMaster
    : join(REPO, "public", "icons", "icon-512.png");
  // 源文件比产物新也要重建，否则改完图标会静默地不生效
  const fresh =
    existsSync(target) && statSync(target).mtimeMs >= statSync(source).mtimeMs;
  if (fresh && !flag("force-icons")) {
    log("图标已是最新，跳过（要强制重建加 --force-icons）");
    return;
  }
  step("生成 app 图标");
  log(`  源：${relative(REPO, source)}`);
  // tauri icon 会从一张 PNG 生成 icns/ico/各尺寸 png
  execFileSync("cargo", ["tauri", "icon", source, "--output", "icons"], {
    cwd: TAURI_DIR,
    stdio: "inherit",
  });
}

/**
 * 找 cargo。不能直接依赖 PATH：如果这个脚本是在 app 拉起的进程链里跑的，
 * PATH 里只有 app 自己那份（runtime/bin + 系统目录 + homebrew），
 * 而 rustup 装在 ~/.cargo/bin —— 结果就是 spawnSync cargo ENOENT。
 */
function resolveCargo() {
  const candidates = [
    process.env.CARGO,
    process.env.HOME ? join(process.env.HOME, ".cargo", "bin", "cargo") : undefined,
    "/opt/homebrew/bin/cargo",
    "/usr/local/bin/cargo",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    // 最后给 PATH 一个机会（比如自定义了 CARGO_HOME 并已加进 PATH）
    return execFileSync("/usr/bin/which", ["cargo"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error(
      "找不到 cargo。装了 rustup 的话应该在 ~/.cargo/bin/cargo（可用 CARGO=… 指定）",
    );
  }
}

/** 当前配置里的 app 名（tauri.conf.json 的 productName）。 */
function productName() {
  const configPath = join(TAURI_DIR, "tauri.conf.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).productName;
  } catch (err) {
    throw new Error(`读不出 ${configPath} 里的 productName：${err?.message ?? err}`);
  }
}

/**
 * 清掉 bundle 目录里名字对不上的旧 app。
 *
 * Tauri 不会删掉改名前的产物 —— 改了 productName 之后，旧包会和新包一起留在
 * bundle/macos 下，而按名字挑产物的地方（包括本脚本的验证步）就可能挑到旧的，
 * 于是「验证通过」其实验的是上一版。删掉是唯一干净的做法。
 */
function pruneStaleBundles() {
  const dir = join(TAURI_DIR, "target", "release", "bundle", "macos");
  if (!existsSync(dir)) return;
  const expected = `${productName()}.app`;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".app") || name === expected) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    log(`清掉旧 app：${name}`);
  }
}

function stepTauri() {
  step("cargo tauri build");
  pruneStaleBundles();
  // 只出 .app。dmg 需要 Tauri 的 bundle_dmg.sh 用 AppleScript 驱动 Finder 排版本
  // （要「自动化」权限，会弹窗卡住），而且这个 app 是自己用，没有分发需求。
  const bundles = value("bundles", "app");
  const tauriArgs = ["tauri", "build", "--bundles", bundles];
  if (flag("debug")) tauriArgs.push("--debug");
  const cargo = resolveCargo();
  log(`cargo       ${cargo}`);
  sh(cargo, tauriArgs, { cwd: DESKTOP });
}

function reportArtifacts() {
  step("产物");
  const bundleDir = join(TAURI_DIR, "target", "release", "bundle");
  const found = [];
  for (const kind of ["macos", "dmg"]) {
    const dir = join(bundleDir, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      // macos/ 下只认当前 productName 那个（改名前的旧包可能还在）
      if (kind === "macos" && name !== `${productName()}.app`) continue;
      // 跳过 DMG 打包中途的临时文件（rw.<pid>.xxx.dmg）与辅助脚本
      if (name.endsWith(".app") || (name.endsWith(".dmg") && !name.startsWith("rw."))) {
        found.push(join(dir, name));
      }
    }
  }
  if (found.length === 0) {
    log("没找到产物，看看上面的编译输出");
    return [];
  }
  for (const p of found) {
    const stat = statSync(p);
    log(`${p}   (${mb(stat.isDirectory() ? dirSize(p) : stat.size)})`);
  }
  return found;
}

/**
 * 启动打好的 app，确认它真的能把服务拉起来。
 *
 * 测两遍是有意的：第一遍验证「能跑」，然后用 SIGKILL 强杀掉 —— 模拟崩溃/注销，
 * 这种情况下 Rust 的退出清理来不及跑，服务会变成孤儿占着端口；
 * 第二遍验证壳能不能「接管」那个残留服务、并且仍然落在同一个端口上
 * （端口一变 origin 就变，localStorage 里的主题/面板状态就没了）。
 */
async function verify(appPath) {
  step("验证：启动打好的 app");
  const appBin = join(appPath, "Contents", "MacOS");
  const exe = existsSync(appBin) ? join(appBin, readdirSync(appBin)[0]) : null;
  if (!exe) {
    log(`找不到可执行文件于 ${appBin}`);
    return false;
  }

  const PORT = 30145;
  const URL = `http://127.0.0.1:${PORT}/api/home`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const waitUntilUp = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try {
        // nosemgrep -- 这是对回环地址上「我们自己刚拉起的 app」做健康检查，
        // 不经过任何网络，不存在明文传输风险（目标就是 127.0.0.1 的本地服务）。
        const res = await fetch(URL, { signal: AbortSignal.timeout(4000) });
        if (res.ok) return true;
      } catch { /* 还没起来 */ }
      await sleep(500);
    }
    return false;
  };

  // 清场：app 与它拉起的服务都干掉。孤儿服务不在 app 的进程组里，
  // 所以直接按「谁占着这个端口」来杀。
  const cleanup = () => {
    try {
      const pids = execFileSync("/usr/sbin/lsof", ["-nP", `-iTCP:${PORT}`, "-sTCP:LISTEN", "-t"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      for (const pid of pids) {
        try { process.kill(Number(pid), "SIGTERM"); } catch { /* 已退出 */ }
      }
      return pids.length;
    } catch {
      return 0;
    }
  };

  log(`第一遍：启动 ${exe}`);
  const first = spawn(exe, [], { stdio: "inherit" });
  const up1 = await waitUntilUp(120000);
  log(up1 ? `服务已响应 ${URL}` : `超时：${URL} 没有响应`);

  log("强杀（模拟崩溃，故意不让退出清理跑）");
  try { first.kill("SIGKILL"); } catch { /* 已退出 */ }
  await sleep(2500);

  log("第二遍：再启动一次，看能不能接管残留服务并留在同一端口");
  const second = spawn(exe, [], { stdio: "inherit" });
  const up2 = await waitUntilUp(120000);
  log(up2 ? `服务已响应 ${URL}（端口未漂移）` : `接管失败：${URL} 没有响应`);
  try { second.kill("SIGKILL"); } catch { /* 已退出 */ }

  await sleep(1000);
  const killed = cleanup();
  await sleep(2500);
  let leaked = false;
  try {
    // nosemgrep -- 同上，仅用于确认本地端口已释放
    await fetch(URL, { signal: AbortSignal.timeout(1500) });
    leaked = true;
  } catch { /* 端口已释放，正常 */ }
  log(`清场：收掉 ${killed} 个占用进程 → ${leaked ? "端口仍被占用" : "端口已释放"}`);

  return up1 && up2 && !leaked;
}

async function main() {
  console.log("打包 Pi Web 桌面版");
  log(`架构 ${ARCH}，仓库 ${REPO}`);

  if (!flag("skip-build")) stepBuild();
  else log("跳过 next build（--skip-build）");

  stepAssemble();
  stepIcons();
  if (!flag("assemble-only") && !flag("skip-tauri")) stepTauri();
  else if (flag("skip-tauri")) log("跳过 tauri build（--skip-tauri，复用上次产物）");
  reportArtifacts();

  if (flag("verify")) {
    // 锁死到当前 productName：不能按「第一个 .app」挑，改名后目录里可能还有旧包
    const appPath = join(TAURI_DIR, "target", "release", "bundle", "macos", `${productName()}.app`);
    if (!existsSync(appPath)) {
      log(`没有 ${appPath} 可验证`);
      process.exitCode = 1;
      return;
    }
    const passed = await verify(appPath);
    if (!passed) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\n打包失败: ${err?.message ?? err}`);
  process.exit(1);
});
