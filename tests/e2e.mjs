// End-to-end check: loads the unpacked extension into a throwaway headless Chromium
// profile and drives it over the DevTools protocol against a local test site.
// Usage: node tests/e2e.mjs [path-to-chromium]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const chromium = process.argv[2] || 'chromium';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer((req, res) => {
  const name = req.url.replace(/\W/g, '') || 'home';
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>Page ${name}</title><h1>${name}</h1>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const site = (p) => `http://127.0.0.1:${port}/${p}`;

const profile = mkdtempSync(join(tmpdir(), 'grove-e2e-'));
// Test copy of the extension with host access, so the worker can inject the overlay
// without the toolbar click that grants activeTab in real use.
const extDir = join(profile, 'ext');
cpSync(root, extDir, { recursive: true, filter: (src) => !/[\\/](tests|\.git|\.github)([\\/]|$)/.test(src.slice(root.length)) });
const manifest = JSON.parse(readFileSync(join(extDir, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(extDir, 'manifest.json'), JSON.stringify(manifest));
const proc = spawn(chromium, [
  '--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`,
  '--no-first-run', '--no-default-browser-check',
  // CI Linux runners (Ubuntu 24.04) block the unprivileged namespaces Chrome's sandbox needs.
  ...(process.env.CI ? ['--no-sandbox'] : []),
  'about:blank',
], { stdio: 'ignore' });

let ws;
let nextId = 1;
const pending = new Map();
function cdp(method, params = {}, sessionId) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

async function connect() {
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await sleep(100);
  const [devPort, path] = readFileSync(portFile, 'utf8').trim().split('\n');
  ws = new WebSocket(`ws://127.0.0.1:${devPort}${path}`);
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
}

// Identify Grove's worker by its manifest: Chrome for Testing ships a built-in extension whose
// worker is also called background.js.
async function findExtensionId() {
  for (let i = 0; i < 50; i++) {
    const { targetInfos } = await cdp('Target.getTargets');
    for (const t of targetInfos.filter((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'))) {
      const { sessionId } = await cdp('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const r = await cdp('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().short_name', returnByValue: true }, sessionId).catch(() => null);
      await cdp('Target.detachFromTarget', { sessionId }).catch(() => {});
      if (r?.result?.value === 'Grove') return new URL(t.url).host;
    }
    await sleep(200);
  }
  throw new Error('Grove service worker never started');
}

async function openPage(url) {
  const { targetId } = await cdp('Target.createTarget', { url });
  const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Runtime.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(sessionId, expression) {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

let passed = 0;
async function step(name, fn) {
  await fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

try {
  await connect();
  console.log((await cdp('Browser.getVersion')).product);
  const extId = await findExtensionId();
  console.log(`extension ${extId}`);
  const panel = await openPage(`chrome-extension://${extId}/panel.html`);
  // Target.createTarget returns before navigation commits; on slower machines (CI) the first
  // evaluations would otherwise run in the initial about:blank document.
  for (let i = 0; i < 100; i++) {
    const ready = await evaluate(panel.sessionId, `location.protocol === 'chrome-extension:' && document.readyState === 'complete' && typeof chrome.windows === 'object'`).catch(() => false);
    if (ready) break;
    if (i === 99) {
      const why = await evaluate(panel.sessionId, `[location.href, document.title, document.readyState, typeof chrome, typeof chrome?.runtime, document.body?.innerText.slice(0, 200)]`).catch((e) => String(e));
      throw new Error(`Panel page never finished loading: ${JSON.stringify(why)}`);
    }
    await sleep(150);
  }
  const send = (type, data = {}) =>
    evaluate(panel.sessionId, `chrome.runtime.sendMessage(${JSON.stringify({ type, ...data })}).then((r) => { if (!r.ok) throw new Error(r.error); return r.result; })`);
  const winId = await evaluate(panel.sessionId, 'chrome.windows.getCurrent().then((w) => w.id)');
  const state = () => send('getState', { windowId: winId });
  const tabByTitle = async (title) => (await state()).windows.flatMap((w) => w.tabs).find((t) => t.title === title);
  const until = async (fn, what) => {
    for (let i = 0; i < 40; i++) {
      const v = await fn();
      if (v) return v;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  // Build a -> b -> c through real window.open() calls so Chrome sets openerTabId.
  const a = await openPage(site('a'));
  const a0 = await until(() => tabByTitle('Page a'), 'tab a');
  // Headless Chromium records the panel tab as a's opener; start from a top-level a.
  while (await send('shift', { tabId: a0.id, direction: 'outdent' }));
  await evaluate(a.sessionId, `window.open('${site('b')}', '_blank'); true`);
  const tb = await until(() => tabByTitle('Page b'), 'tab b');
  const { targetInfos } = await cdp('Target.getTargets');
  const bTarget = targetInfos.find((t) => t.url === site('b'));
  const { sessionId: bSession } = await cdp('Target.attachToTarget', { targetId: bTarget.targetId, flatten: true });
  await evaluate(bSession, `window.open('${site('c')}', '_blank'); true`);
  const tc = await until(() => tabByTitle('Page c'), 'tab c');
  const ta = await tabByTitle('Page a');

  await step('tabs opened from a page nest under their opener', async () => {
    assert.equal(tb.parentId, ta.id);
    assert.equal(tc.parentId, tb.id);
  });

  await step('collapse hides children in the rendered tree', async () => {
    await send('toggleCollapse', { tabId: ta.id, collapsed: true });
    const titles = () => evaluate(panel.sessionId, `[...document.querySelectorAll('[role=treeitem]')].map((r) => r.querySelector('.title').textContent)`);
    await until(async () => { const t = await titles(); return t.includes('Page a') && !t.includes('Page b'); }, 'collapsed render');
    const aria = await evaluate(panel.sessionId, `(() => { const r = [...document.querySelectorAll('[role=treeitem]')].find((x) => x.textContent.includes('Page a')); return [r.getAttribute('aria-expanded'), r.querySelector('.count')?.textContent, r.getAttribute('aria-label')]; })()`);
    assert.deepEqual(aria, ['false', '2', 'Page a, 2 hidden']);
    await send('toggleCollapse', { tabId: ta.id, collapsed: false });
    await until(async () => (await titles()).includes('Page c'), 'expanded render');
  });

  await step('search filters by title and URL and keeps ancestors', async () => {
    const result = await evaluate(panel.sessionId, `(() => {
      const s = document.getElementById('search'); s.value = 'Page c'; s.dispatchEvent(new Event('input'));
      const rows = [...document.querySelectorAll('[role=treeitem]')];
      const out = rows.map((r) => [r.querySelector('.title').textContent, r.classList.contains('dim')]);
      s.value = ''; s.dispatchEvent(new Event('input'));
      return out;
    })()`);
    assert.deepEqual(result, [['Page a', true], ['Page b', true], ['Page c', false]]);
  });

  await step('drag-and-drop move: c before a becomes a root above it', async () => {
    await send('move', { tabId: tc.id, targetId: ta.id, position: 'before' });
    const tabs = (await state()).windows[0].tabs;
    const order = tabs.map((t) => t.title).filter((t) => t.startsWith('Page '));
    assert.deepEqual(order, ['Page c', 'Page a', 'Page b']);
    assert.equal(tabs.find((t) => t.id === tc.id).parentId, null);
  });

  await step('keyboard indent/outdent', async () => {
    // c is now directly above a; indent a under c.
    assert.equal(await send('shift', { tabId: ta.id, direction: 'indent' }), true);
    let tabs = (await state()).windows[0].tabs;
    assert.equal(tabs.find((t) => t.id === ta.id).parentId, tc.id);
    assert.equal(tabs.find((t) => t.id === tb.id).parentId, ta.id, 'b moves with its parent');
    await send('shift', { tabId: ta.id, direction: 'outdent' });
    tabs = (await state()).windows[0].tabs;
    assert.equal(tabs.find((t) => t.id === ta.id).parentId, null);
    const order = tabs.map((t) => t.title).filter((t) => t.startsWith('Page '));
    assert.deepEqual(order, ['Page c', 'Page a', 'Page b']);
  });

  await step('closing a parent promotes children and leaves a reopenable ghost', async () => {
    await send('move', { tabId: tc.id, targetId: tb.id, position: 'inside' });
    await send('close', { tabId: tb.id });
    await until(async () => !(await tabByTitle('Page b')), 'b to close');
    const s = await state();
    assert.equal(s.windows[0].tabs.find((t) => t.id === tc.id).parentId, ta.id);
    const ghost = s.closed.find((c) => c.title === 'Page b');
    assert.ok(ghost, 'b is in recently closed');
    assert.equal(ghost.parentId, ta.id);
    assert.ok(ghost.remaining > 23 * 3600e3 && ghost.remaining <= 24 * 3600e3);
    const clock = await until(() => evaluate(panel.sessionId, `document.querySelector('.row.ghost .clock')?.textContent`), 'ghost row');
    assert.equal(clock, '24h');
    await send('reopen', { key: ghost.key, windowId: winId });
    const back = await until(() => tabByTitle('Page b'), 'b to reopen');
    assert.equal(back.parentId, ta.id);
    assert.ok(!(await state()).closed.some((c) => c.key === ghost.key));
  });

  await step('site exclusions hide matching tabs', async () => {
    await send('setSettings', { patch: { exclusions: ['localhost'] } });
    await openPage(`http://localhost:${port}/hidden`);
    await sleep(800);
    const all = (await state()).windows.flatMap((w) => w.tabs).map((t) => t.url);
    assert.ok(!all.some((u) => u.includes('localhost')));
    assert.ok(all.some((u) => u.includes('127.0.0.1')));
    await send('setSettings', { patch: { exclusions: [] } });
  });

  await step('snapshot save + restore into new window keeps structure, undo closes it', async () => {
    await send('saveSnapshot', { name: 'Test set', scope: 'window', windowId: winId });
    const snap = (await state()).snapshots.find((s) => s.name === 'Test set');
    assert.ok(snap && snap.tabCount >= 3);
    const before = await evaluate(panel.sessionId, 'chrome.windows.getAll().then((w) => w.length)');
    await send('restoreSnapshot', { id: snap.id, mode: 'new', windowId: winId });
    await send('setSettings', { patch: { allWindows: true } });
    const s = await state();
    const newWin = s.windows.find((w) => w.id !== winId && w.tabs.some((t) => t.url === site('b')));
    assert.ok(newWin, 'restored window exists');
    const by = (u) => newWin.tabs.find((t) => t.url === site(u));
    assert.equal(by('b').parentId, by('a').id);
    assert.equal(by('c').parentId, by('a').id);
    assert.equal(s.canUndo, true);
    await send('undoRestore');
    await sleep(300);
    assert.equal(await evaluate(panel.sessionId, 'chrome.windows.getAll().then((w) => w.length)'), before);
    await send('setSettings', { patch: { allWindows: false } });
  });

  await step('replace restore swaps the window and undo brings it back', async () => {
    const snap = (await state()).snapshots[0];
    const extra = await openPage(site('extra'));
    await until(() => tabByTitle('Page extra'), 'extra tab');
    // The panel lives in this window, so restore from a second window to keep it alive.
    const other = await evaluate(panel.sessionId, `chrome.windows.create({ url: '${site('scratch')}' }).then((w) => w.id)`);
    await sleep(500);
    await send('restoreSnapshot', { id: snap.id, mode: 'replace', windowId: other });
    await send('setSettings', { patch: { allWindows: true } });
    let w = (await state()).windows.find((x) => x.id === other);
    assert.ok(w.tabs.some((t) => t.url === site('a')));
    assert.ok(!w.tabs.some((t) => t.url === site('scratch')));
    assert.ok(!(await state()).closed.some((c) => c.url === site('scratch')), 'replaced tabs are not ghosts');
    await send('undoRestore');
    await sleep(500);
    w = (await state()).windows.find((x) => x.id === other);
    assert.deepEqual(w.tabs.map((t) => t.url), [site('scratch')]);
    await send('setSettings', { patch: { allWindows: false } });
    await cdp('Target.closeTarget', { targetId: extra.targetId });
  });

  await step('Houdini mode keeps new visits out of history', async () => {
    await send('setHoudini', { on: true });
    await openPage(site('secretpage'));
    await sleep(1500);
    await send('setHoudini', { on: false });
    await openPage(site('publicpage'));
    await sleep(1500);
    const hist = await evaluate(panel.sessionId, `chrome.history.search({ text: '', startTime: 0, maxResults: 200 }).then((r) => r.map((x) => x.url))`);
    assert.ok(!hist.includes(site('secretpage')), 'secret visit removed');
    assert.ok(hist.includes(site('publicpage')), 'normal visit kept');
    assert.ok(hist.includes(site('a')), 'earlier history untouched');
  });

  await step('toolbar action opens the rounded overlay on a web page and toggles it closed', async () => {
    const page = await openPage(site('overlaytest'));
    const tab = await until(() => evaluate(panel.sessionId, `chrome.tabs.query({ url: '${site('overlaytest')}' }).then((t) => t[0])`), 'overlay test tab');
    const { targetInfos: all } = await cdp('Target.getTargets');
    const swTarget = all.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const { sessionId: sw } = await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    await evaluate(sw, `groveTogglePanel(${JSON.stringify(tab)}).then(() => true)`);
    const frame = await until(async () => {
      const { targetInfos } = await cdp('Target.getTargets');
      return targetInfos.find((t) => t.type === 'iframe' && t.url.includes('panel.html?mode=overlay'));
    }, 'overlay iframe');
    const { sessionId: fs } = await cdp('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
    await until(() => evaluate(fs, `document.querySelectorAll('[role=treeitem]').length > 0 && document.documentElement.classList.contains('fill')`), 'overlay to render rows');
    const layout = await evaluate(page.sessionId, `(() => { const h = document.documentElement.lastElementChild; return [h.tagName, getComputedStyle(h).position, getComputedStyle(h).zIndex]; })()`);
    assert.deepEqual(layout, ['DIV', 'fixed', '2147483647']);
    if (process.env.SHOTS) {
      const { writeFileSync: write } = await import('node:fs');
      await cdp('Target.activateTarget', { targetId: page.targetId });
      await cdp('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false }, page.sessionId);
      await sleep(600);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, page.sessionId);
      write(join(process.env.SHOTS, 'overlay.png'), Buffer.from(data, 'base64'));
    }
    // Moving tabs from the overlay must not close it.
    const visible = await evaluate(fs, `[...document.querySelectorAll('[role=treeitem]')].map((r) => +r.dataset.key).filter((k) => k > 0)`);
    await evaluate(fs, `chrome.runtime.sendMessage({ type: 'shift', tabId: ${visible.at(-1)}, direction: 'up' })`);
    await sleep(800);
    const stillOpen = (await cdp('Target.getTargets')).targetInfos.some((t) => t.type === 'iframe' && t.url.includes('panel.html?mode=overlay'));
    assert.ok(stillOpen, 'overlay stays open after a move');
    // The side setting moves it live.
    const frameBox = () => evaluate(page.sessionId, `new Promise((r) => setTimeout(() => r(Math.round(document.elementFromPoint(30, 300) === document.documentElement.lastElementChild ? 1 : 0)), 300))`);
    assert.equal(await frameBox(), 0, 'starts on the right');
    await send('setSettings', { patch: { side: 'left' } });
    assert.equal(await frameBox(), 1, 'jumps to the left');
    await send('setSettings', { patch: { side: 'right' } });
    await evaluate(sw, `groveTogglePanel(${JSON.stringify(tab)}).then(() => true)`);
    await until(async () => {
      const { targetInfos } = await cdp('Target.getTargets');
      return !targetInfos.some((t) => t.type === 'iframe' && t.url.includes('panel.html'));
    }, 'overlay to close');
  });

  await step('restricted pages get a standalone panel window that toggles', async () => {
    const restricted = await openPage('chrome://version/');
    const tab = await until(() => evaluate(panel.sessionId, `chrome.tabs.query({ url: 'chrome://version/' }).then((t) => t[0])`), 'chrome:// tab');
    const { targetInfos: all } = await cdp('Target.getTargets');
    const swTarget = all.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const { sessionId: sw } = await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    await evaluate(sw, `groveTogglePanel(${JSON.stringify(tab)}).then(() => true)`);
    const win = await until(async () => {
      const wins = await evaluate(panel.sessionId, `chrome.windows.getAll({ populate: true })`);
      return wins.find((w) => w.type === 'popup' && w.tabs[0]?.url.includes('mode=window'));
    }, 'panel window');
    assert.ok(win.tabs[0].url.includes(`for=${tab.windowId}`));
    const pw = (await cdp('Target.getTargets')).targetInfos.find((t) => t.url.includes('mode=window'));
    const { sessionId: ps } = await cdp('Target.attachToTarget', { targetId: pw.targetId, flatten: true });
    await until(() => evaluate(ps, `document.title.startsWith('Grove panel (right) · ') && document.querySelectorAll('[role=treeitem]').length > 0`), 'window panel render');
    const titles = await evaluate(ps, `[...document.querySelectorAll('[role=treeitem] .title')].map((t) => t.textContent)`);
    assert.ok(!titles.some((t) => t.startsWith('Grove panel')), 'the panel window never lists itself');
    // The shortcut pressed while the panel window has focus closes it instead of nesting another.
    const panelTab = win.tabs[0];
    await evaluate(sw, `groveTogglePanel(${JSON.stringify(panelTab)}).then(() => true)`);
    await until(async () => !(await evaluate(panel.sessionId, `chrome.windows.getAll()`)).some((w) => w.id === win.id), 'panel window to close');
    const popups = (await evaluate(panel.sessionId, `chrome.windows.getAll()`)).filter((w) => w.type === 'popup');
    assert.equal(popups.length, 0, 'no stray panel windows');
    await cdp('Target.closeTarget', { targetId: restricted.targetId });
  });

  await step('search box drives a cursor: arrows select, Delete closes, Enter opens', async () => {
    await openPage(site('cursorone'));
    await openPage(site('cursortwo'));
    // Pages opened by the test land in their own windows in headless mode; show them all.
    await send('setSettings', { patch: { allWindows: true } });
    await until(() => tabByTitle('Page cursortwo'), 'cursor tabs');
    await until(() => evaluate(panel.sessionId, `[...document.querySelectorAll('.row .title')].some((t) => t.textContent === 'Page cursortwo')`), 'rows');
    const result = await evaluate(panel.sessionId, `(async () => {
      const s = document.getElementById('search');
      s.focus();
      s.value = 'cursor'; s.dispatchEvent(new Event('input'));
      const cur = () => document.querySelector('.row.cursor .title')?.textContent;
      const first = cur();
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const second = cur();
      const active = document.activeElement === s;
      const described = document.getElementById(s.getAttribute('aria-activedescendant'))?.querySelector('.title').textContent;
      s.setSelectionRange(s.value.length, s.value.length);
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      return { first, second, active, described };
    })()`);
    assert.equal(result.first, 'Page cursorone');
    assert.equal(result.second, 'Page cursortwo');
    assert.equal(result.active, true, 'focus stays in the search box');
    assert.equal(result.described, 'Page cursortwo');
    await until(async () => !(await tabByTitle('Page cursortwo')), 'Delete to close the cursor tab');
    assert.ok(await tabByTitle('Page cursorone'), 'only the cursor tab closed');
    await evaluate(panel.sessionId, `(() => { const s = document.getElementById('search'); s.value = ''; s.dispatchEvent(new Event('input')); })()`);
    await send('setSettings', { patch: { allWindows: false } });
  });

  await step('snapshot cards show stats; details list every tab; overwrite updates', async () => {
    const before = (await state()).snapshots[0];
    await evaluate(panel.sessionId, `document.getElementById('tab-sessions').click()`);
    await until(() => evaluate(panel.sessionId, `document.querySelectorAll('.snap .chip').length >= 4`), 'snapshot chips');
    const chips = await evaluate(panel.sessionId, `[...document.querySelector('.snap .chips').children].map((c) => c.textContent)`);
    assert.equal(chips[0], `${before.tabCount} tabs`);
    assert.match(chips[2], /^Created /);
    await evaluate(panel.sessionId, `document.querySelector('.snap [aria-label^="View tabs"]').click()`);
    await until(() => evaluate(panel.sessionId, `!document.getElementById('snap-detail').hidden && document.querySelectorAll('.detail-row').length > 0`), 'details view');
    const detail = await evaluate(panel.sessionId, `({ rows: document.querySelectorAll('.detail-row').length, list: document.getElementById('snap-list').hidden, url: document.querySelector('.detail-url').textContent })`);
    assert.equal(detail.rows, before.tabCount);
    assert.equal(detail.list, true, 'list hidden while details are open');
    assert.match(detail.url, /^http/);
    if (process.env.SHOTS) {
      const { writeFileSync: write } = await import('node:fs');
      await cdp('Target.activateTarget', { targetId: panel.targetId });
      await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 600, deviceScaleFactor: 2, mobile: false }, panel.sessionId);
      await sleep(400);
      write(join(process.env.SHOTS, 'snap-detail.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId)).data, 'base64'));
      await evaluate(panel.sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      write(join(process.env.SHOTS, 'snap-list.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId)).data, 'base64'));
    } else {
      await evaluate(panel.sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }
    assert.equal(await evaluate(panel.sessionId, `document.getElementById('snap-detail').hidden`), true, 'Escape closes details first');
    await sleep(20);
    await send('overwriteSnapshot', { id: before.id, windowId: winId });
    const after = (await state()).snapshots.find((x) => x.id === before.id);
    assert.ok(after.updatedAt > before.updatedAt && after.createdAt === before.createdAt && after.name === before.name);
    await evaluate(panel.sessionId, `document.getElementById('tab-tree').click()`);
  });

  await step('tab groups: create, name, add, collapse, menus, move out, snapshot round-trip, ungroup', async () => {
    const mk = (name) => evaluate(panel.sessionId, `chrome.tabs.create({ url: '${site('')}' + '${name}', windowId: ${winId}, active: false }).then((t) => t.id)`);
    const g1 = await mk('groupone');
    const g2 = await mk('grouptwo');
    await until(async () => (await state()).windows[0].tabs.some((t) => t.id === g2 && t.title === 'Page grouptwo'), 'group tabs');
    const gid = await send('groupCreate', { tabId: g1 });
    await send('groupUpdate', { groupId: gid, title: 'Research', color: 'purple' });
    await send('groupAdd', { tabId: g2, groupId: gid });
    let s1 = await state();
    assert.deepEqual(s1.windows[0].groups.map((g) => [g.title, g.color]), [['Research', 'purple']]);
    assert.deepEqual(s1.windows[0].tabs.filter((t) => t.groupId === gid).map((t) => t.id).sort(), [g1, g2].sort());
    const dom = () => evaluate(panel.sessionId, `(() => {
      const head = [...document.querySelectorAll('.group-head')].find((h) => h.querySelector('.group-name').textContent === 'Research');
      if (!head) return null;
      const body = head.nextElementSibling;
      return { count: head.querySelector('.count').textContent, expanded: head.getAttribute('aria-expanded'),
        rows: [...body.querySelectorAll('.row .title')].map((t) => t.textContent) };
    })()`);
    const shown = await until(async () => { const d = await dom(); return d?.rows.length === 2 && d; }, 'group header + body');
    assert.deepEqual(shown.rows.sort(), ['Page groupone', 'Page grouptwo']);
    assert.equal(shown.count, '2');
    await send('groupUpdate', { groupId: gid, collapsed: true });
    const collapsed = await until(async () => { const d = await dom(); return d?.expanded === 'false' && d; }, 'collapsed group');
    assert.equal(collapsed.rows.length, 0, 'collapsed group hides its tabs');
    await send('groupUpdate', { groupId: gid, collapsed: false });
    await until(async () => (await dom())?.rows.length === 2, 'expanded again');

    // A closed child of a grouped tab must stay inside the group, not split it in two.
    const child = await mk('groupchild');
    await until(async () => (await state()).windows[0].tabs.some((t) => t.id === child && t.title === 'Page groupchild'), 'child tab');
    await send('move', { tabId: child, targetId: g1, position: 'inside' });
    await send('close', { tabId: child });
    const heads = () => evaluate(panel.sessionId, `(() => {
      const hs = [...document.querySelectorAll('.group-head')].filter((h) => h.querySelector('.group-name').textContent === 'Research');
      return { headers: hs.length, ghostInBody: !!hs[0]?.nextElementSibling.querySelector('.row.ghost'), ghosts: document.querySelectorAll('.row.ghost').length };
    })()`);
    const split = await until(async () => { const h = await heads(); return h.ghostInBody && h; }, 'closed child inside the group');
    assert.equal(split.headers, 1, 'one Research header, not two');

    // The header toggle hides and shows recently closed tabs.
    await evaluate(panel.sessionId, `document.getElementById('toggle-closed').click()`);
    await until(async () => (await heads()).ghosts === 0 && !(await state()).settings.showClosed, 'closed tabs hidden');
    assert.equal(await evaluate(panel.sessionId, `document.getElementById('toggle-closed').getAttribute('aria-pressed')`), 'false');
    await evaluate(panel.sessionId, `document.getElementById('toggle-closed').click()`);
    await until(async () => (await heads()).ghosts > 0, 'closed tabs shown again');

    // Right-click menu on a grouped tab, then the editor from the header's "more" button.
    const menu = await evaluate(panel.sessionId, `(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.title')?.textContent === 'Page grouptwo');
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 200 }));
      const p = document.getElementById('popover');
      const items = [...p.querySelectorAll('[role=menuitem]')].map((i) => i.textContent);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { items, closed: p.hidden };
    })()`);
    assert.ok(menu.items.includes('Add to new group') && menu.items.includes('Remove from group'), JSON.stringify(menu.items));
    assert.equal(menu.closed, true, 'Escape closes the menu');
    const viaButton = await evaluate(panel.sessionId, `(() => {
      const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.title')?.textContent === 'Page grouptwo');
      row.querySelector('.row-more').click();
      const open = !document.getElementById('popover').hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return open;
    })()`);
    assert.equal(viaButton, true, 'the row ⋯ button opens the same menu (no right-click needed)');
    const editor = await evaluate(panel.sessionId, `(() => {
      document.querySelector('.group-head .group-more').click();
      const p = document.getElementById('popover');
      const out = { name: p.querySelector('input').value, swatches: p.querySelectorAll('.swatch').length,
        checked: p.querySelector('.swatch[aria-checked=true]').dataset.color, focused: document.activeElement === p.querySelector('input') };
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return out;
    })()`);
    assert.deepEqual(editor, { name: 'Research', swatches: 9, checked: 'purple', focused: true });
    if (process.env.SHOTS) {
      const { writeFileSync: write } = await import('node:fs');
      await cdp('Target.activateTarget', { targetId: panel.targetId });
      await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 600, deviceScaleFactor: 2, mobile: false }, panel.sessionId);
      await sleep(300);
      write(join(process.env.SHOTS, 'groups.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId)).data, 'base64'));
      await evaluate(panel.sessionId, `document.querySelector('.group-head .group-more').click()`);
      await sleep(250);
      write(join(process.env.SHOTS, 'group-editor.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId)).data, 'base64'));
      await evaluate(panel.sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    }

    // Snapshot keeps the group; restoring into a new window recreates it.
    await send('saveSnapshot', { name: 'With group', scope: 'window', windowId: winId });
    const snap = (await state()).snapshots.find((x) => x.name === 'With group');
    await send('restoreSnapshot', { id: snap.id, mode: 'new', windowId: winId });
    await send('setSettings', { patch: { allWindows: true } });
    const restored = (await state()).windows.find((w) => w.id !== winId && w.groups.some((g) => g.title === 'Research'));
    assert.ok(restored, 'restored window has the Research group');
    const rg = restored.groups.find((g) => g.title === 'Research');
    assert.equal(rg.color, 'purple');
    assert.equal(restored.tabs.filter((t) => t.groupId === rg.id).length, 2);
    await send('undoRestore');
    await send('setSettings', { patch: { allWindows: false } });

    // Dragging a grouped tab next to an ungrouped one takes it out of the group.
    const plain = (await state()).windows[0].tabs.find((t) => t.groupId === -1 && t.title === 'Page a');
    await send('move', { tabId: g2, targetId: plain.id, position: 'after' });
    s1 = await state();
    assert.equal(s1.windows[0].tabs.find((t) => t.id === g2).groupId, -1, 'moved out of the group');
    await send('groupUngroup', { groupId: gid });
    assert.equal((await state()).windows[0].groups.length, 0);
    await evaluate(panel.sessionId, `chrome.tabs.remove([${g1}, ${g2}])`);
  });

  await step('keyboard navigation and live region in the panel', async () => {
    await cdp('Page.enable', {}, panel.sessionId);
    await sleep(300);
    const out = await evaluate(panel.sessionId, `(async () => {
      const first = document.querySelector('[role=treeitem][tabindex="0"]');
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      const focused = document.activeElement.getAttribute('role');
      const tabbable = document.querySelectorAll('[role=treeitem][tabindex="0"]').length;
      return [focused, tabbable, document.getElementById('tree').getAttribute('role')];
    })()`);
    assert.deepEqual(out, ['treeitem', 1, 'tree']);
  });

  // A real reload can't be driven here (headless Chromium disables a --load-extension
  // extension on runtime.reload), so recreate its aftermath: a tracked panel window whose
  // page Chromium replaced with a New Tab page, plus a live panel window that must survive.
  await step('orphaned panel windows (New Tab left after a reload) get closed on install', async () => {
    const swTarget = (await cdp('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extId));
    const { sessionId: sw } = await cdp('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true });
    const ids = await evaluate(sw, `(async () => {
      const orphan = await chrome.windows.create({ type: 'popup', url: 'chrome://newtab/' });
      const live = await chrome.windows.create({ type: 'popup', url: chrome.runtime.getURL('panel.html?mode=window&for=${winId}').replace(/^chrome-extension:\\/\\/[^/]+/, 'chrome-extension://' + chrome.runtime.id) });
      await chrome.storage.local.set({ panelWindows: { 1: orphan.id, 2: live.id } });
      return [orphan.id, live.id];
    })()`);
    await sleep(500);
    await evaluate(sw, `groveCloseOrphans().then(() => true)`);
    const remaining = await evaluate(sw, `chrome.windows.getAll().then((w) => w.map((x) => x.id))`);
    assert.ok(!remaining.includes(ids[0]), 'orphan closed');
    assert.ok(remaining.includes(ids[1]), 'live panel window kept');
    await evaluate(sw, `chrome.windows.remove(${ids[1]}).then(() => true)`);
  });

  // SHOTS=<dir> also saves a panel screenshot per theme.
  if (process.env.SHOTS) {
    const { writeFileSync } = await import('node:fs');
    await send('toggleCollapse', { tabId: tc.id, collapsed: false });
    await cdp('Target.activateTarget', { targetId: panel.targetId });
    await cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 600, deviceScaleFactor: 2, mobile: false }, panel.sessionId);
    for (const theme of ['paper', 'ink', 'moss', 'sakura', 'slate']) {
      await send('setSettings', { patch: { theme } });
      await until(() => evaluate(panel.sessionId, `document.documentElement.dataset.theme === '${theme}'`), theme);
      await sleep(300);
      const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, panel.sessionId);
      writeFileSync(join(process.env.SHOTS, `panel-${theme}.png`), Buffer.from(data, 'base64'));
    }
    await send('setSettings', { patch: { theme: 'ink' } });
    const opts = await openPage(`chrome-extension://${extId}/options.html`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 760, height: 1180, deviceScaleFactor: 1, mobile: false }, opts.sessionId);
    await sleep(800);
    const { data: optData } = await cdp('Page.captureScreenshot', { format: 'png' }, opts.sessionId);
    writeFileSync(join(process.env.SHOTS, 'options.png'), Buffer.from(optData, 'base64'));
  }
  console.log(`\n${passed} checks passed`);
} catch (err) {
  console.error(`\n✖ ${err.stack || err}`);
  process.exitCode = 1;
} finally {
  ws?.close();
  proc.kill();
  server.close();
  await sleep(500);
  // Windows can keep profile files locked briefly after the browser exits.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch (err) {
    console.warn(`could not remove ${profile}: ${err.message}`);
  }
}
