import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-tabs.ts");
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    dump: () => Object.fromEntries(map),
  };
}

test("appends a blank draft tab and focuses it", async () => {
  const { openDraftTab } = await loadSubject();
  const state = openDraftTab({ tabs: [], activeId: null }, "draft-1", "/repo");
  assert.deepEqual(state, {
    tabs: [{ id: "draft-1", sessionId: null, cwd: "/repo" }],
    activeId: "draft-1",
  });
});

test("reuses the blank draft in the same cwd instead of stacking a second one", async () => {
  const { openDraftTab } = await loadSubject();
  const state = { tabs: [{ id: "draft-1", sessionId: null, cwd: "/repo" }], activeId: "draft-1" };
  assert.equal(openDraftTab(state, "draft-2", "/repo"), state);
});

test("never stacks a second blank draft even when the existing one is not active", async () => {
  const { openDraftTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "draft-1", sessionId: null, cwd: "/repo" },
      { id: "s1", sessionId: "s1", cwd: "/repo" },
    ],
    activeId: "s1",
  };
  assert.deepEqual(openDraftTab(state, "draft-2", "/repo"), {
    tabs: state.tabs,
    activeId: "draft-1",
  });
});

test("retargets the blank draft when the project changes", async () => {
  const { openDraftTab } = await loadSubject();
  const state = { tabs: [{ id: "draft-1", sessionId: null, cwd: "/repo" }], activeId: "draft-1" };
  assert.deepEqual(openDraftTab(state, "draft-2", "/other"), {
    tabs: [{ id: "draft-1", sessionId: null, cwd: "/other" }],
    activeId: "draft-1",
  });
});

test("appends a draft tab when the active tab holds a real session", async () => {
  const { openDraftTab } = await loadSubject();
  const state = { tabs: [{ id: "s1", sessionId: "s1", cwd: "/repo" }], activeId: "s1" };
  assert.deepEqual(openDraftTab(state, "draft-2", "/repo"), {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "draft-2", sessionId: null, cwd: "/repo" },
    ],
    activeId: "draft-2",
  });
});

test("a draft tab keeps its text when it is reused rather than recreated", async () => {
  const { openDraftTab, findDraftTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "draft-1", sessionId: null, cwd: "/repo" },
    ],
    activeId: "s1",
  };
  const next = openDraftTab(state, "draft-2", "/repo");
  assert.equal(findDraftTab(next.tabs).id, "draft-1");
  assert.equal(next.tabs.length, 2);
});

test("focuses an already-open session instead of opening it twice", async () => {
  const { openSessionTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "s2", sessionId: "s2", cwd: "/repo" },
    ],
    activeId: "s2",
  };
  assert.deepEqual(openSessionTab(state, { id: "s1", cwd: "/repo" }), {
    tabs: state.tabs,
    activeId: "s1",
  });
});

test("never consumes the active blank draft when a session is picked", async () => {
  const { openSessionTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "draft", sessionId: null, cwd: "/repo" },
    ],
    activeId: "draft",
  };
  assert.deepEqual(openSessionTab(state, { id: "s9", cwd: "/repo" }), {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "draft", sessionId: null, cwd: "/repo" },
      { id: "s9", sessionId: "s9", cwd: "/repo" },
    ],
    activeId: "s9",
  });
});

test("keeps the blank draft even when the picked session already has a tab", async () => {
  const { openSessionTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "draft", sessionId: null, cwd: "/repo" },
      { id: "s1", sessionId: "s1", cwd: "/repo" },
    ],
    activeId: "draft",
  };
  assert.deepEqual(openSessionTab(state, { id: "s1", cwd: "/repo" }), {
    tabs: state.tabs,
    activeId: "s1",
  });
});

test("leaves a blank draft behind the active tab untouched", async () => {
  const { openSessionTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/repo" },
      { id: "draft", sessionId: null, cwd: "/repo" },
      { id: "s2", sessionId: "s2", cwd: "/repo" },
    ],
    activeId: "s2",
  };
  const next = openSessionTab(state, { id: "s9", cwd: "/repo" });
  assert.deepEqual(next.tabs.map((tab) => tab.id), ["s1", "draft", "s2", "s9"]);
  assert.equal(next.activeId, "s9");
});

test("closing the active tab focuses its right neighbour, then the left one", async () => {
  const { closeTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
      { id: "c", sessionId: "c", cwd: "/r" },
    ],
    activeId: "b",
  };
  assert.equal(closeTab(state, "b").activeId, "c");
  assert.equal(closeTab(state, "c").activeId, "b");
  assert.deepEqual(closeTab(state, "a").tabs.map((tab) => tab.id), ["b", "c"]);
});

test("moving a tab reorders the list and keeps the active tab", async () => {
  const { moveTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
      { id: "c", sessionId: "c", cwd: "/r" },
    ],
    activeId: "b",
  };
  // 往后拖、往前拖都要动，且只改顺序。
  assert.deepEqual(moveTab(state, "a", 2).tabs.map((tab) => tab.id), ["b", "c", "a"]);
  assert.deepEqual(moveTab(state, "c", 0).tabs.map((tab) => tab.id), ["c", "a", "b"]);
  assert.equal(moveTab(state, "a", 2).activeId, "b");
  assert.equal(moveTab(state, "c", 0).tabs.length, 3);
});

test("moving a tab is a no-op when nothing effectively moves", async () => {
  const { moveTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
    ],
    activeId: "a",
  };
  // 同一个 state 对象回来，说明没有白白重渲染一次。
  assert.equal(moveTab(state, "a", 0), state);
  assert.equal(moveTab(state, "nope", 1), state);
});

test("moving a tab clamps an out-of-range target", async () => {
  const { moveTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
      { id: "c", sessionId: "c", cwd: "/r" },
    ],
    activeId: "c",
  };
  assert.deepEqual(moveTab(state, "a", 99).tabs.map((tab) => tab.id), ["b", "c", "a"]);
  assert.deepEqual(moveTab(state, "c", -5).tabs.map((tab) => tab.id), ["c", "a", "b"]);
});

test("a reorder can move the blank draft tab around like any other", async () => {
  const { moveTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "draft", sessionId: null, cwd: "/r" },
      { id: "a", sessionId: "a", cwd: "/r" },
    ],
    activeId: "draft",
  };
  const next = moveTab(state, "a", 0);
  assert.deepEqual(next.tabs.map((tab) => tab.id), ["a", "draft"]);
  assert.equal(next.activeId, "draft");
});

test("closing an inactive tab keeps the current focus", async () => {
  const { closeTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
    ],
    activeId: "b",
  };
  const next = closeTab(state, "a");
  assert.equal(next.activeId, "b");
  assert.deepEqual(next.tabs.map((tab) => tab.id), ["b"]);
});

test("closing the last tab leaves an empty state for the caller to fill", async () => {
  const { closeTab } = await loadSubject();
  assert.deepEqual(closeTab({ tabs: [{ id: "a", sessionId: "a", cwd: "/r" }], activeId: "a" }, "a"), {
    tabs: [],
    activeId: null,
  });
});

test("promotes a draft tab in place, keeping its position", async () => {
  const { promoteDraftTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/r" },
      { id: "draft", sessionId: null, cwd: "/r" },
      { id: "s2", sessionId: "s2", cwd: "/r" },
    ],
    activeId: "draft",
  };
  assert.deepEqual(promoteDraftTab(state, "draft", "new-id"), {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/r" },
      { id: "new-id", sessionId: "new-id", cwd: "/r" },
      { id: "s2", sessionId: "s2", cwd: "/r" },
    ],
    activeId: "new-id",
  });
});

test("promotion drops the draft tab when the session already has one", async () => {
  const { promoteDraftTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "new-id", sessionId: "new-id", cwd: "/r" },
      { id: "draft", sessionId: null, cwd: "/r" },
    ],
    activeId: "draft",
  };
  assert.deepEqual(promoteDraftTab(state, "draft", "new-id"), {
    tabs: [{ id: "new-id", sessionId: "new-id", cwd: "/r" }],
    activeId: "new-id",
  });
});

test("a background promotion does not steal focus from the tab the user is reading", async () => {
  const { promoteDraftTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "draft", sessionId: null, cwd: "/r" },
      { id: "s1", sessionId: "s1", cwd: "/r" },
    ],
    activeId: "s1",
  };
  assert.deepEqual(promoteDraftTab(state, "draft", "new-id"), {
    tabs: [
      { id: "new-id", sessionId: "new-id", cwd: "/r" },
      { id: "s1", sessionId: "s1", cwd: "/r" },
    ],
    activeId: "s1",
  });
});

test("removing a session that has no tab is a no-op", async () => {
  const { removeSessionTab } = await loadSubject();
  const state = { tabs: [{ id: "a", sessionId: "a", cwd: "/r" }], activeId: "a" };
  assert.equal(removeSessionTab(state, "missing"), state);
});

test("removing a session closes its tab and moves focus off it", async () => {
  const { removeSessionTab } = await loadSubject();
  const state = {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "b", sessionId: "b", cwd: "/r" },
    ],
    activeId: "a",
  };
  assert.deepEqual(removeSessionTab(state, "a"), {
    tabs: [{ id: "b", sessionId: "b", cwd: "/r" }],
    activeId: "b",
  });
});

test("draft keys round-trip a tab id even when the cwd contains a colon", async () => {
  const { draftKeyForTab, parkedDraftKeyForTab, tabIdFromDraftKey } = await loadSubject();
  assert.equal(draftKeyForTab("d1", "C:\\Users\\me"), "new:d1:C:\\Users\\me");
  assert.equal(tabIdFromDraftKey(draftKeyForTab("d1", "C:\\Users\\me")), "d1");
  assert.equal(tabIdFromDraftKey(parkedDraftKeyForTab("d1")), null);
  assert.equal(tabIdFromDraftKey("session-abc"), null);
  assert.equal(tabIdFromDraftKey(null), null);
  assert.equal(tabIdFromDraftKey("new::/r"), null);
});

test("activation describes a session tab or a draft tab", async () => {
  const { activationOf } = await loadSubject();
  assert.deepEqual(activationOf({ id: "s1", sessionId: "s1", cwd: "/r" }), {
    kind: "session",
    sessionId: "s1",
    tabId: "s1",
  });
  assert.deepEqual(activationOf({ id: "d1", sessionId: null, cwd: "/r" }), {
    kind: "draft",
    draftId: "d1",
    cwd: "/r",
    tabId: "d1",
  });
  assert.equal(activationOf(null), null);
});

test("serializes and restores the tab list and active tab", async () => {
  const { parseSessionTabs, serializeSessionTabs, activeTabOf } = await loadSubject();
  const state = {
    tabs: [
      { id: "s1", sessionId: "s1", cwd: "/r" },
      { id: "d1", sessionId: null, cwd: "/r" },
    ],
    activeId: "d1",
  };
  assert.deepEqual(parseSessionTabs(serializeSessionTabs(state)), state);
  assert.deepEqual(activeTabOf(state), { id: "d1", sessionId: null, cwd: "/r" });
});

test("falls back to the first tab when the stored active id is unknown", async () => {
  const { parseSessionTabs } = await loadSubject();
  const parsed = parseSessionTabs(JSON.stringify({
    tabs: [{ id: "a", sessionId: "a", cwd: "/r" }],
    activeId: "gone",
  }));
  assert.equal(parsed.activeId, "a");
});

test("drops malformed entries instead of failing the whole restore", async () => {
  const { parseSessionTabs } = await loadSubject();
  const parsed = parseSessionTabs(JSON.stringify({
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "", sessionId: "b", cwd: "/r" },
      { id: "c", sessionId: "c" },
      { id: "a", sessionId: "dup", cwd: "/r" },
      { id: "d", sessionId: "a", cwd: "/r" },
      null,
      { id: "e", sessionId: null, cwd: "/r" },
    ],
    activeId: "e",
  }));
  assert.deepEqual(parsed, {
    tabs: [
      { id: "a", sessionId: "a", cwd: "/r" },
      { id: "e", sessionId: null, cwd: "/r" },
    ],
    activeId: "e",
  });
});

test("collapses a stored list that holds more than one blank draft", async () => {
  const { parseSessionTabs } = await loadSubject();
  const parsed = parseSessionTabs(JSON.stringify({
    tabs: [
      { id: "d1", sessionId: null, cwd: "/r" },
      { id: "s1", sessionId: "s1", cwd: "/r" },
      { id: "d2", sessionId: null, cwd: "/r" },
      { id: "d3", sessionId: null, cwd: "/other" },
    ],
    // 活动标签正好是被折叠掉的那个草稿 —— 焦点要交给保留的草稿。
    activeId: "d3",
  }));
  assert.deepEqual(parsed, {
    tabs: [
      { id: "d1", sessionId: null, cwd: "/r" },
      { id: "s1", sessionId: "s1", cwd: "/r" },
    ],
    activeId: "d1",
  });
});

test("returns null for missing, empty, or unusable storage payloads", async () => {
  const { parseSessionTabs } = await loadSubject();
  assert.equal(parseSessionTabs(null), null);
  assert.equal(parseSessionTabs(""), null);
  assert.equal(parseSessionTabs("{"), null);
  assert.equal(parseSessionTabs("[]"), null);
  assert.equal(parseSessionTabs(JSON.stringify({ tabs: [] })), null);
  assert.equal(parseSessionTabs(JSON.stringify({ tabs: [{ id: "a", cwd: "" }] })), null);
});

test("writes, reads, and clears the persisted tab list", async () => {
  const { readSessionTabs, writeSessionTabs, clearSessionTabs } = await loadSubject();
  const storage = memoryStorage();
  assert.equal(readSessionTabs(storage), null);

  const state = { tabs: [{ id: "s1", sessionId: "s1", cwd: "/repo" }], activeId: "s1" };
  writeSessionTabs(state, storage);
  assert.deepEqual(readSessionTabs(storage), state);

  clearSessionTabs(storage);
  assert.equal(readSessionTabs(storage), null);
  assert.deepEqual(storage.dump(), {});
});
