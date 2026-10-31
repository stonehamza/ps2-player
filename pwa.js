/* Service worker setup. Exposes window.__ps2Ready (a promise) that index.js awaits before booting the emulator.
   The UI itself (buttons) NEVER waits for this. */
(function () {
  const KEY = 'ps2-coi-reloaded';
  const wait = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);
  const log = (k, m) => window.__diag && window.__diag.add(k, m);

  window.__ps2Ready = (async function () {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) { log('pwa', 'no service worker support / insecure context'); return 'no-sw'; }
    try {
      await wait(navigator.serviceWorker.register('sw.js'), 6000);
      if (self.crossOriginIsolated) { sessionStorage.removeItem(KEY); log('pwa', 'isolated OK'); return 'isolated'; }
      await wait(navigator.serviceWorker.ready, 6000);
      if (!navigator.serviceWorker.controller) {
        await wait(new Promise((res) => navigator.serviceWorker.addEventListener('controllerchange', res, { once: true })), 4000);
      }
      if (navigator.serviceWorker.controller && !sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        log('pwa', 'reloading once to enable isolation');
        location.reload();
        return new Promise(() => {}); // page is reloading
      }
    } catch (e) { log('pwa', 'SW error: ' + (e && e.message || e)); }
    return self.crossOriginIsolated ? 'isolated' : 'not-isolated';
  })();
})();

/* Optional install button */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const btn = document.createElement('button');
  btn.textContent = '⬇ Install / تثبيت';
  btn.style.cssText = 'position:fixed;right:12px;bottom:44px;z-index:9999;padding:10px 14px;border:0;border-radius:10px;background:#3c7cc8;color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
  btn.onclick = async () => { btn.remove(); deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; };
  document.body.appendChild(btn);
});
