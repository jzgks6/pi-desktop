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

- Before starting a server, run `lsof -nP -iTCP:30141 -sTCP:LISTEN` and reuse the existing Pi Web process when it is healthy. A second `next dev` for the same checkout cannot use a different port as a workaround because both processes contend for `.next/dev/lock`.
- A browser-only `Module ... factory is not available` overlay usually means that tab has a stale Turbopack/HMR graph; it does not prove the server or source is broken. First call the browser's explicit reload action, then compare the current server log and a direct HTTP/API request.
- Restart only after the failure reproduces from a fresh page and the server-side checks also fail. Stop the exact dev process gracefully, move `.next` into a `mktemp -d` backup, and restart with the standard `npm run dev` command.
- Do not use `next dev --webpack` as a fallback. This repository's development graph can fail on `undici` imports such as `node:console`; development is expected to use Turbopack.
- Next.js may append a generated `BEGIN:nextjs-agent-rules` block to `AGENTS.md` when `next dev` starts. Treat that as generated tooling output, verify it with `git status`, and do not include it in an unrelated feature commit.

---

## Architecture

```
Browser                Next.js Server              AgentSession (in-process)
  │                        │                               │
  ├─ GET /api/sessions ────▶ reads ~/.pi/agent/sessions/   │
  ├─ GET /api/sessions/[id] reads .jsonl file directly     │
  ├─ GET /api/agent/running ───────▶ running id snapshot   │
  │                        │                               │
  ├─ send message ─────────▶ POST /api/agent/[id]          │
  │                        │   startRpcSession() ─────────▶│ createAgentSession()
  │                        │   session.send(cmd) ─────────▶│ session.prompt()
  │                        │                               │
  ├─ SSE connect ──────────▶ GET /api/agent/[id]/events    │
  │                        │   session.onEvent() ◀─────────│ session.subscribe()
  │◀── data: {...} ─────────│                               │
```

**Session browsing** (read-only): reads `.jsonl` files through SDK `SessionManager` helpers and `lib/session-reader.ts` — no AgentSession created.  
**Sending a message**: `startRpcSession()` in `lib/rpc-manager.ts` creates an AgentSession in-process.

---

## File Map

```
app/api/
  sessions/route.ts               GET  list all sessions
  sessions/[id]/route.ts          GET/PATCH/DELETE session
  sessions/[id]/context/route.ts  GET ?leafId= — context for a specific leaf
  sessions/[id]/export/route.ts   GET exported HTML for a session
  agent/new/route.ts              POST { cwd, message, toolNames?, provider?, modelId? }
  agent/[id]/route.ts             GET state | POST any command
  agent/[id]/events/route.ts      GET SSE stream
  agent/running/route.ts          GET currently-running session ids
  auth/api-key/[provider]/route.ts POST/DELETE provider API key storage
  auth/login/[provider]/route.ts  GET OAuth/device-code SSE | POST manual code
  auth/logout/[provider]/route.ts POST OAuth logout
  auth/providers/route.ts         GET OAuth and API-key provider lists
  cwd/validate/route.ts           POST validate/select a cwd
  default-cwd/route.ts            POST create ~/pi-cwd/YYYYMMDD (local date)
  files/[...path]/route.ts        GET file contents for viewer
  home/route.ts                   GET user home directory
  models/route.ts                 GET { models, modelList, defaultModel }
  models/enabled/route.ts         GET/PUT enabledModels switches for the Models panel
  models/default/route.ts         PUT save the default model / reasoning level for new sessions
  models/refresh/route.ts         POST fetch provider catalogs from pi.dev on demand
  models-config/route.ts          GET/PUT — read/write ~/.pi/agent/models.json
  models-config/catalog/route.ts  GET models.dev pricing presets
  models-config/discover/route.ts POST fetch a configured provider's upstream model list
  models-config/test/route.ts     POST test a configured model/provider
  plugins/route.ts                GET/POST package plugin management
  skills/route.ts                 GET/PATCH loaded skills and disable-model-invocation
  skills/install/route.ts         POST install skills through npx skills add
  skills/search/route.ts          GET/POST skills.sh search
  subagents/settings/route.ts     GET/PUT built-in subagent feature setting
  worktrees/route.ts              GET/POST/DELETE git worktrees
  open-in-explorer/route.ts       GET availability | POST reveal a cwd in Finder/Explorer
  web-auth/route.ts               GET status | POST login | DELETE logout (browser password)
  plugins/check/route.ts          POST check plugin package updates
  project-trust/route.ts          GET/POST project trust for package installs
  sessions/search/route.ts        GET session search
  sessions/[id]/state/route.ts    GET live wrapper state when the session is running
  sessions/[id]/auto-name/route.ts POST generate a session title
  terminal/route.ts               POST create a terminal session
  terminal/[id]/route.ts          GET stream | POST input/resize | DELETE kill
  cwd/browse/route.ts             GET browse allowed cwd directories
  app-update/route.ts             GET current vs latest published pi-web version
  file-index/route.ts             GET file list for @-mentions
  git/status/route.ts             GET changed files for a cwd
  git/diff/route.ts               GET diff for one changed file
  provider-usage/query/route.ts   POST provider usage quotas
  push/config/route.ts            GET VAPID public key for push subscriptions
  push/subscribe/route.ts         POST register a push subscription
  tools/settings/route.ts         GET/PUT shell tool settings (PowerShell on Windows)

lib/
  agent-client.ts      typed fetch helper for /api/agent commands
  default-preferences.ts  write defaultModel/defaultThinkingLevel; detect project-level shadowing
  draft-store.ts       local draft persistence helpers
  file-access.ts       allowed file roots for /api/files and worktrees
  default-cwd.ts       dated ~/pi-cwd/YYYYMMDD path for "Use default directory"
  file-paths.ts        client/server path encoding helpers
  enabled-models.ts    pure minimal-edit engine for the `enabledModels` pattern list
  enabled-models-runtime.ts  SDK adapter: per-pattern resolution, provider kinds, settings IO
  markdown.ts          shared markdown helpers
  node-cli.ts          locate bundled npm-cli.js / npx-cli.js so npm/npx spawn without a shell (Windows npm.cmd)
  npx.ts               npx runner used by skill install
  chat-phase-label.ts  phaseLabel(phase, t, compacting) — status text for the chat phase
  open-in-file-manager.ts  platform label + server-side reveal helper for /api/open-in-explorer
  plugin-updates.ts    npm view update checks for /api/plugins/check
  pi-types.ts          local structural types for pi SDK objects
  rpc-manager.ts      AgentSessionWrapper + registry + startRpcSession
  session-reader.ts   SessionManager wrappers + path cache + buildSessionContext adapter
  subagent-settings.ts  read/write ~/.pi/agent/agents/settings.json
  tool-presets.ts     PRESET_NONE/READ_ONLY/DEFAULT/FULL + getPresetFromTools()
  tool-preset-preference.ts  browser-persisted default for fresh sessions
  types.ts            shared TypeScript types
  normalize.ts        normalizeToolCalls() — field name mismatch between file format and our types
  worktree.ts         project/worktree resolution and git worktree operations

components/
  AppShell.tsx        layout + URL state + session-tab state + tab management
  SessionTabBar.tsx   session tab strip in the centre top bar (horizontal scroll + arrows)
  FileTabStrip.tsx    right panel's file tab strip (wraps upstream TabBar, hides its native scrollbar)
  SessionSidebar.tsx  session tree + FileExplorer
  ChatWindow.tsx      chat composition + completion sound wrapper
  ChatInput.tsx       input bar + model/thinking/tools/compact controls
  MessageView.tsx     renders one message (user/assistant/toolCall/toolResult)
  BranchNavigator.tsx in-session branch switcher
  MarkdownBody.tsx    markdown renderer
  DismissButton.tsx   small ✕ used to dismiss inline error rows
  ModelsConfig.tsx    modal for editing models.json (opened from sidebar bottom)
  models-config-helpers.ts  pure helpers behind ModelsConfig (field edits, provider rows)
  EnabledModelsSection.tsx  model switches inside ModelsConfig, backed by enabledModels
  AgentsConfig.tsx    built-in subagent toggle + agent profile editor
  PluginsConfig.tsx   modal for installed package plugins
  SkillsConfig.tsx    modal for loaded/search/installable skills
  FileExplorer.tsx    file tree inside sidebar
  FileIcons.tsx       file icon helpers
  FileViewer.tsx      file content in a tab
  TabBar.tsx          tab bar (Chat + open file tabs)

hooks/
  useAgentSession.ts  messages + streaming + SSE + fork/navigate/reconciliation logic
  useAudio.ts         completion sound + browser AudioContext unlock
  useDragDrop.ts      shared drag/drop state
  useIsMobile.ts      responsive breakpoint hook
  useTheme.ts         theme state
  useTabStripScroll.ts  (fork) tab strip scrolling: end arrows, wheel→horizontal, reveal active
  useTabStripDrag.ts    (fork) drag-to-reorder a tab strip; shared by the session and file strips
  useDesktopMenuCommands.ts  (fork) native menu events → tab/settings handlers
```

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
    runtime/                 assembled at package time (gitignored, ~670M)
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

Two guards, both added after real failures:

* assembling the runtime is never skipped as a side effect of another flag — it is
  opt-in via `--reuse-runtime` (a stale runtime once shipped a component that had already
  been deleted from the source), and
* the runtime's `.next/BUILD_ID` must equal the repo's, otherwise packaging aborts.

---

## Key Design Decisions & Traps

### AgentSession lifecycle (`lib/rpc-manager.ts`)
- One `AgentSessionWrapper` per session id, keyed in `globalThis.__piSessions`
- `globalThis` survives Next.js hot-reload; plain module-level Map does not
- Idle timeout: 10 minutes by default (`PI_WEB_IDLE_TIMEOUT_MS`, `0` disables). Concurrent `startRpcSession()` calls share a single start Promise (`globalThis.__piStartLocks`)

### Fork must destroy the wrapper immediately
`AgentSession.fork()` **mutates the wrapper's inner state in-place** — after fork, `inner.sessionId` is the *new* session's id. If the wrapper stays alive in the registry under the old id, the next request gets the already-forked state and subsequent forks produce a corrupt `parentSession` chain.

**Fix**: `send("fork")` captures `newSessionId`, then calls `this.destroy()` before returning. The next request for the original session reloads a clean AgentSession from the original file.

### Two kinds of branching — don't confuse them
- **Fork** ("New session" on user message): creates a new independent `.jsonl` file. Shown as a child in the sidebar tree via `parentSession` header field.
- **In-session branch** ("Edit from here" / BranchNavigator): calls `navigate_tree` within the same file. Multiple entries share the same `parentId`. Switching between them calls `/api/sessions/[id]/context?leafId=`.

### Session files can be fully rewritten
`parentSession` in the header is **display metadata only** — has zero effect on chat content. Safe to `writeFileSync` the entire file (pi does this itself during migrations). Used when cascade-reparenting children on delete.

### ToolCall field normalization
Pi stores toolCall blocks as `{type:"toolCall", id, name, arguments}` but `ToolCallContent` uses `{toolCallId, toolName, input}`. `normalizeToolCalls()` in `lib/normalize.ts` handles this — called in both `session-reader.ts` (file load) and `handleAgentEvent` in `hooks/useAgentSession.ts` (streaming).

### New session tool preset
Tool names are passed at session creation (`POST /api/agent/new` -> `toolNames[]`) and persisted in versioned `pi-web:tool-selection` custom entries. No entry means a legacy session and keeps Pi's default behavior; an empty array means Chat only. Chat only resolves before services are created, loads no extensions/skills/prompts/themes, and replaces Pi's base prompt with the ordered contents of Pi's discovered context files. Crossing the Chat-only boundary rebuilds the wrapper; changing between nonempty presets updates it in place.

**Exact system prompts go through `before_agent_start`.** Since pi 0.86 the prompt lives in the transcript: `agent.state.systemPrompt` is a getter replayed from persisted system messages (assigning it throws), and the agent loop's request context has no `systemPrompt` field, so neither mutating the state nor patching `prepareNextTurnWithContext` reaches the model. Chat-only sessions and subagent profiles in replace mode register `lib/exact-system-prompt.ts` as an inline extension factory on the resource loader; its `before_agent_start` handler returns `{ systemPrompt }`, which the SDK projects as the provider's leading system prompt for the whole run while the transcript keeps recording Pi's structured sections. `get_state.systemPrompt` reports the exact prompt for those wrappers because the SDK state only shows the structured sections. Subagents persist their active tools plus profile-level skill and extension loading switches in `resourceSnapshot`; loaded extensions cannot expose the reserved `Agent`, `get_subagent_result`, or `steer_subagent` tools to a subagent. See `docs/adr/0002-chat-only-tool-selection.md`.

The last preset explicitly selected by the user is stored in browser `localStorage` and initializes fresh-session composers only. Existing sessions never trust that preference; they use their live `get_tools` state or pi's default when no wrapper exists.

### Model defaults for new sessions
`GET /api/models` returns `defaultModel` read from `~/.pi/agent/settings.json`. `ChatWindow` pre-selects this on mount for new sessions. Explicit browser model/thinking selections are applied atomically during AgentSession construction and are **session-scoped**: startup never writes `settings.json`, and neither does a mid-session `set_model` / `set_thinking_level`. That matches pi since 0.84.3, where `/model` and `/thinking` only persist on Ctrl+S; before that pi-web wrote every new-session pick back, so a one-off model silently became the TUI's default too (#871).

The explicit "save as default" is the star on each row of the model selector and the reasoning menu, the Web counterpart of Ctrl+S: `PUT /api/models/default` writes `defaultProvider`/`defaultModel` or `defaultThinkingLevel` (`lib/default-preferences.ts`), and the hook then also selects that row for the current chat, as Ctrl+S does. The route only accepts a model the selector can offer (in the resolved `enabledModels` scope), so a saved default always takes effect. A project `.pi/settings.json` value for a written key wins over the global one, so the route refuses with `409 { reason: "project-scope", settingsPath }` instead of reporting a save the user would never see. The model star marks the resolved `defaultModel`; the reasoning star marks `savedDefaultThinkingLevel`, the raw setting, because the resolved `defaultThinkingLevel` also folds in `:level` pins and per-model levels that the global write does not change. Both menus render `SelectorRow` (`components/SelectorRow.tsx`), which highlights the whole row like a session-list row and keeps one right-hand gutter for the star: the default row shows a small static filled star there, and every other row's save button floats into the same spot on hover or keyboard focus (always visible on touch screens, which have no hover). `ModelSelector` only shows stars when given `onSetDefault`; the subagent profile form reuses it without one.

### Remote provider catalogs
pi's built-in model lists are generated when the SDK is built and pi-web pins one SDK version, so a model a provider ships after that release is invisible until pi-web publishes a new version (#914). The SDK carries the other half: each built-in provider is wrapped in a pi.dev catalog overlay that `ModelRuntime.refresh()` fetches and persists to `~/.pi/agent/models-store.json`, and restoring that overlay needs no network. Both of pi-web's refresh paths ask for the offline half only (`createAgentSessionServices()` and `lib/provider-usage.ts` pass `allowNetwork: false`), which is why running the pi CLI once used to be the fix — the CLI refreshed with the network on and pi-web read what it left behind.

`lib/model-catalog-refresh.ts` runs that network pass, and **only when the user asks for it**: the "Refresh catalog" button in `EnabledModelsSection` posts to `/api/models/refresh`. Nothing refreshes catalogs on a timer or on another request's path — a pass fetches a catalog per authenticated provider, and a save must not wait on a slow one, the same reason `/api/auth/api-key/[provider]` stores the credential itself instead of calling `ModelRuntime.login()`. `refresh()` is called with `force: true`, since pressing the button is exactly a request to skip the SDK's four-hour freshness window, but *without* `allowNetwork`, so the runtime keeps applying its own `PI_OFFLINE` rule instead of pi-web overriding it; the module reports `reason: "offline"` rather than pretending a pass ran. `shareModelCatalogRefresh()` joins concurrent presses for the same providers so two tabs cannot race over the store file.

Change detection compares the model ids and names the runtime exposes, never the stored bytes: a successful revalidation rewrites `checkedAt` and `etag` on every pass. It only decides whether `invalidateModelsCache()` runs and whether the panel reloads — the overlay itself reaches the UI through the ordinary `/api/models` and `/api/models/enabled` loads, which build a fresh runtime that restores the store, so the refresh route never returns a model list of its own.

### `enabledModels` scoping
The `enabledModels` setting uses pi's `--models` syntax: minimatch globs against `provider/modelId` or a bare `modelId`, fuzzy matching for non-glob patterns, and an optional `:thinkingLevel` suffix. Never compare those patterns as literal strings — `lib/model-scope.ts` delegates to the SDK's `resolveModelScopeWithDiagnostics()` so pi-web and the TUI agree on the visible model list, and falls back to all available models when patterns resolve to nothing. `startRpcSession()` resolves that scope before creating an AgentSession and passes the selected initial model, thinking pin, and SDK-native `scopedModels` atomically; `GET /api/models` reuses the helper only for selector data, `thinkingLevelPins`, and `modelScopeWarnings` display.

Editing that setting from the Models panel goes through `/api/models/enabled`, never through pattern strings composed in the browser. Each toggle is a **minimal edit** of the stored list (`lib/enabled-models.ts`): a pattern that matches no available model is preserved verbatim, only the pattern covering the switched-off model is expanded in place (keeping its `:level` suffix), and every provider that ends up fully enabled with two or more entries collapses back into one glob — pi refreshes provider catalogs from the network into `models-store.json`, so an enumerated list rots when a model is renamed (deepseek's `deepseek-v4-flash` became `deepseek-flash`), while a glob heals itself. A lone exact reference is a deliberate pick and is left alone. **Never assume `provider/*` covers a provider**: pi matches with minimatch, whose `*` stops at `/`, so that glob silently misses every nested model id (`commandcode/sakana/fugu-ultra`, most OpenRouter ids) — writing it turned "enable all" into 15 of 71 models. `resolveProviderGlobs()` resolves `provider/*` then `provider/**` and keeps one only when its match set is exactly the provider's models; a provider that neither covers is written model by model. Also never rewrite the whole list from `getAvailable()` the way the TUI's `/scoped-models` does — it only sees providers that currently pass `checkAuth()`, so that would delete every entry for a provider whose credential is missing right now, and flatten globs and pins.

Disabling the last enabled model is refused with `409 { reason: "last-model" }`: pi falls back to every model when a scope resolves to nothing, so an empty list silently means the opposite. Writes always target the global settings file; a project `.pi/settings.json` replaces the global array instead of merging, so the route reports `scope: "project"`, renders the switches read-only, and returns that file's path as `settingsPath` — the banner names the file it just wrote (`~/.pi/agent/settings.json · enabledModels 20/104`) instead of describing the effect in prose. Built-in *and* extension-registered providers get per-model switches; models.json providers are switched as a whole by `EnabledModelsProviderSwitch` in their detail header, next to Delete, because a custom model can simply be deleted and both bulk buttons only ever sent the same provider-wide write. That switch is on only when every model of the provider is on, so a partial selection reads as off beside the sidebar's `1/2` badge and one click completes it; reading it as "any enabled" would leave partial unreachable in both directions once the last-model guard blocks the way down. Why it cannot move is its tooltip, not body text. `op: "prune"` is the only operation that drops unmatched entries, for cleaning up after such a rename; everything else preserves them. Saving models.json re-reads the switches through `op: "resync"`, which repairs the stored patterns against the new catalog: it rewrites renamed **models** and then renamed **providers**, **cuts back entries whose provider prefix no longer scopes them**, and re-asserts the providers that were fully enabled before the save. (Model references first: they still spell the old provider id, which the provider rewrite would otherwise have replaced already.) All three are needed because a pattern's meaning depends on the catalog. pi matches a pattern against the bare `modelId` as well as `provider/modelId`, so `stepfun/*` also matches another provider's model whose id *is* `stepfun/Step-5-Preview` — renaming a provider to `stepfun` silently enabled three `commandcode` models, and switching stepfun off then wrote them into the file. In the other direction, renaming a model to an id with a slash drops it out of `provider/*` (minimatch `*` stops at `/`), so a fully enabled provider silently loses it. A model renamed in the panel is a known move, not the kind of mismatch worth preserving: leaving `stepfun/ddd` behind after it became `stepfun/ddd1` loses the selection, and when it was the only entry the scope resolves to nothing, which pi reads as "no scope" and quietly enables every model. `ModelsConfig` mirrors every array move of the draft in `savedModelIdsRef` so `collectModelRenames()` can tell a rename from an add or a delete without guessing. Only `resync` repairs entries; ordinary toggles stay minimal edits and never rewrite what the user did not touch. A models.json provider missing from the runtime (unsaved edits, no models, a key that does not work) must not be reported as a sign-in problem, which is why it has its own control: the switch renders disabled with that reason as its tooltip, while `EnabledModelsSection` — now built-in only — keeps the sign-in empty state. See `docs/adr/0004-enabled-models-toggles.md`.

### SSE reconnect on page refresh mid-stream
On `ChatWindow` mount, `GET /api/agent/[id]` is called. If `state.isStreaming === true`, SSE is reconnected automatically. `thinkingLevel` and `isCompacting` are also synced from this response.

### Compaction SSE events
Newer pi emits `compaction_start` / `compaction_end`; older versions emitted `auto_compaction_start` / `auto_compaction_end`. `handleAgentEvent` accepts both sets to keep `isCompacting` in sync. Manual compact is a blocking POST — the button stays disabled until the response returns.

### Transcript system messages, usage entries and context edits (pi >= 0.86)
- Every new session's first request persists a `message` entry with `role: "system"` holding the prompt sections and tool declarations; later prompt or tool changes append more. The agent loop announces them with `message_start` / `message_end` like any message. They are provider input, never conversation: `toClientAgentEvent()` drops them before the SSE stream (they carry every tool schema), `handleAgentEvent` skips any that slip through, `entryToUiMessage()` returns null for them, and `BranchNavigator` / `lib/project-tree.ts` never label or preview a branch with one. They still count toward `messageCount` and `totalMessages`, exactly as the SDK counts them.
- `usage` entries (`kind: "cache_warm"`) record prompt-cache warming that is billed but never enters model context. `computeSessionStats()` adds them like compaction usage so the token/cost counters match `/session` in the TUI.
- `context_edit` entries omit or replace an earlier entry's model context without changing raw history; the UI ignores them. A retain-none compaction stores its own id in `firstKeptEntryId`.
- `SessionManager.listAll()` now reads files newest-mtime first (then reverse filename) so `--resume` can render progressively; its stable sort keeps that order for sessions with equal activity time, and `listSessionsIncremental()` reproduces it from the stat fingerprints it already keeps.

### Running state polling + reconciliation
- The sidebar polls `/api/agent/running` every 2.5 seconds while the tab is visible and pauses polling in background tabs. The session-list response remains the initial fallback.
- `invalidateSessionListCache()` bumps the generation but **keeps** the previous scan, and the cache is fresh only while its recorded generation matches. Ordinary agent activity invalidates it constantly, and rebuilding costs hundreds of milliseconds because `loadAllSessions()` re-reads every forked and subagent session. Callers that only need metadata — mapping search hits to sidebar rows — pass `listAllSessions({ allowStale: true })` to read the previous scan and let the rebuild happen in the background. A stale scan is a complete catalogue apart from sessions created seconds ago, so those callers accept a brief window where a brand-new session is not yet listed.
- `useAgentSession` treats per-session SSE as primary for chat events and opens it before each prompt. `prompt_done` completes the current UI stage and notification immediately, but the idle SSE stays open for a 30-second grace window and is reused by the next prompt. `agent_start` cancels that close timer; `agent_settled` finishes extension-injected runs that have no wrapper-level `prompt_done` and starts a fresh grace window. Do not close on the first `agent_end`: retries, compaction, and extension-queued messages can continue the same logical prompt.
- While a run is active, `useAgentSession` periodically calls `GET /api/agent/[id]` and also reconciles on `visibilitychange`/`online`. This fixes missed terminal events from background tabs or half-open connections.
- Prompt runs use a monotonic run id; late SSE or slow reconciliation responses from an old run must be ignored so they cannot resurrect stale streaming bubbles.
- Every SSE (re)connection in `useAgentSession` is gated on `sessionHookMountedRef`. React Strict Mode (on by default in `next dev`) re-runs effects in declaration order after a simulated unmount: the mount-only effect's cleanup sets that ref to `false`, and it is only restored when that effect re-runs, *after* the warm-session effect. The warm-session effect therefore re-asserts the ref before `maintainEventsConnected()`. Without it a dev-server tab never opened the event stream on mount or when switching back to a running session, so streamed output and new messages stayed invisible until the 15-second reconcile poll or a page refresh (`next start` was unaffected).

### Worktrees and project grouping
- `lib/worktree.ts` resolves linked worktree top-levels back to the main repo `projectRoot`; `listAllSessions()` attaches that to each `SessionInfo` so all worktrees for one repo are grouped together in the sidebar.
- Worktree operations are served by `/api/worktrees` and guarded by the same allowed-root rules as `/api/files`.
- New worktrees are created under `<repoRoot>-worktrees/<sanitized-branch>`. Existing branches are reused; otherwise `git worktree add -b` creates the branch.
- Removing a dirty worktree returns `409` with `{ dirty: true }` so the UI can ask before retrying with `force`.
- Sessions whose cwd points at a removed worktree are inferred back into the main project instead of becoming a phantom project row.
- git prints POSIX-style absolute paths even on Windows, so every path read out of git goes through `toNativePath()` (`lib/paths.ts`) before it is compared or returned. Compare paths with `samePath()`, never `===` — raw equality made `isTopLevel` permanently false on Windows and hid the worktree switcher entirely. Branch names are not paths and must keep their forward slashes. Browser code cannot apply Node path rules, so `/api/worktrees` resolves `currentWorktreePath` server-side; the sidebar must use that identity for highlighting and removal fallback.

### File access allow-list
- `/api/files` is intentionally not a general filesystem browser. Allowed roots come from session cwds, their resolved project roots, and roots explicitly added with `allowFileRoot()`.
- `/api/cwd/validate` and `/api/worktrees` call `allowFileRoot()` when they make a new location browsable. "Use default directory" is no exception: `/api/default-cwd` only creates `~/pi-cwd/YYYYMMDD`, and the sidebar selects it through `/api/cwd/validate` like any other directory.
- Allowed roots are stored slash-normalized, but that is a Set-key convention, not a correctness requirement: `isPathWithinRoots()` (`lib/path-security.ts`, the single implementation behind `isFilePathAllowed()`) re-resolves and case-folds both sides, so either path form authorizes correctly. Keep that one implementation — it is the security boundary.
- A UNC cwd (`\\host\share\dir`) must survive the `/api/files/[...path]` round-trip. `encodeFilePathForApi()` folds the `//` root into the first segment (`%2F%2Fhost`) because a literal `//` URL prefix is 308-normalized away before routing; `filePathFromApiSegments()` decodes it back. Never split UNC paths into segments and rejoin them — that silently turns `\\host\share` into the relative-looking `host/share` and every allow-check fails with 403.

### Plugins and skills
- `/api/plugins` uses pi's `SettingsManager` + `DefaultPackageManager` for global/project package install, remove, update, enable, and disable. Disabling writes empty `extensions/skills/prompts/themes` arrays for that package entry.
- `/api/skills` uses `DefaultResourceLoader` so settings paths, package skills, and project `.agents/skills` are listed the same way the runtime sees them.
- Skill toggling edits only the `disable-model-invocation` frontmatter key on the target `SKILL.md`; keep that surgical so user formatting survives.
- `/api/skills/install` shells through `npx skills add ... --agent pi`; project installs run with the selected cwd.

### Built-in subagents
- The global `builtInEnabled` switch is persisted in `~/.pi/agent/agents/settings.json` and defaults to `false` when the file or field is absent. Malformed settings fail closed; atomic updates preserve unknown fields.
- The inline built-in extension factory is always present so reloading an existing wrapper can apply setting changes, but it registers no tools while disabled. After changing the switch, the user must explicitly reload the current session.
- When enabled, only a recognized legacy `pi-subagents` extension that registers any reserved tool (`Agent`, `get_subagent_result`, or `steer_subagent`) is removed. Unrelated extensions remain loaded, and resolved conflict diagnostics are discarded.
- Runtime `Agent` dispatch checks the setting again so a stale tool call cannot start a subagent after the feature is switched off.
- See `docs/adr/0003-built-in-subagent-toggle.md` for the precedence and persistence rationale.
- Individual built-in profiles (`general-purpose`, `explore`, `plan`) are switched off by name in the same file's `disabledBuiltIns` array, never by copying them out to a `.md` file: a copy freezes the built-in prompt at the version it was copied from and is visible to the other runtimes reading those directories. `builtInProfiles()` stamps `enabled` onto the constants so the panel, the `Agent` tool description, and `resolveSubagentProfile` agree; each write is a minimal edit that preserves names it did not touch, including ones no built-in claims (a newer build's). Reading the list fails *open* — the feature switch beside it has already failed closed — while `PATCH /api/subagents/profiles` with `scope: "builtin"` performs the write and `PUT`/`DELETE` still refuse that scope. A same-name file replaces the built-in outright and is switched off through its own frontmatter. Only the switch is live for a built-in; the rest of the form stays read-only. See `docs/adr/0005-built-in-subagent-disable.md`.
- A background run's completion notification (`notifyParent`) is skipped when the parent already collected the same result with `get_subagent_result`: the tool marks a finished background run consumed and the notification takes that mark. The check cannot happen only when the completion promise resolves — the parent is usually still inside its `get_subagent_result` poll at that moment (500ms interval) and `deliverAs: "followUp"` would just queue the duplicate until that turn ends. So `notifyParent` holds the message while the parent `isRunning()` and re-checks the mark before sending; an idle parent is still notified immediately.
- Agent profile files (`~/.pi/agent/agents/*.md`, project `.pi/agents/*.md`) are shared with other runtimes, so a save round-trips the frontmatter keys this app does not own (`name`, `allowed_subagents`, `exclude_extensions`, `disallowed_tools`, …) and carries foreign `ext:` tool selectors through. Managed keys are exactly `description`, `display_name`, `tools`, `load_skills`, `load_extensions`, `enabled`, `inherit_context`, `run_in_background`, `model`, `thinking`, `max_turns`.
- A background run's completion reaches the parent through `sendCustomMessage`, and pi's `convertToLlm` replays every `custom` message to the model as a plain `user` turn. `subagentNotificationText()` therefore prefixes the report with `SUBAGENT_NOTIFICATION_PREFIX` so a compaction pass — whose prompt asks what *the user* wants — does not file the subagent's output under Goal / Constraints (#875). Foreground `Agent` and `get_subagent_result` results keep the bare `subagentFinalText()`: they are already `toolResult` messages and need no marker. Keep the prefix in code, not in a profile prompt, so the model cannot drop it.
- The `skills` / `extensions` spellings pi-subagents reads are seeded on first save and kept in step while they are booleans; a hand-authored whitelist such as `extensions: pi-advisor-flow` is never rewritten, and the two flags fall back to those aliases when `load_skills` / `load_extensions` are absent.

### Web password throttling
- `lib/auth-throttle.ts` is deliberately global, not per-IP: Next 16 route handlers have no socket address and `x-forwarded-for` is spoofable, while the server binds `127.0.0.1` for a single operator. Failures double the delay (1s → 60s cap) for everyone; a success or 5 idle minutes resets it. The reset window must stay longer than the max delay or waiting out one block restarts the burst.
- State lives on `globalThis` under `Symbol.for("pi-web:auth-throttle")` so it survives hot reload and is shared by every module instance. Tests reset it with `recordAuthSuccess()`.
- `POST /api/web-auth` and every `Authorization: Basic` header on `/api/*` share the counter; `proxy.ts` checks Basic before its `/api/web-auth` exemption, so `GET /api/web-auth` is not an unthrottled password oracle. A valid session cookie is checked first and is never blocked. While blocked, Basic gets `429` even with the right password (otherwise the answer leaks), and a Basic success does not reset the counter: Basic clients authenticate on every request, so a reset would restart an interleaved guesser at the base delay. The proxy and route handlers share the `globalThis` state under both `next dev` and `next start` (checked by failing one and observing `429` on the other).

### Auth and model config
- `ModelsConfig` combines models from `~/.pi/agent/models.json` with provider auth status from pi's `AuthStorage`/`ModelRegistry`.
- Provider listing is capability-driven, never id-driven: `lib/provider-listing.ts` decides membership from `auth.apiKey.login` / `auth.oauth` plus the stored credential type, so dual-auth providers (anthropic and github-copilot today — which providers declare both changes between SDK releases, so never assume it from an id) appear exactly once and never fall through both lists (#309). `lib/provider-listing-runtime.ts` adapts `ModelRuntime` to those pure helpers.
- auth.json holds **one** credential per provider and `ModelRuntime.logout()` deletes whichever it is. The delete routes therefore use `removeStoredCredentialIfType()` to compare and delete under the same file lock used by pi's auth storage. `ModelsConfig` also refreshes *both* provider lists after any auth change — refreshing one leaves a dual-auth provider rendered twice.
- OAuth/device-code/manual-code flows are streamed by `GET /api/auth/login/[provider]`; manual code responses POST back with a short-lived token stored in `globalThis.__piLoginCallbacks`.
- API-key routes store and remove keys through `AuthStorage`. Status endpoints must never return the raw key.
- The model test route is `app/api/models-config/test/route.ts`; `app/api/models/test/` is not a real route.

### Session tabs in the centre top bar (fork)
The fork replaces upstream's extension status line at the left of the centre top bar with a
browser-style tab strip (`components/SessionTabBar.tsx` + `lib/session-tabs.ts`). A tab is either
an existing session or a blank new-session composer; the list and the active tab persist in
`localStorage`. Upstream's model is a single `selectedSession`, so the strip is layered on top of
it: switching a tab drives `selectedSession` / `newSessionCwd` / `newSessionDraftId` and bumps
`sessionKey`. Four traps, each found the hard way:

- **At most one blank draft tab** (`sessionId === null`), and nothing ever consumes it behind the
  user's back: `openDraftTab` reuses the existing one (retargeting its cwd) instead of stacking, and
  `openSessionTab` always opens or focuses its own tab and leaves the blank one alone. A blank tab
  goes away only when its ✕ is clicked. `parseSessionTabs` collapses multi-draft payloads on read.
- **The strip is styled after the right panel's `TabBar`** (that is the reference control):
  full-height tabs at a fixed 180px, inactive `--bg-panel` / active `--bg`, `padding: 0 6px 0 12px`,
  a 24×24 close button that is revealed on hover (its space stays reserved, so widths never shift).
  The strip needs `align-self: stretch` to reach full height — the top bar is `align-items: center`,
  and without it the whole strip shrinks to ~20px and the active tab's background only covers the
  text ("grey with a white box inside"). The two scroll arrows each keep a 1px separator on the side
  facing the tabs (the right arrow's `border-left` matters because the tab at the list's right edge
  is clipped and has no visible right border of its own), and each one **unmounts** at its own end of
  the strip — not `visibility: hidden` — so reaching an end leaves no empty slot.
- **Revealing the active tab is driven by an effect plus a `ResizeObserver` — but only when a
  *tab* resizes, never when the strip itself does.** The scroll arrows unmount once their end is
  reached (so no space is left behind), and that changes the strip's width; revealing on the strip's
  own resize then fights the user: the view snaps back to the active tab so the strip can never be
  parked at the right end ("it never stops scrolling"), and the arrow buttons' smooth scroll gets
  aborted ~15px in. Keep the `entry.target !== el` filter in the observer callback.
- **Draft text is keyed per tab, not per cwd.** Drafts live in `lib/draft-store.ts` (an in-memory
  Map) under `new:<tabId>:<cwd>` and are *parked* under `parked-new:<tabId>` before switching away,
  because `useAgentSession`'s unmount cleanup calls `clearDraft(activeKey)` — not parking deletes
  the user's unsent message. `handleSelectSession`, `handleNewSession`, `handleCwdChange` and
  `restoreWorkspaceContext` all park first.
- **Tab state is written through to refs** (`applyTabsState`). One event can run several handlers in
  a row (close a tab → open its right neighbour); state alone is not visible to the second handler
  until the next render, so it would read the pre-close list and resurrect the closed tab.
- **A `?cwd=` / `?session=` URL wins over the restored tab list**, but the strip must still end up
  with a tab that matches what the centre pane shows — otherwise a restored tab looks active while
  the pane shows the composer, and clicking it does nothing.

Closing a tab only closes the view: the agent keeps running and the session stays in the sidebar.
The right panel, when expanded to full width, is `position: fixed; inset: 0` and its header
therefore sits at the window's top-left — it reserves `RIGHT_PANEL_TRAFFIC_LIGHTS_WIDTH` (96, a bit
wider than the centre top bar's 80) instead of `TRAFFIC_LIGHTS_WIDTH`.

Tabs can be **dragged with the pointer to reorder** (`moveTab` in `lib/session-tabs.ts` +
`onReorder` on the strip). The listeners go on `window`, not on the tab: reordering makes React move
the tab node in the DOM, and `setPointerCapture` on a node that gets moved is not guaranteed to
survive. A drag only starts past a 4px threshold (so plain clicks still work) and swallows the click
that follows the drop, otherwise releasing the pointer would switch tabs.

**Both strips share one implementation,** `hooks/useTabStripDrag.ts` (the file strip in the right
panel uses it too, via `components/FileTabStrip.tsx`). It works on **DOM nodes**, not on ids or
`data-*` attributes: the file tabs are rendered by upstream `TabBar`, which the fork may only extend
with a className. Two entry points feed the same gesture — per item (`handleItemPointerDown`, the
session strip) and event delegation (`handleContainerPointerDown`, the file strip, since upstream's
JSX cannot get an `onPointerDown`). Consequences worth knowing:

- The dragged item's own rect is excluded from the drop computation — it follows the cursor, so its
  rect is no longer its slot; including it makes the drop land early or not at all.
- Item positions are measured with `offsetLeft`, never `getBoundingClientRect()`: this is a layout
  value, unaffected by a running FLIP animation (rects are interpolated mid-flight). **That requires
  the scroll viewport to be the `offsetParent`** — `.session-tabs-list` / `.file-tabs` therefore carry
  `position: relative` in `native-theme.css`. Without it `offsetLeft` was measured against `body`
  (the file strip) or the top bar (the session strip) and the drop index came out hundreds of pixels
  off — the file strip could not be reordered at all.
- FLIP uses **WAAPI** (`node.animate`), not CSS transitions: the file tabs' `transition` is an inline
  value written by upstream (background/color only), and inline styles beat fork CSS, so `transform`
  cannot be added from the stylesheet. Animation also avoids the old
  `transition: none` → force reflow → restore dance.
- The post-drag click is swallowed by a **capture-phase `click` listener on the container**: the file
  tabs' click handler belongs to upstream and cannot read the fork's suppression flag, so the event has
  to be stopped before it reaches React's root listener. The session strip keeps its own check too.

The drag feedback is the whole point — without it you cannot tell where the tab will land. The
dragged tab gets an inline `transform: translateX(cursor − its own slot)` so it sticks to the
pointer, which leaves its own slot visibly empty as the drop target, and every *other* tab is
animated with FLIP.

**Measure with `offsetLeft`, never `getBoundingClientRect()`, in that effect.** `offsetLeft` is a
layout value and is unaffected by transforms; `getBoundingClientRect()` returns the *animated*
position, so FLIP deltas computed from it drift while a previous transition is still running.

The right panel's file tabs are reordered the same way; the only difference is the plumbing.
`handleReorderPanelTab` in `AppShell.tsx` maps the drag's `(fromIndex, toIndex)` onto the `fileTabs`
array by counting how many file tabs precede the drop position — `panelTabs` is `fileTabs`
concatenated with the terminal tabs, and those two live in separate state arrays, so a drag across the
boundary simply clamps at the edge of its own group instead of mixing them.

**Dragging must not select text.** The tabs are `user-select: none` and so are the *containers*
(`.session-tabs` / `.tab-strip`), but that alone is not enough in WKWebView: when a drag starts
inside a non-selectable subtree, WebKit walks up for the nearest selectable ancestor and anchors the
selection there, so dragging a tab sideways ends up selecting whatever text the pointer crosses (the
sidebar's session titles, typically). So `handlePointerDown` also calls `event.preventDefault()` —
that cancels the selection gesture outright (and the native drag of the label with it). It does
**not** break clicking a tab; that was verified with real mouse input.

### Tab strip scrolling is shared by two strips (fork)
The centre session strip and the right panel's file strip scroll identically, and both go through one
implementation, `hooks/useTabStripScroll.ts` (arrows + wheel→horizontal + reveal-the-active-tab).
Two strips, one implementation, because the edge cases in there are not obvious:

- `components/FileTabStrip.tsx` wraps upstream's `components/TabBar.tsx`. Upstream lets the tablist
  itself be the scroll container (`overflow-x: auto`), which draws a **native scrollbar** once tabs
  overflow — a scrollbar that eats part of the 36px strip and clips the tab labels (the reported
  bug). The fix hides it in CSS (`.file-tabs { scrollbar-width: none }` + `::-webkit-scrollbar`) and
  scrolls with the arrows/wheel instead. Upstream `TabBar.tsx` therefore gains exactly one thing:
  `className="file-tabs"` (FORK.md rule ②). The viewport is located by that selector, because the
  fork cannot get a ref to an upstream element.
- The extra `.tab-strip-viewport` wrapper in `FileTabStrip` exists for a reason: `TabBar`'s root
  carries an inline `flexShrink: 0`, and inline styles beat fork CSS — as a flex child of
  `.tab-strip` it would refuse to shrink and push the right arrow out of view.

### Desktop menu shortcuts (⌘T / ⌘W / ⌘,) in the native shell

macOS routes those chords to the **application menu first**, so the page never receives a keydown for
them. They are therefore registered natively in `desktop/src-tauri/src/main.rs` (`build_menu`), which
replaces Tauri's default menu. All three just `eval` a `CustomEvent` into the focused window
(`pi-desktop:new-tab` / `close-tab` / `settings`), which `hooks/useDesktopMenuCommands.ts` maps onto
the existing handlers — no `@tauri-apps/api` dependency on the web side, and the whole contract is
three event-name strings (keep both sides in sync).

**⌘W is a tab action and must never touch the window.** Tauri's default menu binds ⌘W to Close
Window, so the custom menu simply omits that item — with two ⌘W accelerators the winner would be
undefined. The red button still hides the window (the app deliberately keeps running in the
background). The **Edit menu has to stay** too: cut/copy/paste/select-all inside the web view are
forwarded through it, so dropping it breaks ⌘C/⌘V/⌘A in the composer.

### Completion sound
- `hooks/useAudio.ts` stores the toggle in `localStorage` as `pi-sound-enabled` and reuses one `AudioContext`.
- Browser autoplay policy means sound must be unlocked from a user gesture; `ChatInput` calls the unlock hook from interactive controls, and `ChatWindow` plays the tone from `onAgentEnd`.

### Exported session HTML
- `/api/sessions/[id]/export` delegates to pi's export helper, then patches recursive tree helpers in the generated HTML to iterative versions so very deep linear sessions do not overflow the browser call stack.

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

`entryIds[]` in `SessionContext` is a parallel array to `messages[]` — maps each displayed message back to its `.jsonl` entry id, used for fork and navigate_tree calls.

---

## CSS Variables (`app/globals.css`)

```
--bg --bg-panel --bg-hover --bg-selected --border
--text --text-muted --text-dim
--accent --user-bg --tool-bg
--font-mono
```



