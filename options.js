const $ = (id) => document.getElementById(id);
const statusEl = $('status');

async function send(type, data = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...data });
  if (!res?.ok) throw new Error(res?.error || 'Grove did not respond.');
  return res.result;
}

let statusTimer = null;
function status(text) {
  statusEl.textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (statusEl.textContent = ''), 2500);
}

const darkQuery = matchMedia('(prefers-color-scheme: dark)');
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'system' ? (darkQuery.matches ? 'ink' : 'paper') : theme;
}

async function save(patch) {
  try {
    const settings = await send('setSettings', { patch });
    applyTheme(settings.theme);
    status('Saved');
  } catch (err) {
    status(err.message);
  }
}

async function init() {
  const settings = await send('setSettings', { patch: {} });
  applyTheme(settings.theme);
  darkQuery.addEventListener('change', () => applyTheme($('theme').value));
  $('theme').value = settings.theme;
  $('side').value = settings.side;
  $('allWindows').checked = settings.allWindows;
  $('showClosed').checked = settings.showClosed;
  $('retentionHours').value = String(settings.retentionHours);
  $('restoreMode').value = settings.restoreMode;
  $('exclusions').value = settings.exclusions.join('\n');

  $('theme').addEventListener('change', (e) => save({ theme: e.target.value }));
  $('side').addEventListener('change', (e) => save({ side: e.target.value }));
  $('allWindows').addEventListener('change', (e) => save({ allWindows: e.target.checked }));
  $('showClosed').addEventListener('change', (e) => save({ showClosed: e.target.checked }));
  $('retentionHours').addEventListener('change', (e) => save({ retentionHours: Number(e.target.value) }));
  $('restoreMode').addEventListener('change', (e) => save({ restoreMode: e.target.value }));
  let timer = null;
  $('exclusions').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const exclusions = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
      save({ exclusions });
    }, 500);
  });

  $('export').addEventListener('click', async () => {
    const { snapshots = [] } = await chrome.storage.local.get('snapshots');
    const blob = new Blob([JSON.stringify({ grove: 1, snapshots }, null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `grove-snapshots-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    status(`Exported ${snapshots.length} snapshot${snapshots.length === 1 ? '' : 's'}`);
  });

  $('import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = (Array.isArray(data) ? data : data.snapshots || []).filter(
        (s) => s && typeof s.name === 'string' && Array.isArray(s.windows) &&
          s.windows.every((w) => Array.isArray(w.tabs) && w.tabs.every((t) => typeof t.url === 'string')),
      );
      if (!incoming.length) throw new Error('No snapshots found in that file.');
      const { snapshots = [] } = await chrome.storage.local.get('snapshots');
      const known = new Set(snapshots.map((s) => s.id));
      const fresh = incoming.map((s) => ({
        ...s,
        id: s.id && !known.has(s.id) ? s.id : crypto.randomUUID(),
        createdAt: Number(s.createdAt) || Date.now(),
      }));
      await chrome.storage.local.set({ snapshots: [...fresh, ...snapshots] });
      status(`Imported ${fresh.length} snapshot${fresh.length === 1 ? '' : 's'}`);
    } catch (err) {
      status(err instanceof SyntaxError ? 'That file isn’t valid JSON.' : err.message);
    }
  });
}

init();
