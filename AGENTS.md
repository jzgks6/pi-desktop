# Pi Web - Development Notes

> **This repo is a fork.** It reworks the UI into an IDE-style three-column layout with a
> browser-style session tab bar in the centre top bar, and adds a
> macOS desktop shell. `FORK.md` lists every change against upstream (`agegr/pi-web` @ `96966e5`)
> and how to port them onto a newer upstream. Two rules from it matter for any edit:
> `app/globals.css` / `app/settings.css` stay byte-identical to upstream (fork styles go in
> `app/native-theme.css`), and component edits add a `className` while deleting the inline
> style it replaces.

## Quick Start

```bash
npm run dev   # port 30141
```

Typecheck: `node_modules/.bin/tsc --noEmit`  
Lint: `npm run lint`  
Test: `npm test` — on macOS set `TMPDIR` to a **real** path outside the home directory first
(`TMPDIR=/private/tmp/pi-test-tmp npm test`). Two upstream tests are sensitive to the default
`/var/folders/...` value: it is a symlink to `/private/var/...`, so `lib/worktree.test.mjs`
sees Git report the resolved path and fails; putting `TMPDIR` inside `$HOME` instead trips
`lib/enabled-models-runtime.test.mjs`, which expects a temp path that is not home-relative.
**Never run `next build` during dev** — pollutes `.next/` and breaks `npm run dev`.

### Dev server troubleshooting

- First run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse a healthy Pi Web process. A second `next dev` on another port is no workaround: both contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph, not a broken server or source. Use the browser's explicit reload, then compare the server log and a direct HTTP/API request.
- Restart only when the failure reproduces from a fresh page and the server-side checks fail too: stop that exact dev process gracefully, move `.next` into a `mktemp -d` backup, restart with `npm run dev`.
- Never fall back to `next dev --webpack`: the dev graph can fail on `undici` imports such as `node:console`. Development uses Turbopack.
- `next dev` may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md`. It is tooling output: check `git status` and keep it out of unrelated commits.

---

## Architecture

- **Browsing** (read-only, no AgentSession): `GET /api/sessions` lists `~/.pi/agent/sessions/`; `GET /api/sessions/[id]` reads the `.jsonl` through SDK `SessionManager` helpers and `lib/session-reader.ts`, or an open wrapper's in-memory `SessionManager`. `GET /api/agent/running` snapshots the running ids.
- **Sending**: `POST /api/agent/[id]` → `startRpcSession()` (`lib/rpc-manager.ts`) creates the AgentSession in-process (`createAgentSessionFromServices()`); `session.send(cmd)` → `session.prompt()`.
- **Events**: `GET /api/agent/[id]/events` streams SSE `data: {...}` from `session.onEvent()`, fed by `session.subscribe()`.

---

## File Map

```
app/api/
  sessions/route.ts                GET list all sessions
  sessions/[id]/route.ts           GET/PATCH/DELETE a session
  sessions/[id]/context/route.ts   GET ?leafId=&tail=&before= a page of a leaf's context (tail defaults to 50; before pages upward)
  sessions/[id]/export/route.ts    GET exported HTML
  sessions/[id]/state/route.ts     GET live wrapper state while running
  sessions/[id]/auto-name/route.ts POST generate a session title
  sessions/search/route.ts         GET session search
  agent/new/route.ts               POST { cwd, type: prompt|ensure_session (start only), message?, toolNames?, provider?, modelId?, thinkingLevel? }
  agent/[id]/route.ts              GET state | POST any command
  agent/[id]/events/route.ts       GET SSE stream
  agent/running/route.ts           GET running session ids
  auth/api-key/[provider]/route.ts POST/DELETE stored provider API key
  auth/login/[provider]/route.ts   GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts  POST OAuth logout
  auth/providers/route.ts          GET OAuth and API-key provider lists
  cwd/validate/route.ts            POST validate/select a cwd
  cwd/browse/route.ts              GET browse any readable directory for the cwd picker | POST create child directory
  default-cwd/route.ts             POST create ~/pi-cwd/YYYYMMDD (local date)
  home/route.ts                    GET user home directory
  open-in-explorer/route.ts        GET availability | POST open a cwd in the OS file manager (loopback only)
  files/[...path]/route.ts         GET ?type=list|read|download|meta|preview|watch | POST ?type=upload|upload-check|allow-link
  file-index/route.ts              GET file list for @-mentions
  git/status/route.ts              GET changed files for a cwd
  git/diff/route.ts                GET diff of one changed file
  worktrees/route.ts               GET/POST/DELETE git worktrees
  terminal/route.ts                POST create a terminal session
  terminal/[id]/route.ts           GET { id, cwd } (404 once closed; stream at [id]/events) | POST input/resize | DELETE kill
  mcp/route.ts                     GET [?cwd=] Settings › MCP overview, files only | POST add/enable/disable/remove/undo/set-enabled/set-exposure/sign-out
  mcp/test/route.ts                POST { scope, name, cwd? } test one server once (entry read from its file)
  mcp/sign-in/route.ts             POST { scope, name, cwd? } start or join an OAuth sign-in
  mcp/sign-in/[flowId]/route.ts    GET flow state (polled) | POST { redirectUrl } | DELETE cancel
  project-trust/route.ts           GET trust status + project .pi/mcp.json servers (files only) | POST trust, rebuild the cwd's wrappers
  tools/settings/route.ts          GET/PUT defaultTools switches: PowerShell (Windows), Code mode automatic/always; codemode.mode, codemode.inlineBudget
  models/route.ts                  GET ?cwd= { models, modelList, defaultModel, … }
  models/enabled/route.ts          GET/PUT enabledModels switches
  models/default/route.ts          PUT default model / reasoning level for new sessions
  models/refresh/route.ts          POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts           GET/PUT ~/.pi/agent/models.json
  models-config/catalog/route.ts   GET models.dev pricing presets
  models-config/discover/route.ts  POST fetch a configured provider's upstream model list
  models-config/test/route.ts      POST test a configured model/provider
  plugins/route.ts                 GET/POST package plugin management
  plugins/check/route.ts           POST check plugin package updates
  skills/route.ts                  GET/PATCH loaded skills, disable-model-invocation
  skills/install/route.ts          POST install skills via npx skills add
  skills/search/route.ts           POST skills.sh search
  subagents/settings/route.ts      GET/PUT built-in subagent switch and maxConcurrent
  web-auth/route.ts                GET status | POST login | DELETE logout (browser password)
  provider-usage/query/route.ts    POST provider usage quotas
  push/config/route.ts             GET VAPID public key
  push/subscribe/route.ts          POST register a push subscription
  app-update/route.ts              GET current vs latest published pi-web version
  attachments/route.ts             (fork) POST stage browser-picked non-image files into ~/.pi/attachments/
  attachments/inspect/route.ts     (fork) POST inspect native-picker paths: images come back as base64, everything else as metadata only

lib/
  agent-client.ts           typed fetch helper for /api/agent commands
  rpc-manager.ts            AgentSessionWrapper, registry, startRpcSession
  session-reader.ts         SessionManager wrappers, path cache, buildSessionContext adapter
  normalize.ts              normalizeToolCalls(): file-format vs our toolCall field names
  types.ts                  shared TypeScript types
  pi-types.ts               local structural types for pi SDK objects
  pi-sdk-internals.ts       loader for SDK modules the package does not export (MCP connection, config, OAuth)
  tool-presets.ts           PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts browser-persisted default preset for fresh sessions
  builtin-extensions.ts     codemode / tool-search / mcp built-ins, sandbox self-test, -builtin: switches
  codemode-settings.ts      Code mode automatic/always (+codemode in global defaultTools), codemode.mode and inlineBudget; project overrides
  codemode-view.ts          display helpers for codemode cards
  global-settings-file.ts   locked read-modify-write of global settings.json (SettingsManager's lock)
  regular-file.ts           readRegularFileText(): non-blocking read of a regular file only, optional size cap
  default-preferences.ts    write defaultModel/defaultThinkingLevel; detect project shadowing
  enabled-models.ts         pure minimal-edit engine for the enabledModels pattern list
  enabled-models-runtime.ts SDK adapter for enabledModels: pattern resolution, provider kinds, settings IO
  subagent-settings.ts      read/write ~/.pi/agent/agents/settings.json
  file-access.ts            allowed file roots for /api/files and worktrees
  linked-directory.ts       directory links leading outside the allowed roots + the allow-link check
  file-paths.ts             client/server path encoding helpers
  file-tree-visibility.ts   which entries the file tree lists (git check-ignore, name-list fallback)
  display-path.ts           display-only ~ / ./ path shortening for settings panels
  default-cwd.ts            dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  worktree.ts               project/worktree resolution and git worktree operations
  draft-store.ts            local draft persistence
  extension-ui-queue.ts     FIFO queues for extension dialogs and custom panels, by request id
  markdown.ts               shared markdown helpers
  gfm-autolink-email-loader.cjs  bundler loader: remark-gfm's email regex without a lookbehind literal
  node-cli.ts               locate bundled npm-cli.js / npx-cli.js to spawn npm/npx without a shell (Windows)
  npx.ts                    npx runner for skill install
  plugin-updates.ts         npm view update checks for /api/plugins/check
  jsonc.ts                  JSON with comments and trailing commas (models.json is read through it)
  shell-words.ts            split a pasted command line into words without a shell; refuses | && ; redirects $(…)
  key-serializer.ts         serializeByKey(): one globalThis promise chain per key
  stacked-dialog.ts         Escape and focus handling for Settings and dialogs stacked above it
  project-trust.ts          project trust status and decisions; fresh-folder trust-and-write
  mcp-host.ts               per-session MCP host: registers mcp.json servers before prompts, reports status
  mcp-transport.ts          MCP transport factory; stdio gets a sanitized env, never PI_WEB_PASSWORD
  mcp-command.ts            client-safe: who owns /mcp (built-in or another extension)
  mcp-read-only-policy.ts   read-only sessions block MCP tools without readOnlyHint (nested calls too)
  mcp-config-key.ts         canonicalJson() and mcpConfigKey(), the per-process HMAC statuses are keyed by
  mcp-config-values.ts      client-safe: the values pi resolves and the PI_WEB_PASSWORD rule
  mcp-config-read.ts        Settings › MCP reads of both mcp.json files; nothing resolved or run
  mcp-config-file.ts        the mcp.json writer: SDK editor's bytes, lock, atomic write, typed refusals
  mcp-json-error.ts         JSON.parse error messages that never quote the source
  mcp-undo.ts               removed mcp.json entries kept 60 s for undo; only a token reaches the browser
  mcp-status.ts             last known connection state per mcp.json entry (tests and sessions)
  mcp-test.ts               Settings › MCP Test: one bounded, masked SDK connection (sign-in reuses its steps)
  mcp-entry-request.ts      route checks before connecting one mcp.json entry (Test, sign-in); guards /api/mcp and /api/project-trust share
  mcp-sign-in.ts            Settings › MCP OAuth sign-in flows (as pi mcp login), polled by id
  mcp-sign-out.ts           OAuth store keys (name + URL); guard barring token writes by runs started before a sign-out
  mcp-secrets.ts            pure secret classification and masking for MCP config values
  mcp-add.ts                POST /api/mcp add's checks before it writes
  mcp-import.ts             pure paste importer (+ mcp-import-core/json/cli/links.ts)
  mcp-server-display.ts     client-safe display helpers for McpServerInfo (hidden-character escapes, labels)
  mcp-tool-display.ts       server/tool label of an mcp__ call from its result details, never the name
  session-tabs.ts           (fork) session tab list + localStorage: open/activate/close, per-tab draft keys, one blank draft tab
  context-stats.ts          (fork) context usage math: compactTokens, computeContextStats, contextStatsParts
  file-attachments.ts       (fork) attachment intake: image vs non-image classification, `@path` mentions, outgoing composition
  desktop-file-picker.ts    (fork) native file dialog through the Tauri IPC + image magic-byte sniffing (no-op in a browser)
  attachment-staging.ts     (fork) server-side staged-file naming for ~/.pi/attachments/ (browser fallback only)

components/
  AppShell.tsx             layout, URL state, tab management
  SessionSidebar.tsx       session tree + FileExplorer
  ChatWindow.tsx           chat composition + completion sound
  ChatInput.tsx            input bar + model/thinking/tools/compact controls
  MessageView.tsx          one message (user/assistant/toolCall/toolResult)
  CodemodeToolView.tsx     codemode card: the tool calls its script made
  BranchNavigator.tsx      in-session branch switcher
  MarkdownBody.tsx         markdown renderer
  ModelsConfig.tsx         Settings › Models: models.json editor
  EnabledModelsSection.tsx model switches inside ModelsConfig (enabledModels)
  OAuthPastePanel.tsx      paste box for a sign-in's redirected address or code (Models, MCP)
  ProjectTrustDialog.tsx   trust confirmation listing the project's MCP servers
  AgentsConfig.tsx         built-in subagent toggle + agent profile editor
  PluginsConfig.tsx        Settings › Plugins: installed package plugins
  SkillsConfig.tsx         Settings › Skills: loaded, search, install
  McpConfig.tsx            Settings › MCP: servers, switches, exposure, remove/undo, Test, sign-in, Code mode, trust
  mcp-config-helpers.ts    pure helpers and requests for McpConfig
  McpSignIn.tsx            a server's Sign-in row in Settings › MCP
  mcp-sign-in-helpers.ts   pure helpers and requests for McpSignIn
  McpAddServer.tsx         Settings › MCP add pane: paste, preview, values, name, scope
  mcp-add-helpers.ts       pure helpers and the add request for McpAddServer
  FileExplorer.tsx         file tree in the sidebar
  FileIcons.tsx            file icon helpers
  FileViewer.tsx           file content in a tab
  TabBar.tsx               file panel tab bar (file and terminal tabs)
  SessionTabBar.tsx        (fork) session tab strip in the centre top bar (horizontal scroll + drag-to-reorder)
  FileTabStrip.tsx         (fork) right panel's file tab strip (wraps TabBar, hides its native scrollbar, drag-to-reorder)
  ChatContextStats.tsx     (fork) context usage row under the composer (ring + total tokens + cache + cost)
  ContextUsageRing.tsx     (fork) ring from upstream, plus a decorative mode (avoids nested buttons)

hooks/
  useAgentSession.ts       messages, streaming, SSE, fork/navigate, reconciliation; built-in slash commands (/session, bare /mcp)
  useAudio.ts              completion sound + AudioContext unlock
  useDragDrop.ts           shared drag/drop state
  useIsMobile.ts           responsive breakpoint
  useKeyboardShortcuts.ts  Esc stops the running agent unless a field or nearer handler took it; Ctrl+Alt+N
  useTheme.ts              theme state
  useTabStripScroll.ts     (fork) tab strip scrolling: end arrows, wheel→horizontal, reveal the active tab
  useTabStripDrag.ts       (fork) drag-to-reorder a tab strip; shared by the session and file strips
  useDesktopMenuCommands.ts (fork) native menu events → tab/settings handlers (no-op in a browser)
```

## Attachments (fork)

The composer's paperclip has exactly two rules:

- **images** keep the upstream pipeline (client compression, 10 max, `ImageContent` blocks);
- **everything else** — PDF, docx, zip, and small text files too — is referenced in the message as a
  single `@/abs/path` line per file. The bytes never enter the model context; the model uses its own
  local tools (`read`, shell, extensions). There is no text-inlining path (removed on request).

Where the path comes from decides whether anything is copied:

- **desktop app** — the paperclip opens a **native** file dialog (`plugin:dialog|open` through
  `window.__TAURI_INTERNALS__`, see `lib/desktop-file-picker.ts` + `capabilities/default.json`'s
  `dialog:allow-open`). Real paths, `kind: "link"`, **no copy and no size check at all**; images are
  read back through `POST /api/attachments/inspect` (magic-byte sniff, ≤10MB) and handed to the same
  image pipeline as before.
  That capability needs **two** things the Tauri docs do not make obvious: the page is a *remote*
  origin, so it must be listed under `remote.urls` (a capability is local-only by default), and
  `remote.urls` is URLPattern where **the port is not wildcarded for you** — `http://127.0.0.1` does
  not match `http://127.0.0.1:30145`, it has to be `http://127.0.0.1:*`. Get either wrong and every
  invoke answers `Command plugin:dialog|open not allowed by ACL`.
- **plain browser** — a page cannot learn a picked file's path, so non-images are copied to
  `~/.pi/attachments/<timestamp>-<name>` by `POST /api/attachments` and referenced as `@那副本`
  (`kind: "local"`, bounded by `MAX_LOCAL_FILE_BYTES` = 100MB).

The message the model sees is `composeOutgoingMessage(typed, files)` — `@path` lines first, then the
user's text. A send failure restores the **typed** text plus the attachment chips from
`lastSubmittedFilesRef` in `ChatInput.tsx`; `hooks/useAgentSession.ts` stays byte-identical to
upstream, which is why the files ride a ref instead of its `restoreSubmission` signature. Staged files
are never cleaned up automatically.

Drag-and-drop inside the app still goes through the browser path (a copy) — Tauri *does* expose real
paths for drops via `tauri://drag-drop`, so routing them into the `link` path is a cheap follow-up if
wanted.

The message the model sees is `composeOutgoingMessage(typed, files)`: attachment blocks first, then
the typed text (matching `buildInitialMessage`). A send failure restores the **typed** text plus the
attachment chips from `lastSubmittedFilesRef` in `ChatInput.tsx`; `hooks/useAgentSession.ts` stays
byte-identical to upstream, which is why the files ride a ref instead of its `restoreSubmission`
signature. Staged files are never cleaned up automatically.

---

## Desktop app (macOS)

The repo is also the source of a standalone macOS app. Nothing in `app/`, `components/`
or `lib/` is desktop-specific — the shell launches the same Next server and points a
webview at it.

```text
desktop/
  dist/index.html            loading page shown until the server answers (Tauri frontendDist)
  src-tauri/
    src/main.rs              shell: pick port → spawn node → navigate → clean up
    tauri.conf.json          productName "pi desktop"; bundle.resources = runtime/
    Cargo.toml               tauri only (no shell plugin — std::process is enough)
    runtime/                 assembled at package time (gitignored, ~516M; **no pi inside**)
    target/ gen/ icons/      cargo output / generated (gitignored)
scripts/package-desktop.mjs  assemble runtime/ then run `cargo tauri build`
```

```bash
node scripts/package-desktop.mjs --verify       # build → assemble → bundle → launch check
node scripts/package-desktop.mjs --skip-build   # reuse the existing .next
```

Flags: `--skip-build`, `--reuse-runtime`, `--assemble-only`, `--skip-tauri`, `--verify`,
`--bundles=<app|dmg>`, `--force-icons`, `--debug`, plus `PI_DESKTOP_NODE=<path>` to pick
the node binary that gets bundled.

**The app does not ship pi (fork, plan A).** `scripts/package-desktop.mjs` deletes
`node_modules/@earendil-works` from the runtime — before `pruneDanglingLinks()`, otherwise
`node_modules/.bin/pi-ai` makes the Tauri bundle step fail with "resource path doesn't
exist". At launch `main.rs` finds the globally installed pi (scans fnm / nvm / pnpm / bun /
homebrew / usr-local global `node_modules`, then falls back to `/bin/zsh -lic 'npm root -g'`
with a timeout), symlinks it into
`~/Library/Application Support/pi-desktop/pi-runtime/node_modules`, and passes `NODE_PATH`
to the server — never into the bundle, which would invalidate the code signature. Two scopes
get linked: `@earendil-works` itself, and the nested one inside `pi-coding-agent` (since pi
1.0.0 that is where `pi-ai` / `pi-agent-core` / `pi-tui` live, and the server requires all
four names through `serverExternalPackages`). A missing pi shows a native dialog instead of
a blank window. ⌘R (查看 → 重启服务) re-resolves the global pi and restarts the server, so a
pi or extension upgrade takes effect without quitting the app.

⚠️ Never launch the packaged app (or its binary) while the user's own app is running:
`reclaim_preferred_port()` kills whatever holds port 30145 with `pi-web` in its command line
— that is their live server. Verify a build by starting the runtime's `bin/pi-web.js` by hand
with a hand-made link farm plus `NODE_PATH` instead.

Four guards, each added after a real failure:

* assembling the runtime is never skipped as a side effect of another flag — it is
  opt-in via `--reuse-runtime` (a stale runtime once shipped a component that had already
  been deleted from the source),
* the runtime's `.next/BUILD_ID` must equal the repo's, otherwise packaging aborts,
* `runtime/bin/node` is verified **after being copied** (a shared-library node builds happily
  in place and then cannot start from the bundle), and
* `runtime/app/next.config.ts` must exist and carry `proxyClientMaxBodySize` — Next reads that
  config at **runtime**, not just at build time, and without it the proxy truncates every request
  body at 10MB (large attachment uploads become a bare `HTTP 500`, and `headers()` is lost too).

**The webview cannot open new windows on its own.** WKWebView asks its host through
`createWebViewWith`, wry answers only when the app registered `WebviewWindowBuilder::on_new_window`,
and with no handler it ends in `else { None }` — so `window.open` and `<a target="_blank">` are
dropped silently. That is why the chat toolbar's “完整历史” (exported session HTML) did nothing in
the app while working fine in a browser. `main.rs` now registers `new_window_to_browser(port)`: it
opens same-origin requests (`127.0.0.1`/`localhost` + our own port) with `/usr/bin/open` and returns
`NewWindowResponse::Deny`. The page side is unchanged, so a plain browser still opens its own tab.

---

## Topic Notes

Design decisions and traps live in `docs/agents/`, one note per area. Read every note whose files a change touches before making it. Add new notes to the area's file, not here.

- [sessions.md](docs/agents/sessions.md): AgentSession lifecycle and shutdown, fork vs in-session branching, session file rewrites, toolCall normalization, SSE reconnect and tool events, transcript system / usage / context-edit entries, running-state polling, exported HTML. Files: `lib/rpc-manager.ts`, `lib/session-reader.ts`, `lib/normalize.ts`, `hooks/useAgentSession.ts`, `app/api/agent/**`, `app/api/sessions/**`, `components/BranchNavigator.tsx`, `components/MessageView.tsx`, `components/CodemodeToolView.tsx`.
- [tools.md](docs/agents/tools.md): tool presets and Chat only, exact system prompts, tool exposure, the codemode / tool-search / mcp built-ins, the read-only MCP policy, the Code mode and PowerShell `defaultTools` switches. Files: `lib/tool-presets.ts`, `lib/tool-preset-preference.ts`, `lib/chat-only.ts`, `lib/exact-system-prompt.ts`, `lib/builtin-extensions.ts`, `lib/mcp-read-only-policy.ts`, `lib/codemode-settings.ts`, `lib/powershell-settings.ts`, `lib/global-settings-file.ts`, `app/api/agent/new/route.ts`, `app/api/tools/settings/route.ts`, tool selection in `lib/rpc-manager.ts`.
- [mcp-runtime.md](docs/agents/mcp-runtime.md): the per-session MCP host (when servers register and connect, reported states, trust read on every sync, idle release); `/mcp` in the composer. Files: `lib/mcp-host.ts`, `lib/mcp-transport.ts`, `lib/mcp-status.ts`, `lib/mcp-command.ts`, `lib/mcp-config-key.ts`, MCP wiring in `lib/rpc-manager.ts` and `lib/builtin-extensions.ts`, `/mcp` handling in `hooks/useAgentSession.ts`.
- [mcp-settings.md](docs/agents/mcp-settings.md): Settings › MCP reads without running anything, masking, the trust dialog's server list, row states, notices, Code mode choice, trust from Settings, Escape stacking, every `mcp.json` write and undo. Files: `app/api/mcp/route.ts`, `app/api/project-trust/route.ts`, `lib/mcp-config-read.ts`, `lib/mcp-config-file.ts`, `lib/mcp-undo.ts`, `lib/mcp-secrets.ts`, `lib/mcp-server-display.ts`, `lib/mcp-json-error.ts`, `lib/project-trust.ts`, `lib/regular-file.ts`, `lib/stacked-dialog.ts`, `lib/settings-navigation.ts`, `components/McpConfig.tsx`, `components/mcp-config-helpers.ts`, `components/ProjectTrustDialog.tsx`, `components/SettingsPanel.tsx`.
- [mcp-test-sign-in.md](docs/agents/mcp-test-sign-in.md): Settings › MCP Test (route checks, bounded connection, `!command` queue, redaction, status store) and OAuth sign-in / sign-out. Files: `app/api/mcp/test/**`, `app/api/mcp/sign-in/**`, `lib/mcp-test.ts`, `lib/mcp-entry-request.ts`, `lib/mcp-status.ts`, `lib/mcp-sign-in.ts`, `lib/mcp-sign-out.ts`, `components/McpSignIn.tsx`, `components/mcp-sign-in-helpers.ts`, `components/OAuthPastePanel.tsx`.
- [mcp-add.md](docs/agents/mcp-add.md): Settings › MCP add (paste re-parsed on the server, host-variable confirmation, literal secrets kept global, fresh-folder trust, the add pane) and the paste importer's escaping and grammars. Files: `lib/mcp-add.ts`, `lib/mcp-import*.ts`, `lib/shell-words.ts`, fresh-folder trust in `lib/project-trust.ts`, `components/McpAddServer.tsx`, `components/mcp-add-helpers.ts`, the `add` action of `app/api/mcp/route.ts`.
- [models.md](docs/agents/models.md): default model and reasoning level, mid-run reasoning changes, remote provider catalogs, `enabledModels` scoping and minimal edits, provider auth listing and credentials. Files: `app/api/models/**`, `app/api/models-config/**`, `app/api/auth/**`, `lib/default-preferences.ts`, `lib/model-scope.ts`, `lib/enabled-models*.ts`, `lib/model-catalog-refresh.ts`, `lib/provider-listing*.ts`, `components/ModelsConfig.tsx`, `components/EnabledModelsSection.tsx`, `components/ModelSelector.tsx`, `components/SelectorRow.tsx`.
- [files-and-access.md](docs/agents/files-and-access.md): worktrees and project grouping, the file access allow-list (the `/api/files` security boundary), file tree visibility, web password throttling. Files: `app/api/files/**`, `app/api/cwd/**`, `app/api/worktrees/**`, `app/api/file-index/**`, `app/api/web-auth/**`, `proxy.ts`, `lib/path-security.ts`, `lib/file-access.ts`, `lib/linked-directory.ts`, `lib/session-file-references*.ts`, `lib/file-tree-visibility.ts`, `lib/worktree.ts`, `lib/paths.ts`, `lib/auth-throttle.ts`, `components/FileExplorer.tsx`.
- [settings-ui.md](docs/agents/settings-ui.md): Plugins and Skills routes, sidebar group switches, the shared `SettingsUi` blocks every settings panel and add pane uses. Files: `app/api/plugins/**`, `app/api/skills/**`, `components/SettingsUi.tsx`, `components/settings-ui-helpers.ts`, `components/SkillsConfig.tsx`, `components/PluginsConfig.tsx`; also before adding a settings section or add pane.
- [subagents.md](docs/agents/subagents.md): the built-in subagent setting, profiles and their files, run status, completion notifications. Files: `lib/subagent*.ts`, `app/api/subagents/**`, `components/AgentsConfig.tsx`.
- [client-platform.md](docs/agents/client-platform.md): mobile software keyboard and viewport height, completion sound. Files: `hooks/useViewportHeight.ts`, `hooks/useAudio.ts`, the keyboard-open CSS.

---

## Old Safari (iOS 16.2)

- `/` renders entirely on the client, so one script chunk the browser cannot parse is a blank page. Next 16 targets Safari 16.4+; the `browserslist` in `package.json` lowers Safari and iOS to 16.2 so SWC turns class `static {}` blocks into private static fields. That covers Next's client runtime; other node_modules keep their syntax unless listed in `transpilePackages` (mermaid and `@mermaid-js/parser` are, for their lazy diagram chunks). Keep the other browserslist entries at Next's defaults.
- Never write a RegExp lookbehind (`(?<=`, `(?<!`) in client code: SWC cannot downlevel it and Safari parses it only from 16.4. `lib/markdown.ts` emulates its leading lookbehinds with `replaceNotPrecededBy()`. A lookbehind built at runtime (`new RegExp("(?<=…)")` in `try`) fails only when run; that is how `lib/gfm-autolink-email-loader.cjs` fixes `mdast-util-gfm-autolink-literal`'s email regex. The loader is registered for webpack and Turbopack in `next.config.ts` and fails the build if that regex changes upstream.

## Pi Session File Format

Location: `~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`

```jsonl
{"type":"session","version":3,"id":"<uuid>","timestamp":"...","cwd":"/path","parentSession":"/abs/path/to/parent.jsonl"}
{"type":"model_change","id":"<8hex>","parentId":null,"provider":"zenmux","modelId":"claude-sonnet-4-6","timestamp":"..."}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"user","content":"..."}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"assistant","content":[...],...}}
{"type":"message","id":"<8hex>","parentId":"<8hex>","message":{"role":"toolResult","toolCallId":"...","content":[...]}}
{"type":"compaction","id":"<8hex>","parentId":"<8hex>","summary":"...","firstKeptEntryId":"<8hex>","tokensBefore":N}
{"type":"session_info","id":"...","parentId":"...","name":"user-defined name"}
```

`SessionContext.entryIds[]` parallels `messages[]`: each displayed message's `.jsonl` entry id, used for fork and navigate_tree.

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```
