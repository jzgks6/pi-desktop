# FORK.md —— 相对上游做了哪些改动，以及上游更新后怎么移植

上游：`https://github.com/agegr/pi-web`，本 fork 的基线是 **`96966e5`**。
下面这份清单的规模用这条命令量（`upstream/main` 已经并进来了，所以量到的就是 fork 自己那部分）：
`git diff --stat upstream/main HEAD` → **64 个文件**（+12043 / −1898）。

> **当前状态**：本 fork 的 `main` 压在上游 `7303179` 之上 —— 比基线 `96966e5` 多 12 个上游提交
> （`fd037e4` / `6a1246e` / `433d09e`，加上后来 merge 进来的 9 个，均已完整保留），
> fork 自己 4 个提交 + 1 个 merge commit 叠在它们上面。
> 上游再更新时，按第五节把这里的改动重新叠一次。

改动性质：把界面改成 IDE 式三栏 + 顶栏会话标签条、加一个 macOS 桌面外壳。**没有动任何业务逻辑**
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
| `lib/session-tabs.ts` | 会话标签的纯函数 + `localStorage` 读写：标签的开关 / 去重 / 转正 / 关闭，草稿按标签隔离的键（`draftKeyForTab` / `parkedDraftKeyForTab`），以及「最多一个空白草稿标签」的折叠规则（空白标签一旦打开就不会被别处收掉） |
| `lib/file-attachments.ts` | 「附加文件」的纯函数：图片/非图片分类、`@路径` 提及、发送前拼装（`composeOutgoingMessage`）、把文件交给暂存路由的 `stageAttachmentFile`、以及按路径识别桌面对话框选中文件的 `inspectPickedPaths` / `fileFromBase64` |
| `lib/desktop-file-picker.ts` | 桌面壳的原生文件选择窗口：探测 `window.__TAURI_INTERNALS__`、调 `plugin:dialog|open` 拿真实路径（浏览器里是纯 no-op，调用方回落 `<input type=file>`），以及图片魔数嗅探 `sniffImageMime` |
| `lib/attachment-staging.ts` | 暂存侧的名字处理（仅服务端）：暂存目录 `~/.pi/attachments/`、文件名消毒/截断（保留扩展名）、时间戳前缀与同秒去重。**只有普通浏览器用得到**（app 里走原生路径，不拷贝） |
| `components/SessionTabBar.tsx` | 中栏顶栏左端的会话标签条：横向滚动 + 两侧滚动按钮（只在那一侧还有内容时出现）+ 右侧 `+`，标签带运行中呼吸点与关闭按钮；标签可按住左右拖拖动排序。尺寸 / 配色照右栏的 `TabBar`；滚动行为与会话标签条共用 `hooks/useTabStripScroll.ts` |
| `hooks/useTabStripScroll.ts` | 一条横向标签栏的滚动行为：两侧箭头、滚轮映射成横向滚动、活动项自动进视野。会话标签条与右栏文件标签条共用（两个地方的边界条件很容易各自跑偏） |
| `hooks/useTabStripDrag.ts` | 同一个横向标签栏的「按住拖动排序」：被拖的贴着指针走、其它项 FLIP 滑到新位置、拖完吞掉那一下 click。按 **DOM 节点** 而不是 id 工作（右栏标签是上游渲染的，加不了 `data-*`），且同时支持「逐项绑定」与会话标签条和「事件委托」（右栏）两种入口；FLIP 用 WAAPI，因为右栏的 `transition` 是上游的 inline 值，fork 加不进 `transform` |
| `components/FileTabStrip.tsx` | 右栏头部的文件标签条：把上游 `TabBar` 包一层两端滚动按钮，隐掉上游自己画的那条**原生滚动条**（它占高度、会把文件标签标题裁掉），并接上与会话标签条同一套的**拖动排序**。上游 `TabBar.tsx` 只多了一个 `className="file-tabs"` |
| `hooks/useDesktopMenuCommands.ts` | 按桌面壳原生菜单发过来的 CustomEvent（`pi-desktop:new-tab` / `close-tab` / `settings`），转成已有的 handler。不引 Tauri 的 JS API，浏览器里是纯 no-op |
| `components/ChatContextStats.tsx` | 输入框下方中间槽那一行：圆环 + 百分比 + 总 token + 缓存 + 花费 |
| `components/ContextUsageRing.tsx` | 从上游移植的圆环，加了 `decorative` 模式（避免 button 嵌套 button） |
| `design-prototypes/sessions-sidebar.html` | 左栏的设计稿（仅存档，无代码作用） |
| `app/api/attachments/route.ts` | `POST /api/attachments`：把**浏览器里**挑的非图片文件暂存到 `~/.pi/attachments/`，只回传绝对路径（原始字节不进模型上下文）。放在 `~/.pi/` 而不是会话工作区，否则会污染项目目录与 git 状态。app 里用不到（原生对话框直接给真实路径） |
| `app/api/attachments/inspect/route.ts` | `POST /api/attachments/inspect`：按**路径**识别桌面对话框选中的文件 —— 图片（看魔数，≤1 0MB）带回 base64 走图片通道，其余只回元数据 |
| `desktop/`（8 个文件） | macOS 外壳：Tauri 工程 + 启动页 + 说明，详见 `desktop/README.md`。`src/main.rs` 里还建了一份应用菜单，注册三个原生快捷键：**⌘T** 新建空白会话标签、**⌘W** 关闭当前标签、**⌘,** 打开设置。三者都只把命令 `eval` 成 CustomEvent 交给网页（见 `hooks/useDesktopMenuCommands.ts`）。菜单里**不能**再放「关闭窗口」（默认菜单那个 ⌘W 必须拿掉，否则两个 ⌘W 打架；现在 ⌘W 完全不碰窗口）；编辑菜单必须留着，否则输入框里的 ⌘C/⌘V/⌘A 会失效」。另外 `main.rs` 注册了 `on_new_window`，把指向自己服务的新窗口请求交给系统默认浏览器（否则网页里的 `window.open` / `target="_blank"` 会被 WebView 静默丢掉，点「完整历史」没反应）。还启用了官方 `tauri-plugin-dialog`（只为给 composer 的「附加文件」开原生文件选择窗口，权限在 `capabilities/default.json` 的 `dialog:allow-open`） |
| `scripts/package-desktop.mjs` | 打包脚本：组装运行时 → 裁剪 → `cargo tauri build` → 启动验证 |
| `reference/README.md` | 参考副本的说明（副本本身被 `.gitignore` 排除） |

---

## 三、修改文件（每个只需改对应那几处）

| 文件 | 改动量 | 改了什么 |
| --- | --- | --- |
| `components/SessionSidebar.tsx` | +285 / −250 | ① 会话/文件切成一个切换器（复用既有 `explorerOpen`，没加 state）② 新建会话满宽按钮 ③ 常驻搜索框（原来是点图标才展开）④ 项目分区标题 ⑤ 会话项的悬停按钮收进 ⋯ 菜单 ⑥ 标题超长才渐隐（`useOverflowingText` 实测 `scrollWidth`）⑦ 顶栏行（设置齿轮 + 收起侧栏） |
| `components/TabBar.tsx` | +1 | 只加了一个 `className="file-tabs"`（铁律 2 里「加 className」那一半）。右栏文件标签条外面由 `components/FileTabStrip.tsx` 包一层，原生滚动条由 `native-theme.css` 的 `.file-tabs` 隐掉；上游那个 inline 的 `overflow-x: auto` **没动**，仍然是滚动视口本身 |
| `components/AppShell.tsx` | +574 / −204 | ① 三柱布局与顶栏那一行 ② **顶栏左端是会话标签条**（取代上游的扩展状态行），见下 ③ ⋯ 菜单（复用上游 `renderChatToolbarActions`）④ 信息面板只在中间弹出（几何按中间列矩形算）+ 全宽展开时为红绿灯留位 ⑤ 脚本侧栏开关只在收起后出现 ⑥ 收起时让开红绿灯宽度 ⑦ 设置入口改为左栏齿轮 |
| `components/ChatWindow.tsx` | +52 / −123 | ① 删掉空会话头部的品牌行（logo + Pi Web + 版本号）② 消息列表加 `.chat-scroll-area`（常显滚动条）③ 删掉地图的引用（`ChatMinimap` / `useMessageRefs` 整个拿掉，所以上游 #941 给进程分组新加的 `ref` 也一并去掉，只留它的 `key`）④ 扩展弹窗标题区：fork 当初改成「可收缩 + 40vh」，合并上游时发现 #961 修的是同一个 bug（百分比 max-height 在内容撑开的容器里按规范等于 `none`），已改用上游的 `flexShrink: 1 + 50vh`，fork 那份退休 ⑤ 内联 `phaseLabel` 随上游抽到 `lib/chat-phase-label.ts`（多了 `isCompacting` 参数） |
| `components/ExtensionStatusBar.tsx` | +26 / −15 | 抽出 `ExtensionStatusLine` 单独导出（仍只有一份实现）。**fork 起初把它放在中栏顶栏，现在那里改成了会话标签条，所以 `ExtensionStatusLine` 在 app 里已不再被渲染** —— 组件与 `ChatWindow` 上报 `extensionStatuses` 的那条链都留着，要重新露出（例如收进 ⋯ 菜单）不必复现数据流 |
| `components/ChatInput.tsx` | +160 / −20 | ① 控制条中间槽从空 spacer 变成真居中槽（`contextSlot`）② 去掉为地图留的 `paddingRight: 52` ③ **「附加图片」改成「附加文件」**：app 里回形针开**原生**文件选择窗口（真实路径），图片直接走原通道、其余一律只写 `@原路径`（不拷贝、不限大小）；浏览器里回落 `<input type=file>`，非图片先拷一份再 `@副本路径`。附件卡片、错误条、草稿里的 `files`、失败恢复都在这一个文件里（细节见第六节） |
| `components/BranchNavigator.tsx` | +10 / −2 | ① 图标配色跟「是否展开」而不是「是否有内容」② 下拉高度上限 `min(520px, 可视剩余空间)` |
| `components/MessageView.tsx` | +6 / −0 | 只有 2 条 `SAFETY:` 注释（说明 `ImageContent` 与 pi-ai 旧扁平 shape 的兼容读法）。早先删掉的流式 token 统计已按需恢复，所以净改动只剩注释 |
| `lib/draft-store.ts` | +25 / −6 | 草稿多一个可选的 `files`（非图片附件）。**为空时不写这个键** —— 上游测试会对整个草稿对象 `deepEqual`，多一个 `files: []` 就红了 |
| `lib/i18n/messages/{zh-CN,en,zh-TW}.ts` | +33 / −2 | 新增 17 个 key（`sidebar.viewSessions` `viewFiles` `newSession` `projects` `moreActions`、`session.cacheHitShort`、`chat.ctxUsage`、3 个 `sessionTab.*`、2 个 `tabStrip.*` 两条标签条共用的滚动按钮文案、5 个 `chat.attach*` / `chat.attachment*` 附加文件文案）；删掉 2 个地图 key |
| `app/layout.tsx` | +3 | 引入 `native-theme.css` |
| `.gitignore` / `eslint.config.mjs` / `AGENTS.md` | 小 | 忽略规则（含打包产物）、lint 忽略 `desktop/src-tauri/{runtime,target,gen,icons}`、文档 |
| 11 个 `*.test.mjs` | +231 / −124 | 断言随 UI 结构更新（其中 `AppShell.workspace-memory.test.mjs` 占大头）；另有两个 fork 自己的测试文件 `lib/file-attachments.test.mjs`、`lib/attachment-staging.test.mjs` |

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
5. `desktop/` + `scripts/` 一般不用动，只确认四件事：
   - `bin/pi-web.js` 的 CLI（`-p` / `--no-open`）与 `.next` 的目录约定没变；
   - `tauri.conf.json` 的 `productName`、`bundle.resources: ["runtime/"]` 仍在；
   - `main.rs` 里对 `runtime/app/...` 的路径假设仍成立；
   - `.on_new_window(...)` 仍在（没了的话，网页里的新窗口请求会被 WebView 静默丢弃）。
6. **跑门禁**：`npx tsc --noEmit` → 0、`npx eslint .` → 0、`npm test`（1393 项）。
   注意 macOS 上要先 `TMPDIR=/private/tmp/pi-test-tmp npm test`（原因见 AGENTS.md 的 Quick Start）。
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
  **上游 #961 已自己修好**（`flexShrink: 1` + `50vh`），fork 那份 40vh 已退休、跟随上游。
  附带一条踩坑：往这段代码附近写注释时，别把 `maxHeight: "50%"` 原样写进去 ——
  上游那条 `assert.doesNotMatch(header, /maxHeight: "50%"/)` 会把注释也算进去。
- **红绿灯位置在 `desktop/src-tauri/src/main.rs`**，`traffic_light_position` 的第二个参数
  **不是「距顶部的距离」**：AppKit 左下原点、tao 只改按钮的 X，所以该值使按钮整体下移，
  斜率正好 1。当前标定与历史写在代码注释里。
- **打包脚本的四道闸别删**：① 组装运行时不会被别的开关顺带跳过（只能用 `--reuse-runtime` 显式要求）；
  ② 运行时的 `.next/BUILD_ID` 必须与仓库一致；③ **node 必须按「复制到 `runtime/bin/` 之后
  仍能跑」验收**（homebrew 的 node 26+ 是共享库构建，原地跑得好好的，单独复制就 dyld 缺库，
  包能打出来但 app 永远停在启动页）；④ **运行时的 `next.config.ts` 必须在，且带着
  `proxyClientMaxBodySize`**。第④条是「附加文件」踩出来的：这个文件以前只在构建时被读到，
  组装漏拷也没人发现 —— 直到 app 里传一个大于 10MB 的文件。Next 的代理层默认把请求体
  截在 10MB，截断后 multipart 解析失败，前端只会看到一句 `HTTP 500`（服务端日志里是
  `expected boundary after body`）。它同时也是 `headers()` 的来源（`/` 的 no-cache、
  `/sw.js` 的 `Service-Worker-Allowed`），漏了就一并丢了。
- **改 `productName` 后 `cargo tauri build` 不会删旧包**，`bundle/macos` 下会新旧并存；
  按名字挑产物的地方（含脚本的验证步）可能挑到旧的，脚本现在会自动清掉。
- **WebView 不会自己开新窗口。** WKWebView 通过 `createWebViewWith` 问宿主，而 wry 只在应用
  注册了 `WebviewWindowBuilder::on_new_window` 时才回答，没注册就直接 `else { None }` ——
  网页里的 `window.open` / `<a target="_blank">` 因此会被**静默丢掉**（点「完整历史」在 app 里
  没反应、在浏览器里正常，就是这个原因）。`main.rs` 现在注册 `new_window_to_browser(port)`：
  只把指向自己服务（`127.0.0.1`/`localhost` + 自己的端口）的请求交给 `/usr/bin/open`
  （系统默认浏览器），再用 `NewWindowResponse::Deny` 收尾。网页侧一行没改，
  所以在普通浏览器里仍然是开自己的标签页。
- **pi 的附件通道只有图片。** `AgentSession.prompt(text, images)` 只收 `ImageContent{type:"image",data,mimeType}`
  （官方 CHANGELOG 里写了 `attachments` 字段被 `images` 取代），所以非图片文件只能写成 `@路径`（见下一条）。
  而且各家 provider 对非图片 `mimeType` 的态度完全不同：Google 的 `inlineData` 任意 mimeType 都收；
  Anthropic 只认图片（PDF 要 `document` 块，pi 不发）；OpenAI 官方会拒 —— 所以别把
  「把 PDF 塞进 images 数组」当成能用。
- **「附加文件」只有两条规则，保持一致：图片走上传通道，其它一切（含小文本）只写 `@路径`。**
  曾经还有过一条“小文本注入正文（`<file>` 块）”的路，已删 —— 与用户要求不一致，也少一套分支。
- **要“不拷贝、不限大小”就只能拿真实路径，而真实路径只能来自原生对话框。**
  WebView 里的 `<input type=file>` / `dataTransfer.files` 都**不**暴露路径，所以浏览器里只能把字节
  拷一份到 `~/.pi/attachments/`（`local`，有暂存上限）；app 里走 `plugin:dialog|open` 拿真路径
  （`link`，一个字节都不过网，**没有任何大小检查**）。两条路在 `ChatDraftFile.kind` 上分开。
- **`capabilities/default.json` 里的 `dialog:allow-open` 不能删。** 路径走的是
  `window.__TAURI_INTERNALS__.invoke("plugin:dialog|open")` —— 没这个权限就报权限错，而不是回落。
  另外 `lib/desktop-file-picker.ts` 在普通浏览器里是纯 no-op（没有 `__TAURI_INTERNALS__`），
  所以同一个页面在 localhost 里也能跑，只是回落成 `<input type=file>` + 暂存。
- **`runBuiltinCommand` 里不能加 `attachedFiles`。** 上游那个测试（“locks built-in command submission
  until it settles”）会把这段回调的源码抽出来丢进一个固定 vm 上下文里跑，拿不到的变量会直接抛。
  fork 的附件拦截放在两个调用点（`handleSend` / `sendQueued`），回调本身保持上游原样。
- **发送失败后的恢复靠一个 ref，不动 `hooks/useAgentSession.ts`。** 上游的 `restoreSubmission`
  只带 `text` + `images`，而 fork 的附件和「用户原始输入」都只存在 `lastSubmittedFilesRef` 里
  （按实际发出去的正文匹配）。这样 `useAgentSession.ts` 保持对上游 0 差异，否则每次合上游都要再碰一次。
  附带一个副作用：失败恢复时输入框里是**用户原文**，不是注入了 `<file>` 块的那份正文。
- **暂存目录是 `~/.pi/attachments/`，不会自动清理。** 拖过的文件会一直留着（名字带时间戳前缀，
  方便辨认和手动删），没做定期删除 —— 删用户文件这种事不能默默干。

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
TMPDIR=/private/tmp/pi-test-tmp npm test   # macOS：默认 TMPDIR 是软链，有两条上游测试会误报

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

## 八、和上游保持一致的几个取舍点

这几处是**有意偏离上游**的，移植时不要「顺手改回去」：

1. **左栏同一时间只显示会话或文件**（上游是上下分栏 + 可拖把手）。
   代价是失去同时可见；换来的是每栏都能占满高度。
2. **对话地图整条移除**（上游有）。它的滚动定位能力现在由右边缘的常显滚动条承担。
3. **四主题里只重绘了 light / dark**；`mist` / `rose` / `pine` 保留各自的调色板，
   只从 `:root` 拿结构令牌（圆角、行高、字号）。`native-theme.css` 里的选择器写成
   `html.dark[data-theme="dark"]` 就是为了不去覆盖那三套。
4. **中栏顶栏左端是会话标签条**（上游那里是扩展状态行，没有标签概念）。
   几条移植时容易改错的行为：
   - **全应用最多一个空白草稿标签**（`sessionId === null` 的那个），`+` 只会复用 / 聚焦它，
     不会叠出第二个。存储层也会把多草稿的旧数据折叠成一个（`parseSessionTabs`）。
   - **空白标签不会被别处悄悄收掉**：`openSessionTab` 一律另开 / 跳转，从不占用或关闭空白标签；
     空白页只由用户点 ✕ 关掉。
   - **标签外观与右栏文件标签（`components/TabBar.tsx`）同一套**：整高标签、固定 180px 宽、
     非活动 `--bg-panel` / 活动 `--bg`、左 12 右 6 的内边距、悬停才显形的 24×24 关闭按钮
     （位置一直占着，所以宽度不跳）。会话标签条必须 `align-self: stretch` 才能拉满顶栏高度 ——
     顶栏是 `align-items: center`，不拉满时整条只有约 20px 高，活动标签的白底会缩在文字周围，
     看起来是「灰底嵌白底」。两端滚动箭头朝标签那一侧都有一条 1px 竖线；右边那个的 `border-left`
     是必需的，因为列表右端那个标签是被裁掉的，自己那条右边框不在可见范围内。箭头**划到
     自己那端就卸载**（不是 `visibility: hidden`），所以到头不会空出一段位置。
   - **反过来，箭头显隐会改变列表宽度**（卸载 = 多出 26px）。而「该不该显箭头」正是由滚动位置
     算出来的，所以**不能在整条列表 resize 时去滚回活动标签**，否则自激：滚轮到右端 → 箭头卸载 →
     列表变宽 → 又拽回活动标签 → 永远划不到头；同时也会打断箭头按钮自己的平滑滚动（只挪十几
     像素就停）。reveal 只跟「活动标签变了 / 标签增删」和**标签自身**尺寸变化走（observer 回调里
     的 `entry.target !== el` 过滤）。
   - **全宽展开的右栏要给红绿灯留位**：`right-panel-full-width` 是 `position: fixed; inset: 0`，
     它的头部就是窗口左上角，和中栏顶栏一样需要 `paddingLeft: TRAFFIC_LIGHTS_WIDTH`。
   - **草稿按标签隔离**：草稿键是 `new:<标签id>:<cwd>`，切走时停放到 `parked-new:<标签id>`
     （上游是按 cwd 停放一个）。上游 `useAgentSession` 卸载时会 `clearDraft(活动键)`，
     所以**切标签前必须先停放**，否则用户没发出去的正文会没。
   - **标签列表要同时写 state 和 ref**（`applyTabsState`）：同一个事件里会连着走几个 handler
     （关标签 → 打开右邻居），只写 state 的话第二个 handler 读到的是关之前的列表，会把刚关掉的标签加回来。
   - **链接里带 `?cwd=` / `?session=` 时 URL 优先**，但标签条必须补上一个和中间内容对得上的标签，
     否则恢复出来的列表里会有一个「看着是活动标签、点下去却没反应」的死标签。
