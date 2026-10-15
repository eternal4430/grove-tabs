import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeParents, buildForest, flatten, subtreeIds, searchTabs, hostMatches,
  planMoves, toEntries, concatWindows, concatGroups, captureWindow, matchSaved, formatRemaining,
} from '../lib/tree.js';

const t = (id, parentId = null, extra = {}) => ({ id, parentId, title: `tab ${id}`, url: `https://s${id}.test/`, ...extra });

test('sanitizeParents breaks cycles, self links and dangling parents', () => {
  const out = sanitizeParents([t(1, 2), t(2, 1), t(3, 3), t(4, 99), t(5, 1)]);
  assert.deepEqual(out.map((x) => x.parentId), [null, null, null, null, 1]);
});

test('buildForest and flatten honour order and collapse', () => {
  const tabs = [t(1), t(2, 1), t(3, 2), t(4, 1, { collapsed: true }), t(5, 4), t(6)];
  const rows = flatten(buildForest(tabs));
  assert.deepEqual(rows.map((r) => [r.tab.id, r.depth]), [[1, 0], [2, 1], [3, 2], [4, 1], [6, 0]]);
  assert.equal(rows[3].hasChildren, true);
  assert.equal(rows[3].expanded, false);
  assert.deepEqual(rows.map((r) => r.posinset), [1, 1, 1, 2, 2]);
  const all = flatten(buildForest(tabs), { expandAll: true });
  assert.ok(all.some((r) => r.tab.id === 5));
});

test('subtreeIds returns the tab and descendants in tree order', () => {
  const tabs = [t(1), t(2, 1), t(3), t(4, 2), t(5, 1)];
  assert.deepEqual(subtreeIds(tabs, 1), [1, 2, 4, 5]);
  assert.deepEqual(subtreeIds(tabs, 3), [3]);
  assert.deepEqual(subtreeIds(tabs, 42), []);
});

test('searchTabs keeps ancestors of matches', () => {
  const tabs = [t(1), t(2, 1, { title: 'Rust book' }), t(3, null, { title: 'rust playground' }), t(4)];
  const { tabs: kept, matched } = searchTabs(tabs, 'RUST');
  assert.deepEqual(kept.map((x) => x.id), [1, 2, 3]);
  assert.deepEqual([...matched], [2, 3]);
  assert.deepEqual(searchTabs(tabs, 'rust book').tabs.map((x) => x.id), [1, 2]);
  assert.deepEqual(searchTabs(tabs, 's4.test').tabs.map((x) => x.id), [4]);
});

test('hostMatches handles subdomains and messy patterns', () => {
  const p = ['example.com', '*.foo.org', 'https://bar.net/path', '  '];
  assert.ok(hostMatches('https://example.com/x', p));
  assert.ok(hostMatches('https://a.b.example.com/', p));
  assert.ok(!hostMatches('https://notexample.com/', p));
  assert.ok(hostMatches('http://foo.org/', p));
  assert.ok(hostMatches('https://bar.net/', p));
  assert.ok(!hostMatches('chrome://newtab/', p));
  assert.ok(!hostMatches('not a url', p));
});

test('planMoves reaches the desired order', () => {
  const apply = (cur, moves) => {
    const a = cur.slice();
    for (const m of moves) { a.splice(a.indexOf(m.id), 1); a.splice(m.index, 0, m.id); }
    return a;
  };
  const cases = [
    [[1, 2, 3, 4, 5], [3, 4, 1, 2, 5]],
    [[1, 2, 3, 4, 5], [1, 5, 2, 3, 4]],
    [[1, 2, 3], [1, 2, 3]],
    [[1, 2, 3, 4], [4, 3, 2, 1]],
  ];
  for (const [cur, want] of cases) assert.deepEqual(apply(cur, planMoves(cur, want)), want);
  assert.equal(planMoves([1, 2, 3], [1, 2, 3]).length, 0);
});

test('toEntries and concatWindows keep parent links', () => {
  const e1 = toEntries([t(10), t(11, 10), t(12, 11)]);
  const e2 = toEntries([t(20), t(21, 20)]);
  assert.deepEqual(e1.map((e) => e.parent), [null, 0, 1]);
  assert.deepEqual(concatWindows([{ tabs: e1 }, { tabs: e2 }]).map((e) => e.parent), [null, 0, 1, null, 3]);
});

test('matchSaved relinks by URL order and picks the best window', () => {
  const saved = [
    [{ url: 'a', parent: null }, { url: 'b', parent: 0 }],
    [{ url: 'x', parent: null }, { url: 'y', parent: 0, collapsed: true }, { url: 'y', parent: 1 }, { url: 'z', parent: null }],
  ];
  const live = [{ id: 7, url: 'x' }, { id: 8, url: 'y' }, { id: 9, url: 'y' }, { id: 10, url: 'new' }];
  const m = matchSaved(live, saved);
  assert.deepEqual(m.get(7), { parentId: null, collapsed: false });
  assert.deepEqual(m.get(8), { parentId: 7, collapsed: true });
  assert.deepEqual(m.get(9), { parentId: 8, collapsed: false });
  assert.equal(m.has(10), false);
  assert.equal(matchSaved([{ id: 1, url: 'q' }], saved).size, 0);
});

test('formatRemaining', () => {
  assert.equal(formatRemaining(null), '∞');
  assert.equal(formatRemaining(5 * 60000), '5m');
  assert.equal(formatRemaining(3 * 3600e3), '3h');
  assert.equal(formatRemaining(5 * 86400e3), '5d');
  assert.equal(formatRemaining(-1), '0m');
});

test('captureWindow records tab groups; concatWindows/concatGroups keep them aligned', () => {
  const info = new Map([[5, { id: 5, title: 'Work', color: 'blue', collapsed: true }], [9, { id: 9, title: '', color: 'red' }]]);
  const w1 = captureWindow([t(1, null, { groupId: 5 }), t(2, 1, { groupId: 5 }), t(3, null, { groupId: -1 })], info);
  const w2 = captureWindow([t(4, null, { groupId: 9 }), t(6)], info);
  assert.deepEqual(w1.groups, [{ title: 'Work', color: 'blue', collapsed: true }]);
  assert.deepEqual(w1.tabs.map((e) => e.group), [0, 0, undefined]);
  assert.equal(captureWindow([t(7)], info).groups, undefined);
  const all = concatWindows([w1, w2]);
  assert.deepEqual(all.map((e) => e.group), [0, 0, undefined, 1, undefined]);
  assert.deepEqual(concatGroups([w1, w2]).map((g) => g.color), ['blue', 'red']);
});
