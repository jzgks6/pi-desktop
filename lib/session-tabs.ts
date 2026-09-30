/**
 * 中栏的会话标签（IDE / 浏览器式）。
 *
 * 一个标签要么指向一个真实会话（`sessionId` 有值），要么是一个**还没发出消息的
 * 空白新会话草稿**（`sessionId` 为 null）—— 后者就是「正中间一个输入框」那个页面。
 *
 * 标签 id 是稳定的，并且承担草稿隔离：
 *  - 空白草稿标签：id 就是它的草稿 id。`useAgentSession` / `ChatInput` 的草稿键约定
 *    是 `new:<draftId>:<cwd>`，所以每个草稿标签天然有一份互不覆盖的草稿正文；
 *  - 会话标签：id 直接用 session id，去重与持久化都简单。
 *
 * 存 localStorage（全局一份，不按工作区分）：关掉 app 再开标签还在，
 * 和窗口宽度 / 主题 / 左栏状态一个存法。
 *
 * 纯函数 + 可选注入 storage，便于单测。
 */

export interface SessionTab {
  /** 稳定身份。草稿标签的 id 同时是它的 draft id。 */
  id: string;
  /** null = 空白新会话草稿标签（还没发出过消息）。 */
  sessionId: string | null;
  /** 该标签所属的工作目录。空白草稿也要有 cwd，因为新会话需要先有目录。 */
  cwd: string;
}

export interface SessionTabsState {
  tabs: SessionTab[];
  activeId: string | null;
}

export const EMPTY_SESSION_TABS: SessionTabsState = { tabs: [], activeId: null };

const STORAGE_KEY = "pi-web:session-tabs";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 草稿键：必须与 useAgentSession / ChatInput 的约定保持一致
 * ------------------------------------------------------------------ */

/** 活动草稿键。ChatWindow 用 `new:<draftId>:<cwd>` 寻址一份草稿。 */
export function draftKeyForTab(tabId: string, cwd: string): string {
  return `new:${tabId}:${cwd}`;
}

/**
 * 切走时草稿停放的键。按**标签**停放而不是按 cwd（上游是按 cwd），
 * 这样同一目录下的多个草稿标签互不覆盖。
 *
 * 不能不停放：`useAgentSession` 卸载时会 `clearDraft(活动键)`，
 * 不停走的话切标签就等于删掉没发出去的正文。
 */
export function parkedDraftKeyForTab(tabId: string): string {
  return `parked-new:${tabId}`;
}

/** 从 `new:<tabId>:<cwd>` 取回 tabId。cwd 可能含 `:`（Windows 盘符），所以只切第一个冒号。 */
export function tabIdFromDraftKey(key: string | null | undefined): string | null {
  if (!key || !key.startsWith("new:")) return null;
  const rest = key.slice(4);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return rest.slice(0, sep) || null;
}

/* ------------------------------------------------------------------ *
 * 查询
 * ------------------------------------------------------------------ */

export function activeTabOf(state: SessionTabsState): SessionTab | null {
  if (!state.activeId) return null;
  return state.tabs.find((tab) => tab.id === state.activeId) ?? null;
}

export function findTabBySession(tabs: SessionTab[], sessionId: string): SessionTab | null {
  return tabs.find((tab) => tab.sessionId === sessionId) ?? null;
}

export function isDraftTab(tab: SessionTab | null | undefined): boolean {
  return tab != null && tab.sessionId === null;
}

/** 空白草稿标签。全应用最多只有一个（见 openDraftTab）。 */
export function findDraftTab(tabs: SessionTab[]): SessionTab | null {
  return tabs.find((tab) => tab.sessionId === null) ?? null;
}

/**
 * 激活某个标签要做什么 —— 恢复流程用它把持久化的活动标签翻译成一次导航。
 */
export type TabActivation =
  | { kind: "session"; sessionId: string; tabId: string }
  | { kind: "draft"; draftId: string; cwd: string; tabId: string };

export function activationOf(tab: SessionTab | null): TabActivation | null {
  if (!tab) return null;
  if (tab.sessionId) return { kind: "session", sessionId: tab.sessionId, tabId: tab.id };
  return { kind: "draft", draftId: tab.id, cwd: tab.cwd, tabId: tab.id };
}

/* ------------------------------------------------------------------ *
 * 变更
 * ------------------------------------------------------------------ */

/**
 * 打开一个空白新会话标签。
 *
 * 全应用**最多一个**草稿标签：已经有就复用它（cwd 变了就改到新目录下）并聚焦，
 * 绝不会叠出第二个 —— 连点 + 也不该堆出一排空标签。
 *
 * 草稿里已经被打进去的字不会因为复用而丢：它按标签停放，在切换目录 / 重入时取回。
 * 所以这里无条件复用，不需要调用方再判断「能不能占」。
 *
 * 反过来，已经打开的空白标签也不会被别处悄悄收掉（见 openSessionTab）。
 */
export function openDraftTab(
  state: SessionTabsState,
  draftId: string,
  cwd: string,
): SessionTabsState {
  const existing = findDraftTab(state.tabs);
  if (existing) {
    if (existing.cwd === cwd) {
      return existing.id === state.activeId ? state : { tabs: state.tabs, activeId: existing.id };
    }
    return {
      tabs: state.tabs.map((tab) => tab.id === existing.id ? { ...tab, cwd } : tab),
      activeId: existing.id,
    };
  }
  const tab: SessionTab = { id: draftId, sessionId: null, cwd };
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * 打开一个已有会话的标签。
 *
 * 已有该会话的标签 → 跳过去（不重复开）；否则追加一个新标签。
 *
 * **绝不会动空白草稿标签** —— 空白页一旦打开就和其他标签一样，只有用户点 ✕ 才关掉。
 * （早先这里是「占用当前空白标签」，结果是点一下侧栏里的会话，那个空白页就没了。）
 */
export function openSessionTab(
  state: SessionTabsState,
  session: { id: string; cwd: string },
): SessionTabsState {
  const existing = findTabBySession(state.tabs, session.id);
  if (existing) return { tabs: state.tabs, activeId: existing.id };

  const tab: SessionTab = { id: session.id, sessionId: session.id, cwd: session.cwd };
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

/**
 * 关闭一个标签。活动标签被关掉时焦点落到**右邻居**，没有右邻居才用左邻居
 * （与浏览器一致）。返回的 `tabs` 可能为空，由调用方决定要不要补一个空白标签。
 */
export function closeTab(state: SessionTabsState, tabId: string): SessionTabsState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== tabId);
  if (state.activeId !== tabId) return { tabs, activeId: state.activeId };
  const next = tabs[index] ?? tabs[index - 1] ?? null;
  return { tabs, activeId: next?.id ?? null };
}

/**
 * 空白草稿标签转正为会话标签：填上 sessionId、id 换成 session id，位置不动。
 * 目标会话若已经有标签，则去掉草稿标签并把焦点交给已有标签。
 */
export function promoteDraftTab(
  state: SessionTabsState,
  draftTabId: string,
  sessionId: string,
): SessionTabsState {
  if (state.tabs.some((tab) => tab.id === sessionId)) {
    return {
      tabs: state.tabs.filter((tab) => tab.id !== draftTabId),
      activeId: state.activeId === draftTabId ? sessionId : state.activeId,
    };
  }
  return {
    tabs: state.tabs.map((tab) => tab.id === draftTabId
      ? { id: sessionId, sessionId, cwd: tab.cwd }
      : tab),
    activeId: state.activeId === draftTabId ? sessionId : state.activeId,
  };
}

/**
 * 拖动排序：把 `tabId` 挪到 `toIndex`（按移动后的数组算的下标）。
 *
 * `toIndex` 越界会被夹到合法范围；位置没变就原样返回（少一次渲染）。
 * 活动标签**不跟着改** —— 搬动一个标签不该把焦点也搬走。
 */
export function moveTab(state: SessionTabsState, tabId: string, toIndex: number): SessionTabsState {
  const from = state.tabs.findIndex((tab) => tab.id === tabId);
  if (from === -1) return state;
  const to = Math.max(0, Math.min(state.tabs.length - 1, toIndex));
  if (to === from) return state;
  const tabs = [...state.tabs];
  const [moved] = tabs.splice(from, 1);
  tabs.splice(to, 0, moved);
  return { tabs, activeId: state.activeId };
}

/** 会话被删除：关掉它的标签（如果有）。 */
export function removeSessionTab(state: SessionTabsState, sessionId: string): SessionTabsState {
  const tab = findTabBySession(state.tabs, sessionId);
  return tab ? closeTab(state, tab.id) : state;
}

/** 会话标签的 session 变了（fork / 转正后的重挂载）：就地替换 id 与 sessionId。 */
export function replaceTabSession(
  state: SessionTabsState,
  tabId: string,
  sessionId: string,
): SessionTabsState {
  if (state.tabs.some((tab) => tab.id === sessionId)) {
    return {
      tabs: state.tabs.filter((tab) => tab.id !== tabId),
      activeId: state.activeId === tabId ? sessionId : state.activeId,
    };
  }
  return {
    tabs: state.tabs.map((tab) => tab.id === tabId
      ? { ...tab, id: sessionId, sessionId }
      : tab),
    activeId: state.activeId === tabId ? sessionId : state.activeId,
  };
}

/* ------------------------------------------------------------------ *
 * 持久化
 * ------------------------------------------------------------------ */

export function parseSessionTabs(raw: string | null): SessionTabsState | null {
  if (typeof raw !== "string" || raw.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as { tabs?: unknown; activeId?: unknown };
  if (!Array.isArray(record.tabs)) return null;

  const tabs: SessionTab[] = [];
  const seenIds = new Set<string>();
  const seenSessions = new Set<string>();
  let keptDraftId: string | null = null;
  let skippedDraftId: string | null = null;
  for (const item of record.tabs) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const { id, sessionId, cwd } = item as { id?: unknown; sessionId?: unknown; cwd?: unknown };
    if (typeof id !== "string" || !id || seenIds.has(id)) continue;
    if (typeof cwd !== "string" || !cwd) continue;
    const sid = typeof sessionId === "string" && sessionId ? sessionId : null;
    if (sid && seenSessions.has(sid)) continue;
    // 空白草稿标签最多保留一个（旧版本 / 手写存储可能塞了多个）。
    if (!sid) {
      if (keptDraftId) {
        skippedDraftId = id;
        continue;
      }
      keptDraftId = id;
    }
    seenIds.add(id);
    if (sid) seenSessions.add(sid);
    tabs.push({ id, sessionId: sid, cwd });
  }
  if (tabs.length === 0) return null;

  // 被折叠掉的那些草稿标签如果是活动标签，就把焦点交给保留的那个。
  let activeId = typeof record.activeId === "string" ? record.activeId : null;
  if (activeId && !seenIds.has(activeId)) activeId = skippedDraftId === activeId ? keptDraftId : null;
  if (!activeId || !seenIds.has(activeId)) activeId = tabs[0].id;
  return { tabs, activeId };
}

export function serializeSessionTabs(state: SessionTabsState): string {
  return JSON.stringify({ tabs: state.tabs, activeId: state.activeId });
}

export function readSessionTabs(storage: StorageLike | null = getBrowserStorage()): SessionTabsState | null {
  if (!storage) return null;
  try {
    return parseSessionTabs(storage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeSessionTabs(
  state: SessionTabsState,
  storage: StorageLike | null = getBrowserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, serializeSessionTabs(state));
  } catch {
    // 存储不可用时忽略：标签仍在内存里工作
  }
}

export function clearSessionTabs(storage: StorageLike | null = getBrowserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
