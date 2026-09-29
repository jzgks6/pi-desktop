# FORK.md —— 相对上游做了哪些改动，以及上游更新后怎么移植

上游：`https://github.com/agegr/pi-web`，本 fork 的基线是 **`96966e5`**。
下面这份清单是 `git diff 96966e5 <当前版本>` 的实际结果：**39 个文件**（+7522 / −1646）。

> **当前状态**：本 fork 的 `main` 已经压在上游 `433d09e` 之上（比基线多
> `fd037e4` / `6a1246e` / `433d09e` 三个提交，均已完整保留），这份改动作为一个提交叠在它们上面。
> 上游再更新时，按第五节把这里的改动重新叠一次。

改动性质：把界面改成 IDE 式三栏、加一个 macOS 桌面外壳。**没有动任何业务逻辑**
（会话、agent、RPC、工具调用这些一行没改）。

---

## 一、先记住三条铁律

1. **`app/globals.css` 与 `app/settings.css` 必须与上游逐字节一致。**
   fork 的样式全部写在 `app/native-theme.css`，并且在 `app/layout.tsx` 里**最后**引入
   （`globals → settings → native-theme`），靠同优先级下「后写的赢」覆盖上游。
   移植上游时这两个文件直接取上游版本即可，冲突一律以「上游原文」为准。

2. **组件里只做两件事：加一个 `className`，并删掉被它替代的 inline style。**
   inline style 永远压过样式表规则，留着不删就会出现「样式改了没反应」。

3. **桌面外壳与网页部分零耦合。**
   `desktop/` + `scripts/` 只依赖 `bin/`、`.next/`、`public/`、`node_modules/` 这四个东西的**存在**，
   不 import 任何源码。移植上游时基本不用碰它们。

---

## 二、新增文件（不依赖上游内部结构，移植时直接拷）

| 文件 | 作用 |
| --- | --- |
| `app/native-theme.css` | **fork 的全部样式**（左栏、顶栏、统计行、弹窗、会话行菜单…） |
| `lib/context-stats.ts` | 上下文统计的纯函数：`compactTokens` / `computeContextStats` / `contextStatsParts` |
| `components/ChatContextStats.tsx` | 输入框下方中间槽那一行：圆环 + 百分比 + 总 token + 缓存 + 花费 |
| `components/ContextUsageRing.tsx` | 从上游移植的圆环，加了 `decorative` 模式（避免 button 嵌套 button） |
| `design-prototypes/sessions-sidebar.html` | 左栏的设计稿（仅存档，无代码作用） |
| `desktop/`（7 个文件） | macOS 外壳：Tauri 工程 + 启动页 + 说明，详见 `desktop/README.md` |
| `scripts/package-desktop.mjs` | 打包脚本：组装运行时 → 裁剪 → `cargo tauri build` → 启动验证 |
| `reference/README.md` | 参考副本的说明（副本本身被 `.gitignore` 排除） |

---

## 三、修改文件（每个只需改对应那几处）

| 文件 | 改动量 | 改了什么 |
| --- | --- | --- |
| `components/SessionSidebar.tsx` | +285 / −250 | ① 会话/文件切成一个切换器（复用既有 `explorerOpen`，没加 state）② 新建会话满宽按钮 ③ 常驻搜索框（原来是点图标才展开）④ 项目分区标题 ⑤ 会话项的悬停按钮收进 ⋯ 菜单 ⑥ 标题超长才渐隐（`useOverflowingText` 实测 `scrollWidth`）⑦ 顶栏行（设置齿轮 + 收起侧栏） |
| `components/AppShell.tsx` | +201 / −127 | ① 三栏布局与顶栏那一行「兼作状态栏」② ⋯ 菜单（复用上游 `renderChatToolbarActions`）③ 信息面板只在中间弹出（几何按中间列矩形算）④ 脚本侧栏开关只在收起后出现 ⑤ 收起时让开红绿灯宽度 ⑥ 设置入口改为左栏齿轮 |
| `components/ChatWindow.tsx` | +57 / −124 | ① 删掉空会话头部的品牌行（logo + Pi Web + 版本号）② 扩展弹窗标题区改为「可收缩 + 40vh 硬上限」③ 消息列表加 `.chat-scroll-area`（常显滚动条）④ 删掉地图的引用 |
| `components/ExtensionStatusBar.tsx` | +26 / −15 | 抽出 `ExtensionStatusLine` 单独导出，供顶栏复用（仍只有一份实现） |
| `components/ChatInput.tsx` | +17 / −3 | ① 控制条中间槽从空 spacer 变成真居中槽（`contextSlot`）② 去掉为地图留的 `paddingRight: 52` |
| `components/BranchNavigator.tsx` | +10 / −2 | ① 图标配色跟「是否展开」而不是「是否有内容」② 下拉高度上限 `min(520px, 可视剩余空间)` |
| `components/MessageView.tsx` | ≈0 | 净改动为零（流式 token 统计删掉后又按需恢复），只有 2 条 `SAFETY:` 注释 |
| `lib/i18n/messages/{zh-CN,en,zh-TW}.ts` | +7 / −2 | 新增 6 个 key（`sidebar.viewSessions` `viewFiles` `newSession` `projects` `moreActions`、`session.cacheHitShort`、`chat.ctxUsage`）；删掉 2 个地图 key |
| `app/layout.tsx` | +3 | 引入 `native-theme.css` |
| `.gitignore` / `eslint.config.mjs` / `AGENTS.md` | 小 | 忽略规则（含打包产物）、lint 忽略 `desktop/src-tauri/{runtime,target,gen,icons}`、文档 |
| 7 个 `*.test.mjs` | 小 | 断言随 UI 结构更新 |

## 四、删除

| 文件 | 说明 |
| --- | --- |
| `components/ChatMinimap.{tsx,module.css,test.mjs}` | 整个「对话地图」。删除后要搜一遍残留：`ChatMinimap` / `chat-minimap` / `CHAT_MINIMAP` / `chatMinimap.` |

---

## 五、上游更新后怎么移植

1. **以上游新版本为起点**（`git merge upstream/main`，或干脆把上游新版当母本、把本 fork 的改动搬过去）。
2. 先拷**第二节的新增文件** —— 它们不依赖上游内部结构，冲突风险最低。
3. 再按**第三节**逐文件改，每个文件只动那一行说明里的几处；改完对照该行自查。
4. 处理**第四节**的删除，并清掉全部残留引用。
5. `desktop/` + `scripts/` 一般不用动，只确认三件事：
   - `bin/pi-web.js` 的 CLI（`-p` / `--no-open`）与 `.next` 的目录约定没变；
   - `tauri.conf.json` 的 `productName`、`bundle.resources: ["runtime/"]` 仍在；
   - `main.rs` 里对 `runtime/app/...` 的路径假设仍成立。
6. **跑门禁**：`npx tsc --noEmit` → 0、`npx eslint .` → 0、`npm test`（1304 项）。
   界面上还有几条要人眼看的：红绿灯位置、左栏观感、滚动条。

## 六、容易踩的坑（都是踩过的）

- **`globals.css` / `settings.css` 被上游改动时**，不要直接把改动抄进 `native-theme.css`。
  先看上游改的是哪条规则，再决定「跟随」还是「覆盖」——两条路写进 `native-theme.css` 的样子不一样。
- **inline style 与样式表的优先级**（铁律 2）。加 className 的同时必须删掉旧 inline style。
- **`.topbar-tools-menu > div { flex-direction: column !important }`**
  这条规则瞄的是菜单的「直接子 div」。菜单里**只能有一个直接子 div**（现在就是上游那组按钮）。
  往菜单里加东西要用更具体的选择器，否则会连带被竖排。
- **扩展弹窗标题区的 `maxHeight` 必须是 `vh` 而不是 `%`。**
  父容器高度由内容撑开时，百分比 max-height 按规范会被当成 `none` —— 长标题会撑满整块、
  把下面的选项挤出去，再被 `overflow: hidden` 裁掉。曾经的 `maxHeight: "50%"` 就是这个 bug。
- **红绿灯位置在 `desktop/src-tauri/src/main.rs`**，`traffic_light_position` 的第二个参数
  **不是「距顶部的距离」**：AppKit 左下原点、tao 只改按钮的 X，所以该值使按钮整体下移，
  斜率正好 1。当前标定与历史写在代码注释里。
- **打包脚本的两道闸别删**：① 组装运行时不会被别的开关顺带跳过（只能用 `--reuse-runtime` 显式要求）；
  ② 运行时的 `.next/BUILD_ID` 必须与仓库一致。两条都是「app 里跑的是旧构建」之后加的。
- **改 `productName` 后 `cargo tauri build` 不会删旧包**，`bundle/macos` 下会新旧并存；
  按名字挑产物的地方（含脚本的验证步）可能挑到旧的，脚本现在会自动清掉。

---

## 七、上游更新后怎么操作（逐条命令）

### 先弄清两个远端

| 名字 | 是什么 | 用途 |
| --- | --- | --- |
| `origin` | 你自己的 fork（`jzgks6/pi-desktop`） | 你写的东西推到这里 |
| `upstream` | 上游（`agegr/pi-web`） | **只读**，只从它拉，永远不往它推 |

你的历史是「上游的一长串提交 + 顶上你自己的 1 个提交」。
上游更新就是它那条串尾上又长了几个提交；你要做的是把这些新提交接进来，
同时保留自己顶上那个 —— 这就是 `git merge upstream/main` 干的事。

**为什么不能图省事直接把自己的目录覆盖过去**：你的代码是基于**较早的上游**写的，
覆盖等于把上游后来做的功能删掉。本项目第一次同步时上游正好多了 3 个提交
（`fd037e4` / `6a1246e` / `433d09e`），其中 7 个文件与本地改动重叠，
直接覆盖就会静默地把它们删掉。

### 命令

```bash
git remote add upstream https://github.com/agegr/pi-web.git   # 只需一次
git remote set-url --push upstream DISABLE                    # 防止手误往上游推，只需一次
```

以后每次上游更新：

```bash
# 1. 确认工作区干净（有未提交的改动就先 commit）
git status

# 2. 抓上游的最新提交（只下载，不动你的文件）
git fetch upstream

# 3. 看看上游新增了什么（可选）
git log --oneline HEAD..upstream/main

# 4. 先留一条退路：出问题可以 git reset --hard backup/before-merge 回到现在
git branch backup/before-merge

# 5. 合并上游 —— 这一步可能报 CONFLICT（见下）
git merge upstream/main

# 6. 门禁，三项都要通过
npx tsc --noEmit
npx eslint .
npm test

# 7. 推到你自己的仓库
git push
```

### 第 5 步报冲突怎么办

`git status` 会把冲突文件列在 `Unmerged paths` 下。打开它们会看到：

```text
<<<<<<< HEAD
（你的版本）
=======
（上游的版本）
>>>>>>> upstream/main
```

把它改成最终想要的样子（多数情况是两边各留一部分），删掉 `<<<<<<<` / `=======` /
`>>>>>>>` 这三行标记，然后：

```bash
git add <改好的文件>     # 声明这个文件已解决
git merge --continue     # 完成这次合并（沿用自动生成的那条信息即可）
```

改完记得**再跑一次门禁**。冲突里最容易出事的不是报错，而是「语法没错但两边只留了一边」——
测试一般能抓住，所以第 6 步不要跳。

### 不要做的事

- 不要 `git push --force`：会改掉远端历史
- 不要用 `git pull` 拉上游：`pull` = `fetch` + `merge`，容易糊里糊涂合错东西，分成两步看清楚更安全
- 不要在没留 `backup/xxx` 分支的情况下动手

### 合并后如果界面不对

先确认是不是 `.next` 缓存：`node_modules/.bin/next build`（开发时用 `npm run dev`）。
界面本身要看的那几处（红绿灯位置、左栏观感、滚动条）在 `desktop/README.md` 末尾有清单。

---

## 八、和上游保持一致的三个取舍点

这几处是**有意偏离上游**的，移植时不要「顺手改回去」：

1. **左栏同一时间只显示会话或文件**（上游是上下分栏 + 可拖把手）。
   代价是失去同时可见；换来的是每栏都能占满高度。
2. **对话地图整条移除**（上游有）。它的滚动定位能力现在由右边缘的常显滚动条承担。
3. **四主题里只重绘了 light / dark**；`mist` / `rose` / `pine` 保留各自的调色板，
   只从 `:root` 拿结构令牌（圆角、行高、字号）。`native-theme.css` 里的选择器写成
   `html.dark[data-theme="dark"]` 就是为了不去覆盖那三套。
