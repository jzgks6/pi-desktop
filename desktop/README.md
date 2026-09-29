# pi desktop（macOS 外壳）

这个目录不是一份独立应用，而是「把 `pi-web` 包成一个 macOS app」的那层壳。

```text
dist/index.html            启动页：服务起来之前显示（Tauri 的 frontendDist）
src-tauri/
  src/main.rs              外壳逻辑：挑端口 → 拉起 node → 导航 → 退出清理
  tauri.conf.json          productName / bundle.resources = runtime/
  Cargo.toml
  runtime/                 打包时组装出来的运行时（gitignore，约 670M）
  target/ gen/ icons/      cargo 产物与生成物（gitignore）
```

## 它到底做了什么

`pi-web` 本质是「一个 Next 服务 + 一堆 Node 依赖」，所以 app 里装的不是源码，而是一份
**能独立运行的运行时**：

```text
runtime/
  bin/node                  独立 node 二进制（只依赖系统框架）
  app/bin/pi-web.js         启动器
  app/.next/                构建产物（已剔除 cache 等构建期目录）
  app/node_modules/         生产依赖（已裁掉其它平台的原生二进制）
  app/public/
```

`main.rs` 依次：修可执行位 → 选端口（首选 30145，被上一次残留的 pi-web 占着就接管它）
→ 拉起 `node bin/pi-web.js -p <port> --no-open` → 先把启动页显示出来 → 等服务开始监听
→ 把窗口导航过去。关窗口只是隐藏（macOS 习惯），⌘Q 或程序坞「退出」才收掉服务。

## 打包

```bash
node ../scripts/package-desktop.mjs --verify       # 全流程 + 启动验证
node ../scripts/package-desktop.mjs --skip-build   # 复用现有 .next
```

产物在 `src-tauri/target/release/bundle/macos/pi desktop.app`。

脚本里有两个闸，都是踩过坑之后加的：

1. **组装运行时不会被别的开关顺带跳过** —— 只能用 `--reuse-runtime` 显式要求。
   （曾经 `--verify` 会顺手跳过组装，结果 app 里塞的是上一版 `.next`，
   源码里已删除的组件在 app 里还活着。）
2. **运行时的 `.next/BUILD_ID` 必须与仓库一致**，否则直接报错退出。

## 红绿灯位置怎么调

`tauri.conf.json` 管不到它，在 `src/main.rs` 的 `traffic_light_position`。注意第二个参数
不是「距顶部的距离」：AppKit 是左下原点，tao 只改按钮的 X，所以该值会让按钮整体下移，
**斜率正好是 1**（y 减 1，红绿灯上移 1pt）。当前标定见那里的注释。
