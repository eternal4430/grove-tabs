// Pure helpers shared by the service worker, the panel and the tests.
// A "tab" here is any object with an `id` and an optional `parentId`.

// Drops parent links that point at missing tabs, at the tab itself, or close a cycle.
// Only tabs inside a cycle lose their parent; tabs hanging off a cycle keep theirs.
export function sanitizeParents(tabs) {
  const byId = new Map(tabs.map((t) => [t.id, t]));
  return tabs.map((t) => {
    let parentId = byId.has(t.parentId) && t.parentId !== t.id ? t.parentId : null;
    const seen = new Set();
    for (let p = parentId; p != null && !seen.has(p); p = byId.get(p)?.parentId) {
      if (p === t.id) {
        parentId = null;
        break;
      }
      seen.add(p);
    }
    return parentId === t.parentId ? t : { ...t, parentId };
  });
}

// Tabs must already be in display order (browser index). Returns [{ tab, children }].
export function buildForest(tabs) {
  const clean = sanitizeParents(tabs);
  const byId = new Map(clean.map((t) => [t.id, { tab: t, children: [] }]));
  const roots = [];
  for (const t of clean) {
    const parent = t.parentId != null ? byId.get(t.parentId) : null;
    (parent ? parent.children : roots).push(byId.get(t.id));
  }
  return roots;
}

// Depth-first rows for rendering; children of collapsed tabs are skipped unless expandAll.
export function flatten(roots, { expandAll = false } = {}) {
  const rows = [];
  const walk = (nodes, depth) =>
    nodes.forEach((node, i) => {
      const hasChildren = node.children.length > 0;
      const expanded = hasChildren && (expandAll || !node.tab.collapsed);
      rows.push({ tab: node.tab, depth, hasChildren, expanded, posinset: i + 1, setsize: nodes.length });
      if (expanded) walk(node.children, depth + 1);
    });
  walk(roots, 0);
  return rows;
}

// The tab and all its descendants, parent first, in tree order.
export function subtreeIds(tabs, id) {
  const find = (nodes) => {
    for (const node of nodes) {
      if (node.tab.id === id) return node;
      const hit = find(node.children);
      if (hit) return hit;
    }
    return null;
  };
  const out = [];
  const visit = (node) => {
    out.push(node.tab.id);
    node.children.forEach(visit);
  };
  const node = find(buildForest(tabs));
  if (node) visit(node);
  return out;
}

// Matches every word against title + URL; keeps ancestors of matches so the tree stays intact.
export function searchTabs(tabs, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const clean = sanitizeParents(tabs);
  const byId = new Map(clean.map((t) => [t.id, t]));
  const matched = new Set();
  const keep = new Set();
  for (const t of clean) {
    const haystack = `${t.title || ''} ${t.url || ''}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    matched.add(t.id);
    for (let p = t.id; p != null && !keep.has(p); p = byId.get(p)?.parentId) keep.add(p);
  }
  return { tabs: clean.filter((t) => keep.has(t.id)), matched };
}

// "example.com" matches example.com and its subdomains; "*.", scheme and path are ignored.
export function hostMatches(url, patterns = []) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return patterns.some((raw) => {
    const p = String(raw)
      .trim()
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .replace(/^\*\./, '')
      .replace(/[/:].*$/, '');
    return p && (host === p || host.endsWith(`.${p}`));
  });
}

// Index moves that turn `current` into `desired`, applied one at a time left to right.
export function planMoves(current, desired) {
  const sim = current.slice();
  const moves = [];
  desired.forEach((id, i) => {
    if (sim[i] === id) return;
    sim.splice(sim.indexOf(id), 1);
    sim.splice(i, 0, id);
    moves.push({ id, index: i });
  });
  return moves;
}

// Snapshot entries: parent links become positions within the list.
export function toEntries(tabs) {
  const pos = new Map(tabs.map((t, i) => [t.id, i]));
  return tabs.map((t) => ({
    url: t.url,
    title: t.title || '',
    pinned: !!t.pinned,
    collapsed: !!t.collapsed,
    parent: pos.has(t.parentId) ? pos.get(t.parentId) : null,
  }));
}

// Joins several windows' entries into one list, shifting parent and group positions.
export function concatWindows(windows) {
  const out = [];
  let groupBase = 0;
  for (const w of windows) {
    const base = out.length;
    for (const e of w.tabs) {
      const shifted = { ...e, parent: e.parent == null ? null : e.parent + base };
      if (e.group != null) shifted.group = e.group + groupBase;
      out.push(shifted);
    }
    groupBase += w.groups?.length || 0;
  }
  return out;
}

// The tab groups of several windows in the order concatWindows numbers them.
export function concatGroups(windows) {
  return windows.flatMap((w) => w.groups || []);
}

// One window's tabs as snapshot entries plus its tab groups ({ title, color, collapsed });
// each grouped entry gets `group`, an index into `groups`.
export function captureWindow(tabs, groupInfo = new Map()) {
  const entries = toEntries(tabs);
  const groups = [];
  const index = new Map();
  tabs.forEach((t, i) => {
    const g = t.groupId >= 0 ? groupInfo.get(t.groupId) : null;
    if (!g) return;
    if (!index.has(g.id)) {
      index.set(g.id, groups.length);
      groups.push({ title: g.title || '', color: g.color, collapsed: !!g.collapsed });
    }
    entries[i].group = index.get(g.id);
  });
  return groups.length ? { tabs: entries, groups } : { tabs: entries };
}

// Re-links a window's tabs after a restart, when tab ids have changed, using the saved
// window that shares the most URLs and matching URLs in order.
export function matchSaved(windowTabs, savedWindows) {
  let best = null;
  let bestScore = 0;
  for (const saved of savedWindows) {
    const pool = new Map();
    for (const e of saved) pool.set(e.url, (pool.get(e.url) || 0) + 1);
    let score = 0;
    for (const t of windowTabs) {
      if (pool.get(t.url) > 0) {
        pool.set(t.url, pool.get(t.url) - 1);
        score++;
      }
    }
    if (score > bestScore) [best, bestScore] = [saved, score];
  }
  const result = new Map();
  if (!best) return result;
  const posToId = new Map();
  let cursor = 0;
  for (const t of windowTabs) {
    for (let j = cursor; j < best.length; j++) {
      if (best[j].url === t.url) {
        posToId.set(j, t.id);
        cursor = j + 1;
        break;
      }
    }
  }
  for (const [pos, id] of posToId) {
    const e = best[pos];
    result.set(id, {
      parentId: e.parent != null ? (posToId.get(e.parent) ?? null) : null,
      collapsed: !!e.collapsed,
    });
  }
  return result;
}

export function formatRemaining(ms) {
  if (ms == null) return '∞';
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function describeRemaining(ms) {
  if (ms == null) return 'kept until you remove it';
  const text = formatRemaining(ms);
  const unit = { m: 'minutes', h: 'hours', d: 'days' }[text.at(-1)];
  return `reopenable for ${text.slice(0, -1)} more ${unit}`;
}
