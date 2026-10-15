// Toggles Grove's floating panel on the current page. The service worker injects this on
// demand (activeTab), so nothing runs on pages until the user asks for the panel.
(() => {
  if (globalThis.__groveOverlay) {
    globalThis.__groveOverlay.close();
    return;
  }

  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .frame {
      position: fixed;
      top: 12px;
      right: 12px;
      left: auto;
      width: 400px;
      height: min(620px, calc(100vh - 24px));
      border: 0;
      border-radius: 14px;
      background: transparent;
      box-shadow: 0 28px 70px rgb(0 0 0 / 0.42), 0 4px 14px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(255 255 255 / 0.07);
      color-scheme: normal;
      pointer-events: auto;
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
      transform-origin: top right;
      transition: opacity 0.16s ease, transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .frame.left { right: auto; left: 12px; transform-origin: top left; }
    .frame.open { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { .frame { transition: none; } }
  `;
  const frame = document.createElement('iframe');
  frame.className = 'frame';
  frame.title = 'Grove tabs';
  frame.src = chrome.runtime.getURL('panel.html?mode=overlay');
  root.append(style, frame);
  document.documentElement.append(host);

  // Dock to the side chosen in settings, and follow changes while open.
  const applySide = (settings) => frame.classList.toggle('left', settings?.side === 'left');
  chrome.storage.local.get('settings').then(({ settings }) => applySide(settings));
  const onStorage = (changes, area) => {
    if (area === 'local' && changes.settings) applySide(changes.settings.newValue);
  };
  chrome.storage.onChanged.addListener(onStorage);

  const previousFocus = document.activeElement;
  frame.addEventListener('load', () => {
    frame.classList.add('open');
    frame.focus();
  });

  const onMessage = (e) => {
    if (e.source === frame.contentWindow && e.data?.grove === 'close') close();
  };
  const onPointerDown = () => close(); // clicks inside the iframe never reach this document
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('message', onMessage);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('keydown', onKey, true);

  function close() {
    window.removeEventListener('message', onMessage);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKey, true);
    chrome.storage.onChanged.removeListener(onStorage);
    host.remove();
    delete globalThis.__groveOverlay;
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
  }

  globalThis.__groveOverlay = { close };
})();
