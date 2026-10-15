import { buildForest, flatten, searchTabs, formatRemaining, describeRemaining } from './lib/tree.js';

const $ = (id) => document.getElementById(id);
const treeEl = $('tree');
const treeView = $('tree-view');
const searchEl = $('search');
const emptyEl = $('empty');
const liveEl = $('live');

let state = null;
let windowId = null;
let query = '';
let focusKey = null; // roving-tabindex row
let rows = [];
let dragId = null;
let dropTarget = null;
let snapshotsSig = '';
let pendingRefresh = false;

// Modes: 'overlay' is a rounded iframe injected into the page (overlay.js); 'window' is a
// small standalone window used on pages Chromium won't let extensions draw on; no mode is
// the toolbar popup. Overlay and window fill their container; the popup has a fixed size.
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
document.documentElement.classList.toggle('fill', mode === 'overlay' || mode === 'window');

// Mac keyboards have no Delete-forward key (their "delete" is Backspace), no Menu key, and
// say ⌥/⌘ rather than Alt/Ctrl, so a few bindings and the footer hints adapt.
const isMac = /Mac/i.test(navigator.userAgentData?.platform || navigator.platform || '');
if (isMac) {
  for (const k of document.querySelectorAll('[data-mac]')) k.textContent = k.dataset.mac;
}

function dismiss() {
  if (mode === 'overlay') parent.postMessage({ grove: 'close' }, '*');
  else window.close();
}

// The standalone window serves the browser window it was opened from, not itself.
async function resolveWindowId() {
  if (mode !== 'window') return (await chrome.windows.getCurrent()).id;
  const target = Number(params.get('for'));
  const win = await chrome.windows.get(target).catch(() => null);
  return win ? win.id : (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
}

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || 'Grove did not respond.');
  return res.result;
}

function announce(text) {
  liveEl.textContent = '';
  setTimeout(() => (liveEl.textContent = text), 30);
}

let toastTimer = null;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

async function act(fn, done) {
  try {
    const result = await fn();
    if (done) announce(typeof done === 'function' ? done(result) : done);
  } catch (err) {
    toast(err.message);
    announce(err.message);
  }
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = state?.settings.theme || 'system';
  document.documentElement.dataset.theme = theme === 'system' ? (darkQuery.matches ? 'ink' : 'paper') : theme;
}
darkQuery.addEventListener('change', applyTheme);

async function refresh() {
  if (dragId != null) {
    pendingRefresh = true;
    return;
  }
  state = await send('getState', { windowId });
  applyTheme();
  render();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refresh().catch(console.error), 30);
}

const faviconUrl = (pageUrl) =>
  `${chrome.runtime.getURL('/_favicon/')}?pageUrl=${encodeURIComponent(pageUrl || 'about:blank')}&size=16`;

function svg(name) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  el.append(use);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('aria-') || k.startsWith('data-') || k === 'role' || k === 'title') node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children.filter(Boolean));
  return node;
}

const ghostTab = (c) => ({
  id: `c:${c.key}`,
  ghost: true,
  title: c.title || c.url,
  url: c.url,
  parentId: c.parentId,
  remaining: c.remaining,
});

function countDescendants(roots) {
  const counts = new Map();
  const walk = (node) => {
    let n = 0;
    for (const child of node.children) n += 1 + walk(child);
    counts.set(node.tab.id, n);
    return n;
  };
  roots.forEach(walk);
  return counts;
}

function render() {
  $('houdini').setAttribute('aria-pressed', String(state.houdini));
  $('houdini-banner').hidden = !state.houdini;
  $('show-closed').checked = state.settings.showClosed;
  $('all-windows').checked = state.settings.allWindows;
  $('dock-left').checked = state.settings.side === 'left';
  // A compositor hook (see README) floats and docks this window by its title: the side,
  // then the browser window's active tab title so it can find which window to dock into.
  if (mode === 'window') {
    const home = state.windows.find((w) => w.id === windowId);
    const anchor = home?.tabs.find((t) => t.active)?.title || '';
    document.title = `Grove panel (${state.settings.side})${anchor ? ` · ${anchor}` : ''}`;
  }
  $('undo-bar').hidden = !state.canUndo || !!detailId;
  const tabTotal = state.windows.reduce((n, w) => n + w.tabs.length, 0);
  $('tab-count').textContent = tabTotal || '';
  $('snap-count').textContent = state.snapshots.length || '';
  $('foot-status').textContent = `${tabTotal} tab${tabTotal === 1 ? '' : 's'}`;
  $('foot-status').title = [
    `${tabTotal} open`,
    state.windows.length > 1 && `${state.windows.length} windows`,
    state.closed.length && `${state.closed.length} recently closed`,
  ].filter(Boolean).join(' · ');
  renderSnapshots();

  const hadFocus = treeEl.contains(document.activeElement);
  treeEl.replaceChildren();
  rows = [];
  const shown = new Set(state.windows.map((w) => w.id));
  const multi = state.windows.length > 1;
  let matchCount = 0;

  state.windows.forEach((win, w) => {
    // Ghosts sit in their original window; if that window is gone they land in this one.
    const ghosts = state.closed.filter((c) => c.windowId === win.id || (win.id === windowId && !shown.has(c.windowId)));
    let items = [...win.tabs, ...ghosts.map(ghostTab)];
    let matched = null;
    if (query) ({ tabs: items, matched } = searchTabs(items, query));
    if (!items.length) return;
    if (matched) matchCount += matched.size;
    const forest = buildForest(items);
    const counts = countDescendants(forest);
    const label = win.id === windowId ? 'This window' : `Window ${w + 1}`;
    const group = el('div', { class: 'win-group', role: 'group', 'aria-label': `${label}, ${win.tabs.length} tabs` });
    if (multi) group.append(el('div', { class: 'win-head', 'aria-hidden': 'true' }, svg('window'), `${label} · ${win.tabs.length}`));
    // Chromium tab groups: a header row opens each run of consecutive rows in one group, and
    // those rows sit in a body with the group's colour rail. A collapsed group hides its rows.
    const groupsById = new Map((win.groups || []).map((g) => [g.id, g]));
    const runs = new Map();
    let body = group;
    let open = null;
    for (const row of flatten(forest, { expandAll: !!query })) {
      const gid = groupsById.has(row.tab.groupId) ? row.tab.groupId : -1;
      if (gid !== (open?.id ?? -1)) {
        open = gid >= 0 ? groupsById.get(gid) : null;
        body = group;
        if (open) {
          const run = (runs.get(gid) || 0) + 1;
          runs.set(gid, run);
          const members = win.tabs.filter((t) => t.groupId === gid).length;
          const head = renderGroupHead(open, members, !!query, run === 1 ? `g:${gid}` : `g:${gid}:${run}`);
          head.dataset.win = String(win.id);
          rows.push(head);
          group.append(head);
          body = el('div', { class: 'group-body', role: 'group', 'aria-label': `Tabs in ${open.title || 'unnamed group'}` });
          body.style.setProperty('--gc', groupColor(open.color));
          group.append(body);
        }
      }
      if (open?.collapsed && !query) continue;
      const node = renderRow(row, matched, counts.get(row.tab.id));
      node.dataset.win = String(win.id);
      rows.push(node);
      body.append(node);
    }
    treeEl.append(group);
  });

  emptyEl.hidden = rows.length > 0;
  emptyEl.textContent = query ? 'No tabs match your search.' : 'No tabs to show.';
  if (query) announceSearch(matchCount);

  if (!rows.some((r) => r.dataset.key === focusKey)) {
    const preferred = query
      ? rows.find((r) => !r.classList.contains('dim'))
      : rows.find((r) => r.getAttribute('aria-selected') === 'true');
    focusKey = (preferred || rows[0])?.dataset.key ?? null;
  }
  markCursor();
  if (hadFocus) rowByKey(focusKey)?.focus();
  if (pendingGroupEdit != null) {
    const head = rows.find((r) => r.dataset.group === String(pendingGroupEdit));
    if (head) {
      const id = pendingGroupEdit;
      pendingGroupEdit = null;
      focusKey = head.dataset.key;
      markCursor({ scroll: true });
      openGroupEditor(id, head);
    }
  }
}

const groupColor = (color) => `var(--g-${color || 'grey'})`;
const isGroup = (row) => row?.dataset.key.startsWith('g:');
let pendingGroupEdit = null;

function renderGroupHead(g, members, searching, key) {
  const expanded = searching || !g.collapsed;
  const name = g.title || 'Unnamed group';
  const head = el('div', {
    class: 'row group-head',
    role: 'treeitem',
    'data-key': key,
    'data-group': String(g.id),
    'aria-level': 1,
    'aria-expanded': String(expanded),
    'aria-selected': 'false',
    'aria-label': `Group ${name}, ${members} tab${members === 1 ? '' : 's'}${expanded ? '' : ', collapsed'}`,
    title: `${name}: click to ${expanded ? 'collapse' : 'expand'}, right-click to edit`,
  });
  head.id = `row-${key.replace(/[^\w-]/g, '_')}`;
  head.style.setProperty('--gc', groupColor(g.color));
  head.append(
    el('button', { class: 'twisty', type: 'button', tabIndex: -1, 'aria-hidden': 'true' }, svg('twisty')),
    el('span', { class: 'group-dot', 'aria-hidden': 'true' }),
    el('span', { class: `title group-name${g.title ? '' : ' unnamed'}`, text: name }),
    el('span', { class: 'count', 'aria-hidden': 'true', text: String(members) }),
    el('button', { class: 'group-more', type: 'button', tabIndex: -1, 'aria-hidden': 'true', title: 'Edit group' }, svg('more')),
  );
  return head;
}

function toggleGroup(head, collapsed) {
  const groupId = +head.dataset.group;
  collapsed ??= head.getAttribute('aria-expanded') === 'true';
  return act(() => send('groupUpdate', { groupId, collapsed }), collapsed ? 'Group collapsed' : 'Group expanded');
}

// The cursor is the row keyboard commands act on. It follows focus inside the tree, and
// while typing in the search box it's driven by the arrow keys (aria-activedescendant).
function markCursor({ scroll = false } = {}) {
  for (const r of rows) {
    const on = r.dataset.key === focusKey;
    r.tabIndex = on ? 0 : -1;
    r.classList.toggle('cursor', on);
    if (on && scroll) r.scrollIntoView({ block: 'nearest' });
  }
  const cursor = rowByKey(focusKey);
  if (cursor) searchEl.setAttribute('aria-activedescendant', cursor.id);
  else searchEl.removeAttribute('aria-activedescendant');
}

function moveCursor(delta) {
  if (!rows.length) return;
  const i = rows.findIndex((r) => r.dataset.key === focusKey);
  const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + delta))];
  focusKey = next.dataset.key;
  markCursor({ scroll: true });
}

let searchAnnounceTimer = null;
function announceSearch(n) {
  clearTimeout(searchAnnounceTimer);
  searchAnnounceTimer = setTimeout(() => announce(n === 1 ? '1 matching tab' : `${n} matching tabs`), 400);
}

function renderRow({ tab, depth, hasChildren, expanded, posinset, setsize }, matched, hidden) {
  const row = el('div', {
    class: 'row',
    role: 'treeitem',
    'data-key': String(tab.id),
    'aria-level': depth + 1,
    'aria-posinset': posinset,
    'aria-setsize': setsize,
    'aria-selected': String(!!tab.active),
  });
  row.id = `row-${String(tab.id).replace(/[^\w-]/g, '_')}`;
  row.style.setProperty('--depth', depth);
  if (hasChildren) row.setAttribute('aria-expanded', String(expanded));
  row.classList.toggle('ghost', !!tab.ghost);
  row.classList.toggle('dim', !!matched && !matched.has(tab.id));
  row.classList.toggle('discarded', !!tab.discarded);
  row.classList.toggle('loading', !!tab.loading);

  const title = tab.title || tab.url || 'Untitled';
  const extras = [];
  if (tab.pinned) extras.push('pinned');
  if (tab.audible) extras.push(tab.muted ? 'muted' : 'playing audio');
  if (tab.discarded) extras.push('sleeping');
  if (hasChildren && !expanded) extras.push(`${hidden} hidden`);
  if (tab.ghost) extras.push(`closed, ${describeRemaining(tab.remaining)}`);
  row.setAttribute('aria-label', [title, ...extras].join(', '));
  row.title = tab.url && tab.url !== title ? `${title}\n${tab.url}` : title;

  const parts = [
    tab.ghost
      ? el('span', { class: 'handle', 'aria-hidden': 'true' })
      : el('span', { class: 'handle', draggable: true, title: 'Drag to move', 'aria-hidden': 'true' }, svg('grip')),
    hasChildren
      ? el('button', { class: 'twisty', type: 'button', tabIndex: -1, 'aria-hidden': 'true' }, svg('twisty'))
      : el('span', { class: 'spacer' }),
    el('img', { class: 'fav', src: faviconUrl(tab.url), alt: '', draggable: false }),
    el('span', { class: 'title', text: title }),
    hasChildren && !expanded && el('span', { class: 'count', 'aria-hidden': 'true', text: String(hidden) }),
    tab.pinned && el('span', { class: 'flag', 'aria-hidden': 'true' }, svg('pin')),
    tab.audible && el('span', { class: 'flag', 'aria-hidden': 'true' }, svg(tab.muted ? 'muted' : 'sound')),
    tab.ghost &&
      el('span', { class: 'clock', 'aria-hidden': 'true', title: describeRemaining(tab.remaining) }, svg('clock'), formatRemaining(tab.remaining)),
    !tab.ghost && el('button', { class: 'row-more', type: 'button', tabIndex: -1, 'aria-hidden': 'true', title: 'More actions' }, svg('more')),
    el(
      'button',
      { class: 'close', type: 'button', tabIndex: -1, 'aria-hidden': 'true', title: tab.ghost ? 'Forget' : 'Close tab (Shift: with children)' },
      svg('x'),
    ),
  ];
  row.append(...parts.filter(Boolean));
  return row;
}

const rowByKey = (key) => rows.find((r) => r.dataset.key === key);
const isGhost = (row) => row.dataset.key.startsWith('c:');

function focusRow(row) {
  if (!row) return;
  focusKey = row.dataset.key;
  markCursor({ scroll: true });
  row.focus();
}

function activateRow(row) {
  if (isGroup(row)) return toggleGroup(row);
  if (isGhost(row)) {
    return act(() => send('reopen', { key: row.dataset.key.slice(2), windowId }), 'Tab reopened');
  }
  return act(async () => {
    // Only tabs in another browser window need that window focused (which also moves the
    // pointer on tiling compositors); switching within the panel's window never does.
    await send('activate', { tabId: +row.dataset.key, focus: +row.dataset.win !== windowId });
    if (mode !== 'window') dismiss(); // the standalone window stays until you close it
  });
}

function closeRow(row, withChildren = false) {
  if (isGroup(row)) return; // closing a whole group lives in its editor, never on a stray Delete
  const i = rows.indexOf(row);
  const next = rows[i + 1] || rows[i - 1];
  if (row.dataset.key === focusKey && next) focusKey = next.dataset.key;
  if (isGhost(row)) return act(() => send('forgetClosed', { key: row.dataset.key.slice(2) }), 'Removed from recently closed');
  return act(() => send('close', { tabId: +row.dataset.key, withChildren }), withChildren ? 'Closed tab and its children' : 'Tab closed');
}

function toggleRow(row, collapsed) {
  if (isGroup(row)) return toggleGroup(row, collapsed);
  if (!row.hasAttribute('aria-expanded')) return;
  return act(() => send('toggleCollapse', { tabId: +row.dataset.key, collapsed }), collapsed ? 'Collapsed' : 'Expanded');
}

treeEl.addEventListener('click', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  if (isGroup(row)) {
    if (e.target.closest('.group-more')) openGroupEditor(+row.dataset.group, row);
    else toggleGroup(row);
    return;
  }
  if (e.target.closest('.row-more')) return openTabMenu(row, e.target.closest('.row-more'));
  if (e.target.closest('.close')) closeRow(row, e.shiftKey);
  else if (e.target.closest('.twisty')) toggleRow(row, row.getAttribute('aria-expanded') === 'true');
  else activateRow(row);
});

treeEl.addEventListener('auxclick', (e) => {
  const row = e.target.closest('.row');
  if (row && e.button === 1) {
    e.preventDefault();
    closeRow(row, e.shiftKey);
  }
});

treeEl.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row');
  if (!row || isGhost(row)) return;
  e.preventDefault();
  focusKey = row.dataset.key;
  markCursor();
  if (isGroup(row)) openGroupEditor(+row.dataset.group, row);
  else openTabMenu(row, { left: e.clientX, top: e.clientY, bottom: e.clientY });
});

treeEl.addEventListener('focusin', (e) => {
  const row = e.target.closest('.row');
  if (row) focusKey = row.dataset.key;
});

const SHIFT_KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'outdent', ArrowRight: 'indent' };
const SHIFT_SAID = { up: 'Moved up', down: 'Moved down', indent: 'Indented', outdent: 'Outdented' };

treeEl.addEventListener('keydown', (e) => {
  const row = e.target.closest('.row');
  if (!row) return;
  const i = rows.indexOf(row);
  const level = +row.getAttribute('aria-level');
  const expanded = row.getAttribute('aria-expanded');
  const go = (target) => {
    e.preventDefault();
    focusRow(target);
  };

  if (e.altKey && SHIFT_KEYS[e.key]) {
    e.preventDefault();
    shiftRow(row, SHIFT_KEYS[e.key]);
    return;
  }
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    if (isGroup(row)) openGroupEditor(+row.dataset.group, row);
    else openTabMenu(row, row);
    return;
  }
  if (isGroup(row) && e.key === 'n') {
    e.preventDefault();
    return act(() => send('groupNewTab', { groupId: +row.dataset.group }), 'New tab in group');
  }
  if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !isGroup(row) && !isGhost(row)) {
    e.preventDefault();
    return newGroupFor(+row.dataset.key);
  }

  switch (e.key) {
    case 'ArrowDown':
      return go(rows[i + 1]);
    case 'ArrowUp':
      return go(rows[i - 1]);
    case 'Home':
      return go(rows[0]);
    case 'End':
      return go(rows.at(-1));
    case 'ArrowRight':
      e.preventDefault();
      if (expanded === 'false') toggleRow(row, false);
      else if (expanded === 'true') focusRow(rows[i + 1]);
      return;
    case 'ArrowLeft':
      e.preventDefault();
      if (expanded === 'true') return toggleRow(row, true);
      for (let j = i - 1; j >= 0; j--) if (+rows[j].getAttribute('aria-level') < level) return focusRow(rows[j]);
      return;
    case 'Enter':
    case ' ':
      e.preventDefault();
      return activateRow(row);
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      return closeRow(row, e.shiftKey);
    case 'n':
      if (e.altKey || e.ctrlKey || e.metaKey || isGhost(row)) break;
      e.preventDefault();
      return act(() => send('newTab', { windowId, parentId: +row.dataset.key }), 'New child tab');
    case '/':
      e.preventDefault();
      searchEl.focus();
      return;
  }
  // Any other printable key starts a search.
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) searchEl.focus();
});

function shiftRow(row, direction) {
  if (!row || isGhost(row) || isGroup(row)) return;
  act(() => send('shift', { tabId: +row.dataset.key, direction }), (moved) => (moved ? SHIFT_SAID[direction] : "Can't move further"));
}

function setQuery(value) {
  searchEl.value = value;
  if (value.trim() !== query) focusKey = null; // re-pick: first match, or the active tab
  query = value.trim();
  $('search-hint').hidden = !!value;
  $('search-clear').hidden = !value;
  render();
}

searchEl.addEventListener('input', () => setQuery(searchEl.value));
$('search-clear').hidden = true;
$('search-clear').addEventListener('click', () => {
  setQuery('');
  searchEl.focus();
});

// Command-palette keys: focus stays in the search box while these act on the cursor row.
searchEl.addEventListener('keydown', (e) => {
  const cursor = rowByKey(focusKey);
  const caretAtEnd = searchEl.selectionStart === searchEl.value.length && searchEl.selectionEnd === searchEl.value.length;
  if (e.altKey && SHIFT_KEYS[e.key]) {
    e.preventDefault();
    shiftRow(cursor, SHIFT_KEYS[e.key]);
  } else if (cursor && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) {
    e.preventDefault();
    if (isGroup(cursor)) openGroupEditor(+cursor.dataset.group, cursor);
    else openTabMenu(cursor, cursor);
  } else if (cursor && e.altKey && (e.key === 'g' || e.key === 'G') && !isGroup(cursor) && !isGhost(cursor)) {
    e.preventDefault();
    newGroupFor(+cursor.dataset.key);
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveCursor(e.key === 'ArrowDown' ? 1 : -1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (cursor) activateRow(cursor);
  } else if (cursor && isMac && e.key === 'Backspace' && e.metaKey) {
    // ⌘⌫ is the Mac stand-in for Delete-at-end (it would otherwise clear the whole line).
    e.preventDefault();
    closeRow(cursor, e.shiftKey);
  } else if (e.key === 'Delete' && caretAtEnd && cursor) {
    // Delete has nothing to remove at the end of the text, so it closes the cursor tab.
    e.preventDefault();
    closeRow(cursor, e.shiftKey);
  } else if (e.key === 'Escape' && searchEl.value) {
    e.preventDefault();
    e.stopPropagation();
    setQuery('');
  }
});

// Drag and drop: only the grip starts a drag. Top quarter drops before, bottom quarter
// after, the middle makes it a child. Near the edges the list scrolls.
function clearDrop() {
  if (dropTarget) delete dropTarget.row.dataset.drop;
  dropTarget = null;
}

function autoScroll(y) {
  const box = treeView.getBoundingClientRect();
  if (y < box.top + 36) treeView.scrollBy(0, -10);
  else if (y > box.bottom - 36) treeView.scrollBy(0, 10);
}

treeEl.addEventListener('dragstart', (e) => {
  const row = e.target.closest('.row');
  if (!row || !e.target.closest('.handle') || isGhost(row)) {
    e.preventDefault();
    return;
  }
  dragId = +row.dataset.key;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', row.dataset.key);
  e.dataTransfer.setDragImage(row, 20, 14);
  row.classList.add('dragging');
});

treeEl.addEventListener('dragover', (e) => {
  if (dragId == null) return;
  autoScroll(e.clientY);
  const row = e.target.closest('.row');
  if (!row || isGhost(row) || +row.dataset.key === dragId) {
    clearDrop();
    return;
  }
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (isGroup(row)) {
    // Dropping on a group header adds the tab (and its children) to that group.
    if (dropTarget?.row !== row) {
      clearDrop();
      row.dataset.drop = 'inside';
      dropTarget = { row, position: 'group' };
    }
    return;
  }
  const box = row.getBoundingClientRect();
  const y = (e.clientY - box.top) / box.height;
  let position = y < 0.25 ? 'before' : y > 0.75 ? 'after' : 'inside';
  if (position === 'after' && row.getAttribute('aria-expanded') === 'true') position = 'inside';
  if (dropTarget?.row !== row || dropTarget.position !== position) {
    clearDrop();
    row.dataset.drop = position;
    dropTarget = { row, position };
  }
});

treeEl.addEventListener('drop', (e) => {
  e.preventDefault();
  const target = dropTarget;
  const tabId = dragId;
  clearDrop();
  if (!target || tabId == null) return;
  if (target.position === 'group') {
    const name = target.row.querySelector('.group-name').textContent;
    act(() => send('groupAdd', { tabId, groupId: +target.row.dataset.group }), `Added to ${name}`);
    return;
  }
  const said = { before: 'Moved above', after: 'Moved below', inside: 'Moved inside' }[target.position];
  act(() => send('move', { tabId, targetId: +target.row.dataset.key, position: target.position }), `${said} ${target.row.querySelector('.title').textContent}`);
});

treeEl.addEventListener('dragend', () => {
  clearDrop();
  rows.forEach((r) => r.classList.remove('dragging'));
  dragId = null;
  if (pendingRefresh) {
    pendingRefresh = false;
    scheduleRefresh();
  }
});

// Toolbar
$('new-tab').addEventListener('click', () => act(() => send('newTab', { windowId })));

$('houdini').addEventListener('click', () => {
  const on = !state.houdini;
  act(() => send('setHoudini', { on }), on ? 'Houdini mode on. New visits stay out of history.' : 'Houdini mode off');
});

$('collapse-all').addEventListener('click', () => act(() => send('setCollapsedAll', { windowId, collapsed: true }), 'Collapsed all'));
$('expand-all').addEventListener('click', () => act(() => send('setCollapsedAll', { windowId, collapsed: false }), 'Expanded all'));

const menu = document.querySelector('.menu');
menu.addEventListener('click', (e) => {
  const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
  if (!cmd) return;
  menu.open = false;
  if (cmd === 'clear-closed') act(() => send('clearClosed'), 'Cleared recently closed tabs');
  if (cmd === 'settings') {
    chrome.runtime.openOptionsPage();
    dismiss();
  }
});
document.addEventListener('click', (e) => {
  if (menu.open && !menu.contains(e.target)) menu.open = false;
});
$('show-closed').addEventListener('change', (e) => act(() => send('setSettings', { patch: { showClosed: e.target.checked } })));
$('all-windows').addEventListener('change', (e) => act(() => send('setSettings', { patch: { allWindows: e.target.checked } })));
$('dock-left').addEventListener('change', (e) =>
  act(() => send('setSettings', { patch: { side: e.target.checked ? 'left' : 'right' } }), e.target.checked ? 'Panel docked left' : 'Panel docked right'));

// Escape peels back one layer at a time: menu, then search (handled on the input), then the panel.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  e.preventDefault();
  if (!popEl.hidden) {
    closePopover();
  } else if (menu.open) {
    menu.open = false;
    menu.querySelector('summary').focus();
  } else if (detailId) {
    closeDetail();
  } else {
    dismiss();
  }
});

// View switch (Tab Tree / Snapshots), a roving-tabindex tablist.
const viewTabs = [$('tab-tree'), $('tab-sessions')];
function showView(sessions, focusPanel = true) {
  viewTabs.forEach((tab, i) => {
    const selected = (i === 1) === sessions;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  $('tree-pane').hidden = sessions;
  $('sessions-view').hidden = !sessions;
  if (focusPanel) (sessions ? $('snap-name') : searchEl).focus();
}
viewTabs.forEach((tab, i) => {
  tab.addEventListener('click', () => showView(i === 1));
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    showView(i === 0, false);
    viewTabs[i === 0 ? 1 : 0].focus();
  });
});

$('save-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('snap-name').value;
  act(async () => {
    const saved = await send('saveSnapshot', { name, scope: $('snap-scope').value, windowId });
    $('snap-name').value = '';
    toast(`Saved “${saved}”`);
    return saved;
  }, (saved) => `Saved snapshot ${saved}`);
});

$('undo').addEventListener('click', () => act(() => send('undoRestore'), 'Restore undone'));

// Popover: the tab context menu and the group editor share one floating surface.
const popEl = $('popover');
let popReturn = null;

function closePopover({ restoreFocus = true } = {}) {
  if (popEl.hidden) return;
  popEl.hidden = true;
  popEl.replaceChildren();
  if (restoreFocus) (popReturn?.isConnected ? popReturn : searchEl).focus();
  popReturn = null;
}

function openPopover(children, anchor, { role = 'menu', label }) {
  if (!popEl.hidden) closePopover({ restoreFocus: false });
  popReturn = document.activeElement;
  popEl.replaceChildren(...children.filter(Boolean));
  popEl.setAttribute('role', role);
  popEl.setAttribute('aria-label', label);
  popEl.hidden = false;
  const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
  const { offsetWidth: w, offsetHeight: h } = popEl;
  const left = Math.max(8, Math.min(r.left + (anchor instanceof Element ? 24 : 0), innerWidth - w - 8));
  let top = r.bottom + 4;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 4);
  popEl.style.left = `${left}px`;
  popEl.style.top = `${top}px`;
  (popEl.querySelector('[data-autofocus]') || popEl.querySelector('[role=menuitem]'))?.focus();
}

function menuItem(icon, label, onSelect, { dot } = {}) {
  const item = el('button', { class: 'menu-item', type: 'button', role: 'menuitem' },
    dot ? el('span', { class: 'menu-dot', 'aria-hidden': 'true' }) : icon ? svg(icon) : el('span', { class: 'menu-dot blank' }),
    el('span', { text: label }));
  if (dot) item.querySelector('.menu-dot').style.setProperty('--gc', groupColor(dot));
  item.addEventListener('click', () => {
    closePopover();
    onSelect();
  });
  return item;
}

popEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closePopover();
    return;
  }
  const items = [...popEl.querySelectorAll('[role=menuitem]')];
  const i = items.indexOf(document.activeElement);
  if (i < 0 || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End')) return;
  e.preventDefault();
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  items[(next + items.length) % items.length].focus();
});

document.addEventListener('pointerdown', (e) => {
  if (!popEl.hidden && !popEl.contains(e.target)) closePopover({ restoreFocus: false });
});

function windowOf(row) {
  return state.windows.find((w) => w.id === +row.dataset.win);
}

function openTabMenu(row, anchor) {
  if (!row || isGhost(row) || isGroup(row)) return;
  const tabId = +row.dataset.key;
  const win = windowOf(row);
  const tab = win?.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  const others = (win.groups || []).filter((g) => g.id !== tab.groupId);
  openPopover([
    menuItem('group-add', 'Add to new group', () => newGroupFor(tabId)),
    ...others.map((g) => menuItem(null, `Add to ${g.title || 'unnamed group'}`, () =>
      act(() => send('groupAdd', { tabId, groupId: g.id }), `Added to ${g.title || 'unnamed group'}`), { dot: g.color })),
    tab.groupId >= 0 && menuItem('ungroup', 'Remove from group', () => act(() => send('groupRemoveTab', { tabId }), 'Removed from group')),
    el('hr'),
    menuItem('plus', 'New child tab', () => act(() => send('newTab', { windowId: win.id, parentId: tabId }), 'New child tab')),
    menuItem('x', 'Close tab', () => closeRow(row)),
    row.hasAttribute('aria-expanded') && menuItem('x', 'Close tab and children', () => closeRow(row, true)),
  ], anchor, { label: `Actions for ${tab.title}` });
}

function newGroupFor(tabId) {
  return act(async () => {
    pendingGroupEdit = await send('groupCreate', { tabId });
    scheduleRefresh();
  }, 'New group created. Type a name.');
}

const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

function openGroupEditor(groupId, anchor) {
  const g = state.windows.flatMap((w) => w.groups || []).find((x) => x.id === groupId);
  if (!g) return;
  const input = el('input', { class: 'field-input', value: g.title || '', placeholder: 'Name this group', 'aria-label': 'Group name', 'data-autofocus': '' });
  let timer = null;
  const saveName = () => {
    clearTimeout(timer);
    return send('groupUpdate', { groupId, title: input.value.trim() }).catch(() => {});
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(saveName, 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveName().then(() => closePopover());
    }
  });
  const swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Group colour' });
  const pick = (btn) => {
    for (const b of swatches.children) {
      b.setAttribute('aria-checked', String(b === btn));
      b.tabIndex = b === btn ? 0 : -1;
    }
    send('groupUpdate', { groupId, color: btn.dataset.color }).catch(() => {});
  };
  for (const color of GROUP_COLORS) {
    const b = el('button', { class: 'swatch', type: 'button', role: 'radio', 'data-color': color, 'aria-label': color, title: color[0].toUpperCase() + color.slice(1), 'aria-checked': String(g.color === color) });
    b.tabIndex = g.color === color ? 0 : -1;
    b.style.setProperty('--gc', groupColor(color));
    b.addEventListener('click', () => pick(b));
    swatches.append(b);
  }
  swatches.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const list = [...swatches.children];
    const next = list[(list.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length];
    next.focus();
    pick(next);
  });
  openPopover([
    el('div', { class: 'pop-pad' }, input, swatches),
    el('hr'),
    menuItem('plus', 'New tab in group', () => act(() => send('groupNewTab', { groupId }), 'New tab in group')),
    menuItem('window', 'Move group to new window', () => act(() => send('groupMoveToWindow', { groupId }), 'Group moved to a new window')),
    menuItem('x', 'Close group', () => act(() => send('groupClose', { groupId }), 'Group closed')),
    el('hr'),
    menuItem('ungroup', 'Ungroup', () => act(() => send('groupUngroup', { groupId }), 'Ungrouped')),
  ], anchor, { role: 'dialog', label: `Edit group ${g.title || ''}`.trim() });
  input.select();
}

const MODES = [
  ['replace', 'Replace this window'],
  ['new', 'Open in new window'],
  ['merge', 'Add to this window'],
  ['windows', 'Restore original windows'],
];

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function chip(icon, text, title = text) {
  return el('span', { class: 'chip', title }, svg(icon), el('span', { text }));
}

function snapChips({ tabCount, windowCount, createdAt, updatedAt }) {
  return el('div', { class: 'chips' },
    chip('tabs', plural(tabCount, 'tab')),
    chip('window', plural(windowCount, 'window')),
    chip('calendar', `Created ${fmtDate(createdAt)}`, `Created ${fmtDateTime(createdAt)}`),
    chip('clock', `Updated ${fmtDate(updatedAt)}`, `Updated ${fmtDateTime(updatedAt)}`));
}

function modeSelect(s) {
  const modes = MODES.filter(([m]) => m !== 'windows' || s.windowCount > 1);
  const preferred = modes.some(([m]) => m === state.settings.restoreMode) ? state.settings.restoreMode : 'new';
  return el('select', { class: 'field-input', 'aria-label': `Restore mode for ${s.name}` },
    ...modes.map(([value, label]) => el('option', { value, text: label, selected: value === preferred })));
}

function restoreButton(s, select) {
  const btn = el('button', { class: 'btn primary', type: 'button' }, svg('restore'), 'Restore');
  btn.addEventListener('click', () =>
    act(() => send('restoreSnapshot', { id: s.id, mode: select.value, windowId }), `Restored ${s.name}`));
  return btn;
}

// Destructive buttons need a second press within three seconds.
function armed(btn, label, run) {
  let timer = null;
  const idle = btn.getAttribute('aria-label');
  btn.addEventListener('click', () => {
    if (!timer) {
      btn.classList.add('armed');
      btn.setAttribute('aria-label', `Press again to ${label}`);
      btn.title = `Press again to ${label}`;
      announce(`Press again to ${label}`);
      timer = setTimeout(() => {
        timer = null;
        btn.classList.remove('armed');
        btn.setAttribute('aria-label', idle);
        btn.title = idle;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    timer = null;
    btn.classList.remove('armed');
    run();
  });
  return btn;
}

function startRename(s, nameEl, focusAfter) {
  const input = el('input', { class: 'field-input', value: s.name, 'aria-label': 'New name' });
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit && input.value.trim() && input.value.trim() !== s.name) {
      act(() => send('renameSnapshot', { id: s.id, name: input.value }), 'Renamed');
    } else {
      input.replaceWith(nameEl);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
      focusAfter.focus();
    }
  });
  input.addEventListener('blur', () => finish(true));
}

function renderSnapshots() {
  const sig = JSON.stringify([state.snapshots, state.settings.restoreMode]);
  if (sig === snapshotsSig) return;
  snapshotsSig = sig;
  if (detailId) openDetail(detailId, { keepFocus: true });
  const list = $('snap-list');
  if (!state.snapshots.length) {
    list.replaceChildren(el('li', { class: 'snap-empty', text: 'No snapshots yet. Save your open tabs above to restore them later.' }));
    return;
  }
  list.replaceChildren(
    ...state.snapshots.map((s) => {
      const name = el('span', { class: 'snap-name', text: s.name, title: s.name });
      const view = el('button', { class: 'tool', type: 'button', 'aria-label': `View tabs in ${s.name}`, title: 'View tabs' }, svg('eye'));
      view.addEventListener('click', () => openDetail(s.id));
      const rename = el('button', { class: 'tool', type: 'button', 'aria-label': `Rename ${s.name}`, title: 'Rename' }, svg('edit'));
      rename.addEventListener('click', () => startRename(s, name, rename));
      const del = el('button', { class: 'tool danger', type: 'button', 'aria-label': `Delete ${s.name}`, title: 'Delete' }, svg('trash'));
      armed(del, `delete ${s.name}`, () => act(() => send('deleteSnapshot', { id: s.id }), `Deleted ${s.name}`));

      const select = modeSelect(s);
      const scope = s.windowCount > 1 ? 'all open windows' : 'this window';
      const overwrite = el('button', { class: 'btn', type: 'button', 'aria-label': `Overwrite with ${scope}`, title: `Overwrite with ${scope}` }, svg('save'), 'Overwrite');
      armed(overwrite, `overwrite ${s.name} with ${scope}`, () =>
        act(() => send('overwriteSnapshot', { id: s.id, windowId }), `Updated ${s.name}`));

      return el('li', { class: 'snap' },
        el('div', { class: 'snap-head' }, name, el('div', { class: 'snap-icons' }, view, rename, del)),
        snapChips(s),
        el('div', { class: 'snap-actions' }, select, overwrite, restoreButton(s, select)));
    }),
  );
}

// Details: every tab in a snapshot, grouped by window and indented by tree depth.
let detailId = null;
let detailReturn = null;

function showDetail(open) {
  $('snap-detail').hidden = !open;
  $('save-form').hidden = open;
  $('snap-list').hidden = open;
  if (open) $('undo-bar').hidden = true;
  else $('undo-bar').hidden = !state.canUndo;
}

async function openDetail(id, { keepFocus = false } = {}) {
  let snap;
  try {
    snap = await send('getSnapshot', { id });
  } catch {
    return closeDetail(); // deleted meanwhile
  }
  if (!keepFocus) detailReturn = document.activeElement;
  detailId = id;
  const meta = state.snapshots.find((s) => s.id === id) || {
    tabCount: snap.windows.reduce((n, w) => n + w.tabs.length, 0),
    windowCount: snap.windows.length,
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt || snap.createdAt,
  };
  const back = el('button', { class: 'tool', type: 'button', 'aria-label': 'Back to snapshots', title: 'Back' }, svg('back'));
  back.addEventListener('click', closeDetail);

  const sections = snap.windows.map((w, i) => {
    const items = w.tabs.map((t, j) => ({ ...t, id: j, parentId: t.parent }));
    const rowsEls = flatten(buildForest(items), { expandAll: true }).map(({ tab, depth }) => {
      const row = el('button', { class: 'detail-row', type: 'button', title: `${tab.title || tab.url}\n${tab.url}\nClick to open in a new tab` },
        el('img', { class: 'fav', src: faviconUrl(tab.url), alt: '' }),
        el('span', { class: 'detail-text' },
          el('span', { class: 'detail-title', text: tab.title || tab.url }),
          el('span', { class: 'detail-url', text: tab.url })),
        tab.pinned && el('span', { class: 'badge-pin' }, svg('pin'), 'Pinned'),
        tab.group != null && w.groups?.[tab.group] && (() => {
          const g = w.groups[tab.group];
          const tag = el('span', { class: 'group-tag', title: `Group: ${g.title || 'unnamed'}`, text: g.title || 'Group' });
          tag.style.setProperty('--gc', groupColor(g.color));
          return tag;
        })());
      row.style.setProperty('--depth', depth);
      row.addEventListener('click', () => act(() => send('openUrl', { url: tab.url, windowId }), `Opened ${tab.title || tab.url}`));
      return el('li', {}, row);
    });
    const label = snap.windows.length > 1 ? `Window ${i + 1}` : 'Tabs';
    return el('section', { class: 'detail-win', 'aria-label': `${label}, ${plural(w.tabs.length, 'tab')}` },
      el('h3', { text: `${label} · ${plural(w.tabs.length, 'tab')}` }),
      el('ul', { class: 'detail-list' }, ...rowsEls));
  });

  const select = modeSelect({ ...meta, name: snap.name });
  $('snap-detail').replaceChildren(
    el('div', { class: 'detail-head' }, back, el('h2', { id: 'detail-title', text: snap.name, title: snap.name })),
    snapChips(meta),
    ...sections,
    el('div', { class: 'detail-foot' }, select, restoreButton({ ...meta, id, name: snap.name }, select)),
  );
  $('snap-detail').setAttribute('aria-labelledby', 'detail-title');
  showDetail(true);
  if (!keepFocus) back.focus();
}

function closeDetail() {
  if (!detailId) return;
  detailId = null;
  showDetail(false);
  if (detailReturn?.isConnected) detailReturn.focus();
  else $('snap-name').focus();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'changed') scheduleRefresh();
});
setInterval(scheduleRefresh, 60000); // keeps the closed-tab clocks current

(async () => {
  windowId = await resolveWindowId();
  await refresh();
  searchEl.focus();
})();
