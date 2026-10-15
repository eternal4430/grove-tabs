import {
  sanitizeParents, subtreeIds, planMoves, hostMatches, matchSaved, toEntries, concatWindows,
  concatGroups, captureWindow,
} from './lib/tree.js';

const DEFAULT_SETTINGS = {
  theme: 'system',
  retentionHours: 24, // 0 keeps closed tabs until removed
  exclusions: [],
  allWindows: false,
  showClosed: true,
  restoreMode: 'replace',
  side: 'right', // which edge of the window the floating panel docks to
};
const MAX_CLOSED = 500;

// state.nodes: { [tabId]: { parentId, collapsed } }. state.cache keeps what onRemoved no
// longer tells us (url, title, window, index). Both live in storage.session so they
// survive service-worker restarts; savedTree in storage.local survives browser restarts.
let state = null;
let queue = Promise.resolve();
let holdPersistUntil = 0;
const claimed = new Set(); // tabs we created ourselves and already placed in the tree
const suppressClosed = new Set(); // tabs we close on purpose (restores) that shouldn't become ghosts

// Every event and message goes through one queue so tree edits never interleave.
function run(fn) {
  const p = queue.then(fn);
  queue = p.catch((err) => console.error('[grove]', err));
  return p;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

function remember(tab) {
  state.cache[tab.id] = {
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    windowId: tab.windowId,
    index: tab.index,
  };
}

async function load({ keep } = {}) {
  if (state) return state;
  const s = await chrome.storage.session.get(['nodes', 'cache']);
  state = { nodes: s.nodes || {}, cache: s.cache || {} };
  await reconcile(!s.nodes, keep);
  return state;
}

function groupByWindow(tabs) {
  const map = new Map();
  for (const t of [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)) {
    if (!map.has(t.windowId)) map.set(t.windowId, []);
    map.get(t.windowId).push(t);
  }
  return map;
}

async function reconcile(useSaved, keep) {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  const live = new Set(tabs.map((t) => t.id));
  for (const key of Object.keys(state.nodes)) if (!live.has(+key) && +key !== keep) delete state.nodes[key];
  for (const key of Object.keys(state.cache)) if (!live.has(+key) && +key !== keep) delete state.cache[key];
  for (const tab of tabs) {
    state.nodes[tab.id] ??= { parentId: null, collapsed: false };
    remember(tab);
  }
  if (useSaved) {
    const { savedTree } = await chrome.storage.local.get('savedTree');
    if (savedTree?.length) {
      for (const winTabs of groupByWindow(tabs).values()) {
        for (const [id, saved] of matchSaved(winTabs, savedTree)) {
          if (state.nodes[id].parentId == null) Object.assign(state.nodes[id], saved);
        }
      }
    }
  }
  dropCrossWindowParents();
  await save();
}

function dropCrossWindowParents() {
  for (const [id, node] of Object.entries(state.nodes)) {
    if (node.parentId == null) continue;
    const parent = state.cache[node.parentId];
    if (!parent || parent.windowId !== state.cache[id]?.windowId) node.parentId = null;
  }
}

let persistTimer = null;
async function save() {
  await chrome.storage.session.set({ nodes: state.nodes, cache: state.cache });
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => run(persistTree), 1000);
  broadcast();
}

// Mirrors the tree by URL position so it can be rebuilt after a browser restart.
async function persistTree() {
  if (!state) return;
  const wait = holdPersistUntil - Date.now();
  if (wait > 0) {
    persistTimer = setTimeout(() => run(persistTree), wait);
    return;
  }
  const tabs = await treeTabs();
  const savedTree = [...groupByWindow(tabs).values()].map((w) =>
    toEntries(w).map(({ url, parent, collapsed }) => ({ url, parent, collapsed })),
  );
  await chrome.storage.local.set({ savedTree });
}

let broadcastTimer = null;
function broadcast() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {}), 40);
}

// All tabs, sorted by window then index, with tree fields merged in.
// Only normal browser windows: Grove's own panel window (a popup) never shows in the tree.
async function treeTabs() {
  const tabs = await chrome.tabs.query({ windowType: 'normal' });
  tabs.sort((a, b) => a.windowId - b.windowId || a.index - b.index);
  const windowOf = new Map(tabs.map((t) => [t.id, t.windowId]));
  return sanitizeParents(
    tabs.map((t) => {
      const node = state.nodes[t.id] || {};
      const parentId = windowOf.get(node.parentId) === t.windowId ? node.parentId : null;
      return { ...t, url: t.url || t.pendingUrl || '', parentId, collapsed: !!node.collapsed };
    }),
  );
}

function recordable(url, settings) {
  return /^(https?|file|ftp):/.test(url || '') && !hostMatches(url, settings.exclusions);
}

async function getClosed(settings) {
  const { closed = [] } = await chrome.storage.local.get('closed');
  if (!settings.retentionHours) return closed;
  const cutoff = Date.now() - settings.retentionHours * 3600e3;
  const fresh = closed.filter((c) => c.closedAt > cutoff);
  if (fresh.length !== closed.length) await chrome.storage.local.set({ closed: fresh });
  return fresh;
}

async function createTab(props, parentId = null, collapsed = false) {
  const tab = await chrome.tabs.create(props);
  claimed.add(tab.id);
  state.nodes[tab.id] = { parentId, collapsed };
  remember(tab);
  return tab;
}

// Opens snapshot entries in order, then wires up their parents. Returns ids (null on failure).
async function groupInfo() {
  return new Map((await chrome.tabGroups.query({})).map((g) => [g.id, g]));
}

// Opens snapshot entries in order, wires up their parents, then recreates their tab groups.
async function openEntries(entries, windowId, startIndex, groups = []) {
  const ids = [];
  for (const [i, e] of entries.entries()) {
    try {
      const props = { url: e.url, windowId, active: false, pinned: !!e.pinned };
      if (startIndex != null) props.index = startIndex + i;
      ids.push((await createTab(props)).id);
    } catch (err) {
      console.warn('[grove] could not open', e.url, err);
      ids.push(null);
    }
  }
  entries.forEach((e, i) => {
    if (ids[i] == null) return;
    state.nodes[ids[i]] = { parentId: e.parent != null ? (ids[e.parent] ?? null) : null, collapsed: !!e.collapsed };
  });
  for (const [g, meta] of groups.entries()) {
    const tabIds = entries.flatMap((e, i) => (e.group === g && ids[i] != null ? [ids[i]] : []));
    if (!tabIds.length) continue;
    try {
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      await chrome.tabGroups.update(groupId, { title: meta.title || '', color: meta.color || 'grey', collapsed: !!meta.collapsed });
    } catch (err) {
      console.warn('[grove] could not recreate group', meta, err);
    }
  }
  return ids.filter((id) => id != null);
}

async function openInNewWindow(entries, groups = []) {
  const win = await chrome.windows.create({ focused: true });
  const blank = win.tabs?.[0]?.id;
  const ids = await openEntries(entries, win.id, undefined, groups);
  if (ids.length) {
    await chrome.tabs.update(ids[0], { active: true });
    if (blank != null) await chrome.tabs.remove(blank);
  }
  return win.id;
}

async function setHoudiniBadge(on) {
  if (on === undefined) on = !!(await chrome.storage.local.get('houdini')).houdini;
  await chrome.action.setBadgeBackgroundColor({ color: '#6b4fbb' });
  await chrome.action.setBadgeText({ text: on ? 'H' : '' });
  await chrome.action.setTitle({ title: on ? 'Grove tabs (Houdini mode on)' : 'Grove tabs' });
}

const handlers = {
  async getState({ windowId }) {
    const settings = await getSettings();
    const [tabs, closed, local, session, groups] = await Promise.all([
      treeTabs(),
      getClosed(settings),
      chrome.storage.local.get(['houdini', 'snapshots']),
      chrome.storage.session.get('undo'),
      chrome.tabGroups.query({}),
    ]);
    const now = Date.now();
    const ttl = settings.retentionHours * 3600e3;
    const windows = [...groupByWindow(tabs)]
      .filter(([id]) => settings.allWindows || id === windowId)
      .sort(([a], [b]) => (a === windowId ? -1 : b === windowId ? 1 : a - b))
      .map(([id, winTabs]) => ({
        id,
        tabs: winTabs
          .filter((t) => !hostMatches(t.url, settings.exclusions))
          .map((t) => ({
            id: t.id,
            title: t.title || t.url,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
            audible: t.audible,
            muted: !!t.mutedInfo?.muted,
            discarded: t.discarded,
            loading: t.status === 'loading',
            parentId: t.parentId,
            collapsed: t.collapsed,
            groupId: t.groupId ?? -1,
          })),
        groups: groups.filter((g) => g.windowId === id).map(({ id: gid, title, color, collapsed }) => ({ id: gid, title, color, collapsed })),
      }));
    return {
      windowId,
      windows,
      settings,
      houdini: !!local.houdini,
      canUndo: !!session.undo,
      closed: settings.showClosed
        ? closed
          .filter((c) => !hostMatches(c.url, settings.exclusions))
          .map((c) => ({ ...c, remaining: settings.retentionHours ? c.closedAt + ttl - now : null }))
        : [],
      snapshots: (local.snapshots || []).map(({ id, name, createdAt, updatedAt, windows: w }) => ({
        id,
        name,
        createdAt,
        updatedAt: updatedAt || createdAt,
        windowCount: w.length,
        tabCount: w.reduce((n, x) => n + x.tabs.length, 0),
      })),
    };
  },

  // Focusing a window makes tiling compositors warp the pointer to it, so only do that when
  // the tab lives in a different browser window than the one the panel is serving.
  async activate({ tabId, focus = false }) {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (focus) await chrome.windows.update(tab.windowId, { focused: true });
  },

  async openUrl({ url, windowId }) {
    await chrome.tabs.create({ url, windowId, active: true });
  },

  async close({ tabId, withChildren }) {
    const tabs = await treeTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const ids = withChildren ? subtreeIds(tabs.filter((t) => t.windowId === tab.windowId), tabId) : [tabId];
    await chrome.tabs.remove(ids);
  },

  async toggleCollapse({ tabId, collapsed }) {
    const node = state.nodes[tabId];
    if (!node) return;
    node.collapsed = collapsed ?? !node.collapsed;
    await save();
  },

  async setCollapsedAll({ windowId, collapsed }) {
    for (const t of await treeTabs()) if (t.windowId === windowId) state.nodes[t.id].collapsed = collapsed;
    await save();
  },

  // position: 'before' | 'after' (siblings of target) | 'inside' (last child of target)
  async move({ tabId, targetId, position }) {
    if (tabId === targetId) return;
    let tabs = await treeTabs();
    const source = tabs.find((t) => t.id === tabId);
    const target = tabs.find((t) => t.id === targetId);
    if (!source || !target) return;
    const block = subtreeIds(tabs.filter((t) => t.windowId === source.windowId), tabId);
    if (block.includes(targetId)) return;
    const newParent = position === 'inside' ? targetId : target.parentId;
    if (source.windowId !== target.windowId) {
      await chrome.tabs.move(block, { windowId: target.windowId, index: -1 });
      for (const id of block) if (state.cache[id]) state.cache[id].windowId = target.windowId;
      tabs = await treeTabs();
    }
    const winTabs = tabs.filter((t) => t.windowId === target.windowId);
    const current = winTabs.map((t) => t.id);
    const rest = current.filter((id) => !block.includes(id));
    let at;
    if (position === 'before') {
      at = rest.indexOf(targetId);
    } else {
      const sub = subtreeIds(winTabs.filter((t) => !block.includes(t.id)), targetId);
      at = rest.indexOf(sub.at(-1)) + 1;
    }
    rest.splice(at, 0, ...block);
    for (const m of planMoves(current, rest)) await chrome.tabs.move(m.id, { index: m.index });
    // A moved tab joins the group of the tab it was dropped on (or leaves groups for an
    // ungrouped target), so grouping follows the tree instead of Chromium's index rules.
    const targetGroup = (await chrome.tabs.get(targetId)).groupId;
    if (targetGroup >= 0) await chrome.tabs.group({ tabIds: block, groupId: targetGroup });
    else await chrome.tabs.ungroup(block).catch(() => {});
    state.nodes[tabId].parentId = newParent ?? null;
    if (position === 'inside') state.nodes[targetId].collapsed = false;
    await save();
  },

  // Keyboard reordering: up/down among siblings, indent under the previous sibling, outdent past the parent.
  async shift({ tabId, direction }) {
    const tabs = await treeTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return false;
    const siblings = tabs.filter((t) => t.windowId === tab.windowId && t.parentId === tab.parentId);
    const i = siblings.findIndex((t) => t.id === tabId);
    const plan = {
      up: i > 0 && [siblings[i - 1]?.id, 'before'],
      down: i < siblings.length - 1 && [siblings[i + 1]?.id, 'after'],
      indent: i > 0 && [siblings[i - 1]?.id, 'inside'],
      outdent: tab.parentId != null && [tab.parentId, 'after'],
    }[direction];
    if (!plan) return false;
    await handlers.move({ tabId, targetId: plan[0], position: plan[1] });
    return true;
  },

  async newTab({ windowId, parentId = null }) {
    const props = { windowId, active: true };
    if (parentId != null) {
      const tabs = (await treeTabs()).filter((t) => t.windowId === windowId);
      const last = subtreeIds(tabs, parentId).at(-1);
      props.index = tabs.find((t) => t.id === last).index + 1;
      state.nodes[parentId].collapsed = false;
    }
    await createTab(props, parentId);
    await save();
  },

  async reopen({ key, windowId }) {
    const settings = await getSettings();
    const closed = await getClosed(settings);
    const entry = closed.find((c) => c.key === key);
    if (!entry) return;
    const tabs = await treeTabs();
    const parent = tabs.find((t) => t.id === entry.parentId);
    const originalOpen = tabs.some((t) => t.windowId === entry.windowId);
    const win = parent?.windowId ?? (originalOpen ? entry.windowId : windowId);
    const props = { url: entry.url, windowId: win, active: true };
    if (parent) {
      const winTabs = tabs.filter((t) => t.windowId === win);
      const last = subtreeIds(winTabs, parent.id).at(-1);
      props.index = winTabs.find((t) => t.id === last).index + 1;
      state.nodes[parent.id].collapsed = false;
    } else if (win === entry.windowId) {
      props.index = Math.min(entry.index ?? 0, tabs.filter((t) => t.windowId === win).length);
    }
    await createTab(props, parent?.id ?? null);
    await chrome.windows.update(win, { focused: true });
    await chrome.storage.local.set({ closed: closed.filter((c) => c.key !== key) });
    await save();
  },

  async forgetClosed({ key }) {
    const { closed = [] } = await chrome.storage.local.get('closed');
    await chrome.storage.local.set({ closed: closed.filter((c) => c.key !== key) });
    broadcast();
  },

  async clearClosed() {
    await chrome.storage.local.set({ closed: [] });
    broadcast();
  },

  async saveSnapshot({ name, scope, windowId }) {
    const settings = await getSettings();
    const tabs = await treeTabs();
    const info = await groupInfo();
    const windows = [...groupByWindow(tabs)]
      .filter(([id]) => scope === 'all' || id === windowId)
      .map(([, w]) => captureWindow(w.filter((t) => recordable(t.url, settings)), info))
      .filter((w) => w.tabs.length);
    if (!windows.length) throw new Error('There are no web pages to save here.');
    const snapshot = {
      id: crypto.randomUUID(),
      name: name?.trim() || new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      windows,
    };
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    await chrome.storage.local.set({ snapshots: [snapshot, ...snapshots] });
    broadcast();
    return snapshot.name;
  },

  async getSnapshot({ id }) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const snap = snapshots.find((s) => s.id === id);
    if (!snap) throw new Error('That snapshot no longer exists.');
    return snap;
  },

  // Replaces a snapshot's tabs with what's open now, keeping its name and creation date.
  async overwriteSnapshot({ id, windowId }) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const snap = snapshots.find((s) => s.id === id);
    if (!snap) throw new Error('That snapshot no longer exists.');
    const settings = await getSettings();
    const scope = snap.windows.length > 1 ? 'all' : 'window';
    const info = await groupInfo();
    const windows = [...groupByWindow(await treeTabs())]
      .filter(([wid]) => scope === 'all' || wid === windowId)
      .map(([, w]) => captureWindow(w.filter((t) => recordable(t.url, settings)), info))
      .filter((w) => w.tabs.length);
    if (!windows.length) throw new Error('There are no web pages to save here.');
    Object.assign(snap, { windows, updatedAt: Date.now() });
    await chrome.storage.local.set({ snapshots });
    broadcast();
    return snap.name;
  },

  async renameSnapshot({ id, name }) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const snap = snapshots.find((s) => s.id === id);
    if (!snap || !name?.trim()) return;
    snap.name = name.trim();
    await chrome.storage.local.set({ snapshots });
    broadcast();
  },

  async deleteSnapshot({ id }) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    await chrome.storage.local.set({ snapshots: snapshots.filter((s) => s.id !== id) });
    broadcast();
  },

  // mode: 'replace' | 'new' | 'merge' | 'windows'
  async restoreSnapshot({ id, mode, windowId }) {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const snap = snapshots.find((s) => s.id === id);
    if (!snap) throw new Error('That snapshot no longer exists.');
    const undo = { tabs: [], windows: [], reopen: null };
    if (mode === 'windows') {
      for (const w of snap.windows) undo.windows.push(await openInNewWindow(w.tabs, w.groups));
    } else if (mode === 'new') {
      undo.windows.push(await openInNewWindow(concatWindows(snap.windows), concatGroups(snap.windows)));
    } else {
      const before = (await treeTabs()).filter((t) => t.windowId === windowId);
      const beforeCapture = captureWindow(before, await groupInfo());
      undo.tabs = await openEntries(concatWindows(snap.windows), windowId, undefined, concatGroups(snap.windows));
      if (undo.tabs.length) await chrome.tabs.update(undo.tabs[0], { active: true });
      if (mode === 'replace' && undo.tabs.length) {
        undo.reopen = { windowId, entries: beforeCapture.tabs, groups: beforeCapture.groups || [] };
        before.forEach((t) => suppressClosed.add(t.id));
        await chrome.tabs.remove(before.map((t) => t.id));
      }
    }
    await chrome.storage.session.set({ undo });
    await save();
  },

  async undoRestore() {
    const { undo } = await chrome.storage.session.get('undo');
    if (!undo) return;
    if (undo.reopen) {
      const win = await chrome.windows.get(undo.reopen.windowId).catch(() => null);
      if (win) await openEntries(undo.reopen.entries, win.id, 0, undo.reopen.groups);
      else await openInNewWindow(undo.reopen.entries, undo.reopen.groups);
    }
    const live = new Set((await chrome.tabs.query({})).map((t) => t.id));
    const tabIds = undo.tabs.filter((id) => live.has(id));
    tabIds.forEach((id) => suppressClosed.add(id));
    if (tabIds.length) await chrome.tabs.remove(tabIds);
    for (const w of undo.windows) await chrome.windows.remove(w).catch(() => {});
    await chrome.storage.session.remove('undo');
    await save();
  },

  // Tab groups are Chromium's own (chrome.tabGroups), so they stay in sync with the tab strip.
  // Acting on a tab acts on its subtree, which keeps branches together.
  async groupCreate({ tabId, title = '', color }) {
    const tabs = await treeTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return null;
    const tabIds = subtreeIds(tabs.filter((t) => t.windowId === tab.windowId), tabId);
    const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId: tab.windowId } });
    const props = { title };
    if (color) props.color = color;
    await chrome.tabGroups.update(groupId, props);
    broadcast();
    return groupId;
  },

  async groupAdd({ tabId, groupId }) {
    const tabs = await treeTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const group = await chrome.tabGroups.get(groupId);
    let tabIds = subtreeIds(tabs.filter((t) => t.windowId === tab.windowId), tabId);
    if (group.windowId !== tab.windowId) {
      await chrome.tabs.move(tabIds, { windowId: group.windowId, index: -1 });
      for (const id of tabIds) if (state.cache[id]) state.cache[id].windowId = group.windowId;
    }
    await chrome.tabs.group({ tabIds, groupId });
    broadcast();
  },

  async groupRemoveTab({ tabId }) {
    const tabs = await treeTabs();
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;
    await chrome.tabs.ungroup(subtreeIds(tabs.filter((t) => t.windowId === tab.windowId), tabId));
    broadcast();
  },

  async groupUpdate({ groupId, title, color, collapsed }) {
    const props = {};
    if (title !== undefined) props.title = title;
    if (color !== undefined) props.color = color;
    if (collapsed !== undefined) props.collapsed = collapsed;
    await chrome.tabGroups.update(groupId, props);
    broadcast();
  },

  async groupNewTab({ groupId }) {
    const group = await chrome.tabGroups.get(groupId);
    const members = await chrome.tabs.query({ groupId });
    const last = Math.max(...members.map((t) => t.index));
    const tab = await createTab({ windowId: group.windowId, index: last + 1, active: true });
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
    if (group.collapsed) await chrome.tabGroups.update(groupId, { collapsed: false });
    await save();
  },

  async groupUngroup({ groupId }) {
    const members = await chrome.tabs.query({ groupId });
    if (members.length) await chrome.tabs.ungroup(members.map((t) => t.id));
    broadcast();
  },

  async groupClose({ groupId }) {
    const members = await chrome.tabs.query({ groupId });
    if (members.length) await chrome.tabs.remove(members.map((t) => t.id));
  },

  async groupMoveToWindow({ groupId }) {
    const win = await chrome.windows.create({ focused: true });
    const blank = win.tabs?.[0]?.id;
    await chrome.tabGroups.move(groupId, { windowId: win.id, index: -1 });
    const members = await chrome.tabs.query({ groupId });
    for (const t of members) if (state.cache[t.id]) state.cache[t.id].windowId = win.id;
    if (blank != null) await chrome.tabs.remove(blank).catch(() => {});
    dropCrossWindowParents();
    await save();
  },

  async setHoudini({ on }) {
    await chrome.storage.local.set({ houdini: !!on });
    await setHoudiniBadge(!!on);
    broadcast();
  },

  async setSettings({ patch }) {
    const settings = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings });
    broadcast();
    return settings;
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  run(async () => {
    await load();
    return handler(msg);
  }).then(
    (result) => respond({ ok: true, result }),
    (err) => respond({ ok: false, error: String(err?.message || err) }),
  );
  return true;
});

chrome.tabs.onCreated.addListener((tab) =>
  run(async () => {
    await load();
    if (claimed.delete(tab.id)) {
      remember(tab);
    } else {
      const opener = tab.openerTabId;
      const fresh = !state.nodes[tab.id] || state.nodes[tab.id].parentId == null;
      const sameWindow = opener != null && state.cache[opener]?.windowId === tab.windowId;
      if (fresh) state.nodes[tab.id] = { parentId: sameWindow && !tab.pinned ? opener : null, collapsed: false };
      remember(tab);
    }
    await save();
  }),
);

chrome.tabs.onUpdated.addListener((tabId, change, tab) =>
  run(async () => {
    await load();
    remember(tab);
    if ('url' in change || 'title' in change || 'pinned' in change) await save();
    else broadcast();
  }),
);

chrome.tabs.onMoved.addListener((tabId) =>
  run(async () => {
    await load();
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) remember(tab);
    broadcast();
  }),
);

chrome.tabs.onActivated.addListener(() => broadcast());
for (const ev of ['onCreated', 'onUpdated', 'onRemoved', 'onMoved']) chrome.tabGroups[ev].addListener(() => broadcast());
chrome.windows.onRemoved.addListener(() => broadcast());

chrome.tabs.onAttached.addListener((tabId, info) =>
  run(async () => {
    await load();
    if (state.cache[tabId]) state.cache[tabId].windowId = info.newWindowId;
    dropCrossWindowParents();
    await save();
  }),
);

chrome.tabs.onRemoved.addListener((tabId, info) =>
  run(async () => {
    await load({ keep: tabId });
    const node = state.nodes[tabId];
    const tab = state.cache[tabId];
    if (tab && !info.isWindowClosing && !suppressClosed.delete(tabId)) {
      const settings = await getSettings();
      if (recordable(tab.url, settings)) {
        const closed = await getClosed(settings);
        closed.unshift({
          key: `${Date.now().toString(36)}-${tabId}`,
          url: tab.url,
          title: tab.title,
          windowId: tab.windowId,
          index: tab.index,
          parentId: node?.parentId ?? null,
          closedAt: Date.now(),
        });
        await chrome.storage.local.set({ closed: closed.slice(0, MAX_CLOSED) });
      }
    }
    for (const child of Object.values(state.nodes)) if (child.parentId === tabId) child.parentId = node?.parentId ?? null;
    delete state.nodes[tabId];
    delete state.cache[tabId];
    await save();
  }),
);

// Houdini mode removes each visit as it lands. A first visit removes the URL outright; a
// repeat visit removes only that moment, so history from before stays untouched.
chrome.history.onVisited.addListener(async (item) => {
  const { houdini } = await chrome.storage.local.get('houdini');
  if (!houdini) return;
  if (item.visitCount <= 1) {
    await chrome.history.deleteUrl({ url: item.url });
  } else {
    const at = item.lastVisitTime ?? Date.now();
    await chrome.history.deleteRange({ startTime: at - 1, endTime: at + 1 });
  }
});

// The panel floats over the page as a rounded overlay. Pages that refuse injected scripts
// (chrome://, the Web Store, the new-tab page) get a small standalone window docked to the
// same side instead, which, unlike the toolbar popup, stays open while tabs move.
async function togglePanel(tab) {
  if (!tab?.id) return;
  // The shortcut pressed inside Grove's own panel window closes it, rather than opening a
  // panel for the panel.
  // (Compared by extension id: with use_dynamic_url, runtime.getURL may return the
  // randomized origin rather than the one this window was opened with.)
  if ((tab.url || tab.pendingUrl || '').startsWith(`chrome-extension://${chrome.runtime.id}/panel.html`)) {
    await chrome.windows.remove(tab.windowId).catch(() => {});
    return;
  }
  try {
    if (!/^(https?|file):/.test(tab.url || '')) throw new Error('restricted page');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js'] });
  } catch {
    await togglePanelWindow(tab.windowId);
  }
}

async function togglePanelWindow(browserWindowId) {
  const { panelWindows = {} } = await chrome.storage.local.get('panelWindows');
  const existing = panelWindows[browserWindowId];
  if (existing && (await chrome.windows.get(existing).catch(() => null))) {
    await chrome.windows.remove(existing);
    return;
  }
  const settings = await getSettings();
  const parent = await chrome.windows.get(browserWindowId);
  const width = 400;
  const height = Math.max(420, Math.min(660, (parent.height ?? 760) - 110));
  const left = settings.side === 'left' ? (parent.left ?? 0) + 12 : (parent.left ?? 0) + (parent.width ?? 1200) - width - 12;
  const win = await chrome.windows.create({
    url: `panel.html?mode=window&for=${browserWindowId}`,
    type: 'popup',
    width,
    height,
    left: Math.max(0, left),
    top: (parent.top ?? 0) + 90,
    focused: true,
  });
  panelWindows[browserWindowId] = win.id;
  await chrome.storage.local.set({ panelWindows });
}

// Panel windows close with the browser window they belong to.
chrome.windows.onRemoved.addListener(async (closedId) => {
  const { panelWindows = {} } = await chrome.storage.local.get('panelWindows');
  let changed = false;
  for (const [browserId, panelId] of Object.entries(panelWindows)) {
    if (+browserId === closedId) chrome.windows.remove(panelId).catch(() => {});
    if (+browserId === closedId || panelId === closedId) {
      delete panelWindows[browserId];
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ panelWindows });
});
globalThis.groveTogglePanel = togglePanel; // for tests/e2e.mjs

chrome.action.onClicked.addListener((tab) => togglePanel(tab));

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'toggle-panel') {
    tab ??= (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    await togglePanel(tab);
  } else if (command === 'toggle-houdini') {
    run(async () => {
      const { houdini } = await chrome.storage.local.get('houdini');
      await handlers.setHoudini({ on: !houdini });
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'prune-closed') run(async () => getClosed(await getSettings()).then(broadcast));
});

// Reloading or updating Grove unloads its panel page, and Chromium leaves the panel window
// open with a New Tab page in it. Close those leftovers (ids are kept in storage.local so
// they survive the reload; after a browser restart they simply no longer exist).
async function closeOrphanedPanelWindows() {
  const { panelWindows = {} } = await chrome.storage.local.get('panelWindows');
  for (const id of Object.values(panelWindows)) {
    const win = await chrome.windows.get(id, { populate: true }).catch(() => null);
    const stillPanel = win?.tabs?.some((t) => (t.url || t.pendingUrl || '').startsWith(`chrome-extension://${chrome.runtime.id}/panel.html`));
    if (win?.type === 'popup' && !stillPanel) await chrome.windows.remove(id).catch(() => {});
  }
  await chrome.storage.local.remove('panelWindows');
}

globalThis.groveCloseOrphans = closeOrphanedPanelWindows; // for tests/e2e.mjs

chrome.runtime.onInstalled.addListener(() => {
  closeOrphanedPanelWindows();
  chrome.alarms.create('prune-closed', { periodInMinutes: 30 });
  run(() => load());
  setHoudiniBadge();
});

// Restored tabs can trickle in after startup, so match the saved tree again shortly after,
// and hold off overwriting it until the session has settled.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove('panelWindows');
  holdPersistUntil = Date.now() + 10000;
  run(() => load());
  setTimeout(() => run(() => reconcile(true)), 5000);
  setHoudiniBadge();
});
