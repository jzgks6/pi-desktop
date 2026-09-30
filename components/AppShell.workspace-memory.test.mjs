import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const draftStore = await jiti.import("../lib/draft-store.ts");
const tabsLib = await jiti.import("../lib/session-tabs.ts");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("explicit context changes invalidate a pending workspace restore", () => {
  const callbacks = [
    ["handleCwdChange", "handleSelectSession"],
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "hydrateSelectedSession"],
    ["handleSessionCreated", "handleAgentEnd"],
    ["handleSessionForked", "handleInitialRestoreDone"],
    ["handleSessionDeleted", "handleOpenFile"],
  ];

  for (const [name, nextName] of callbacks) {
    assert.match(callbackBody(name, nextName), /invalidateWorkspaceRestore\(\);/);
  }
});

test("all active-session transitions share one persistence effect", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s+if \(selectedSession\) \{[\s\S]*?setLastOpenSession\(projectKey, selectedSession\.id\);\s+setTabOpenSession\(selectedSession\.id\);\s+return;\s+\}\s+if \(newSessionCwd\) setTabOpenNewSession\(newSessionCwd\);\s+\}, \[newSessionCwd, selectedSession\]\);/,
  );
});

test("keeps chat scroll positions in page memory by session id", () => {
  assert.match(source, /useRef\(new Map<string, ChatScrollPosition>\(\)\)/);
  assert.match(source, /sessionScrollPositionsRef\.current\.set\(sessionId, position\)/);
  assert.match(source, /initialScrollPosition=\{selectedSession \? sessionScrollPositionsRef\.current\.get\(selectedSession\.id\) \?\? null : null\}/);
  assert.match(source, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  assert.doesNotMatch(source, /localStorage[^\n]*sessionScroll/i);
});

test("workspace restoration remains inside the cross-project branch", () => {
  assert.match(
    callbackBody("handleCwdChange", "handleSelectSession"),
    /if \(currentProject !== newProject\) \{[\s\S]*?restoreWorkspaceContext\(newProject\);[\s\S]*?\}/,
  );
});

test("session tabs persist across restarts and never start out empty", () => {
  // 恢复：先按 URL，再按上次的标签；恢复完成之前不许写回，否则会用空列表覆盖。
  assert.match(source, /const stored = readSessionTabs\(\);/);
  assert.match(source, /if \(initialNavigation\.requestedCwd \|\| initialNavigation\.sessionId\) return;/);
  assert.match(source, /pendingDraftTabIdRef\.current = activation\.draftId;/);
  assert.match(source, /if \(!sessionTabsReady\) return;\s+writeSessionTabs\(\{ tabs: sessionTabs, activeId: activeSessionTabId \}\);/);
  // 关标签 / 删会话都不会让标签条变空。
  const closeBody = source.slice(
    source.indexOf("  const handleCloseSessionTab = useCallback"),
    source.indexOf("  const handleOpenFile = useCallback"),
  );
  assert.match(closeBody, /let nextTabs = closeSessionTab\(currentTabsState\(\), tabId\);/);
  assert.match(closeBody, /if \(nextTabs\.tabs\.length === 0\) nextTabs = openDraftTab\(nextTabs, newTabId\(\), tab\.cwd\);/);
  const deleteBody = source.slice(
    source.indexOf("  const handleSessionDeleted = useCallback"),
    source.indexOf("  const handleSelectSessionTab = useCallback"),
  );
  assert.match(deleteBody, /if \(wasActive && nextTabs\.tabs\.length === 0 && cwd\) \{\s+nextTabs = openDraftTab\(nextTabs, newTabId\(\), cwd\);/);
});

test("unsent draft text is parked per tab and survives session navigation", async () => {
  const cwd = "/draft-project";
  const session = { id: "remembered", cwd, projectKey: cwd };

  // 提取的是 AppShell 里真正的胶水层：标签状态读写 + 草稿的停放 / 取回。
  // （`currentTabsState` / `applyTabsState` 在 hook 里定义得比其余几个早，
  //   所以这里分两段拼起来。）
  const tabGlue = [
    source.slice(
      source.indexOf("  const currentTabsState = useCallback"),
      source.indexOf("  useEffect(() => {\n    const requestedCwd = initialNavigation.requestedCwd;"),
    ),
    source.slice(
      source.indexOf("  const parkActiveDraft = useCallback"),
      source.indexOf("  // Restore the workspace's last open session"),
    ),
  ].join("\n");
  assert.match(tabGlue, /const currentTabsState = useCallback/);
  assert.match(tabGlue, /const applyTabsState = useCallback/);
  assert.match(tabGlue, /const parkActiveDraft = useCallback/);
  assert.match(tabGlue, /const enterDraftTab = useCallback/);

  const callbacks = [
    callbackBody("restoreWorkspaceContext", "handleCwdChange"),
    callbackBody("handleCwdChange", "handleSelectSession"),
    callbackBody("handleSelectSession", "handleNewSession"),
    callbackBody("handleNewSession", "hydrateSelectedSession"),
  ].join("\n");

  const sessionTabsRef = { current: [] };
  const activeSessionTabIdRef = { current: null };
  const activeNewSessionDraftKeyRef = { current: null };
  const response = Promise.withResolvers();
  const context = vm.createContext({
    ...draftStore,
    ...tabsLib,
    crypto: globalThis.crypto,
    queueMicrotask,
    URLSearchParams,
    window: { location: { pathname: "/", search: "" } },
    router: { replace() {} },
    fetch: () => response.promise,
    getLastOpenSession: (key) => (key === cwd ? session.id : null),
    clearLastOpen() {},
    workspaceKeyOf: (value) => value.projectKey ?? value.cwd,
    useCallback: (callback) => callback,
    useGlobalKeyboardShortcuts() {},
    sessionTabsRef,
    activeSessionTabIdRef,
    activeNewSessionDraftKeyRef,
    activeProjectKeyRef: { current: cwd },
    workspaceRestoreTokenRef: { current: 0 },
    suppressCwdBumpRef: { current: false },
    branchLeafChangeFnRef: { current: null },
    liveFollowFrameRef: { current: null },
    bashRecoveryIdRef: { current: 0 },
    cancelEventStreamGrace() {},
    closeEvents() {},
    isMobile: false,
    activeCwd: cwd,
    activeFileTabId: null,
    newSessionCwd: null,
    newSessionDraftId: "initial",
    selectedSession: null,
    sessionCatalog: [session],
    sessionKey: 0,
  });
  context.invalidateWorkspaceRestore = () => {
    context.workspaceRestoreTokenRef.current += 1;
  };

  const setters = new Set();
  for (const [setter] of `${tabGlue}\n${callbacks}`.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
    setters.add(setter);
  }
  for (const setter of setters) {
    const state = setter[3].toLowerCase() + setter.slice(4);
    context[setter] = (value) => {
      context[state] = typeof value === "function" ? value(context[state]) : value;
    };
  }
  // 真实组件在 render 里把标签 state 同步进这两个 ref，handler 读的是 ref。
  for (const [stateName, ref] of [["sessionTabs", sessionTabsRef], ["activeSessionTabId", activeSessionTabIdRef]]) {
    const setter = `set${stateName[0].toUpperCase()}${stateName.slice(1)}`;
    const base = context[setter];
    context[setter] = (value) => {
      base(value);
      ref.current = context[stateName];
    };
  }

  vm.runInContext(stripTypeScriptTypes(`
    const newTabId = (() => { let n = 0; return () => "auto-tab-" + (++n); })();
    ${tabGlue}
    ${callbacks}
    globalThis.navigate = { handleCwdChange, handleSelectSession, handleNewSession, enterDraftTab };
  `), context);

  // 真实组件由 state 推导出 newSessionDraftKey，再在 layout effect 里写进 ref；
  // 每次导航后补上这一步，handler 读到的才是真实的活动草稿键。
  const commit = () => {
    const effective = context.newSessionCwd
      ?? (context.selectedSession === null ? context.activeCwd : null);
    const key = context.selectedSession === null && effective
      ? `new:${context.newSessionDraftId}:${effective}`
      : null;
    context.activeNewSessionDraftKeyRef.current = key;
    return key;
  };
  const tabIds = () => sessionTabsRef.current.map((tab) => tab.id);
  const parkedDraft = (tabId) => draftStore.getDraft(tabsLib.parkedDraftKeyForTab(tabId));
  const activeDraft = (tabId, tabCwd = cwd) => draftStore.getDraft(tabsLib.draftKeyForTab(tabId, tabCwd));
  const tabById = (tabId) => sessionTabsRef.current.find((tab) => tab.id === tabId);

  // 真实的 useAgentSession 卸载清理：它会 clearDraft(活动键)，所以正文必须先停放好。
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const cleanupStart = hookSource.indexOf("    return () => {", hookSource.indexOf("  // Load session on mount"));
  const cleanupEnd = hookSource.indexOf("    // eslint-disable-next-line", cleanupStart);
  const makeCleanup = vm.runInContext(stripTypeScriptTypes(`((isNew, newSessionDraftKey) => {
    const sessionHookMountedRef = { current: true };
    const newSessionPromotedRef = { current: false };
    const sessionIdRef = { current: null };
    const dataRef = { current: null };
    const messagesRef = { current: [] };
    const entryIdsRef = { current: [] };
    const activeLeafIdRef = { current: null };
    const historyCursorRef = { current: null };
    const hasEarlierMessagesRef = { current: false };
    const getSessionViewSnapshot = () => null;
    const setSessionViewSnapshot = () => false;
    const deleteSessionViewSnapshot = () => {};
    ${hookSource.slice(cleanupStart, cleanupEnd)}
  })`), context);

  // 1) New opens a blank tab; the composer's text lives under that tab's own key.
  const draftA = { value: "unsent A", images: [] };
  context.navigate.handleNewSession("draft-A", cwd);
  assert.equal(commit(), `new:draft-A:${cwd}`);
  assert.deepEqual(tabIds(), ["draft-A"]);
  draftStore.setDraft(`new:draft-A:${cwd}`, draftA);

  // 2) Selecting a session parks the text under the tab id. Run the real hook
  //    cleanup on the outgoing mount — clearing the old active key must not
  //    destroy the text.
  context.navigate.handleSelectSession(session);
  const cleanup = makeCleanup(true, `new:draft-A:${cwd}`);
  cleanup();
  await new Promise((resolve) => setImmediate(resolve));
  commit();
  assert.deepEqual(parkedDraft("draft-A"), draftA);
  assert.equal(activeDraft("draft-A"), null);
  assert.deepEqual(tabIds(), ["draft-A", "remembered"]);
  assert.equal(activeSessionTabIdRef.current, "remembered");

  // 3) Re-entering the draft tab brings its text back to the active key.
  context.navigate.enterDraftTab(tabById("draft-A"));
  assert.deepEqual(draftStore.getDraft(commit()), draftA);

  // 4) “+” never stacks a second draft: it reuses the single draft tab, whose
  //    text is parked on the way in and restored on the way back.
  context.navigate.handleNewSession("draft-B", cwd);
  assert.equal(commit(), `new:draft-A:${cwd}`);
  assert.deepEqual(tabIds(), ["draft-A", "remembered"]);
  assert.deepEqual(draftStore.getDraft(`new:draft-A:${cwd}`), draftA);

  // 5) Switching project keeps exactly one draft tab and carries its text over.
  context.navigate.handleCwdChange("/other-project", "/other-project", "/other-project");
  assert.equal(commit(), "new:draft-A:/other-project");
  assert.deepEqual(tabIds(), ["draft-A", "remembered"]);
  assert.deepEqual(draftStore.getDraft("new:draft-A:/other-project"), draftA);

  // 6) Coming back retargets that same tab again; the parked session also comes
  //    back, and the draft's text is still held by its tab.
  context.navigate.handleCwdChange(cwd, cwd, cwd);
  commit();
  assert.deepEqual(tabIds(), ["draft-A", "remembered"]);
  assert.deepEqual(parkedDraft("draft-A"), draftA);
  assert.equal(activeSessionTabIdRef.current, "remembered");

  // 7) Re-entering the draft tab still restores its text.
  context.navigate.enterDraftTab(tabById("draft-A"));
  assert.deepEqual(draftStore.getDraft(commit()), draftA);

  response.resolve({ ok: true, json: async () => ({ sessions: [session] }) });
});
