/* Fast-mode extras: COI via service worker, touch size/opacity/vibration panel */
(function () {
  if (!window.crossOriginIsolated && 'serviceWorker' in navigator && !sessionStorage.getItem('coi')) {
    sessionStorage.setItem('coi', '1');
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => location.reload()).catch(() => {});
  }
  const LS = 'ps2_fast_touch';
  const cfg = Object.assign({ size: 100, opacity: 75, vibrate: true }, (() => { try { return JSON.parse(localStorage.getItem(LS)); } catch (_) { return {}; } })());
  const st = document.createElement('style');
  document.head.appendChild(st);
  const apply = () => {
    st.textContent = '#touch .cluster{zoom:' + cfg.size / 100 + ';opacity:' + cfg.opacity / 100 + '!important}';
    try { localStorage.setItem(LS, JSON.stringify(cfg)); } catch (_) {}
  };
  apply();
  const t = document.getElementById('touch');
  if (t) t.addEventListener('touchstart', (e) => {
    if (cfg.vibrate && navigator.vibrate && e.target.closest('[data-btn],[data-dir]')) navigator.vibrate(10);
  }, { passive: true });
  const b = document.createElement('button');
  b.textContent = '⚙'; b.style.cssText = 'position:fixed;top:6px;right:6px;z-index:9;opacity:.6;font-size:16px;padding:4px 9px';
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:36px;right:6px;z-index:9;background:#111d;color:#fff;padding:10px;border-radius:8px;font:13px sans-serif;display:none;gap:6px;flex-direction:column';
  p.innerHTML = '<label>Size <input id="ft-s" type="range" min="60" max="160"></label><label>Opacity <input id="ft-o" type="range" min="20" max="100"></label><label><input id="ft-v" type="checkbox"> Vibration</label>';
  document.body.append(b, p);
  const $ = (i) => p.querySelector('#' + i);
  $('ft-s').value = cfg.size; $('ft-o').value = cfg.opacity; $('ft-v').checked = cfg.vibrate;
  $('ft-s').oninput = (e) => { cfg.size = +e.target.value; apply(); };
  $('ft-o').oninput = (e) => { cfg.opacity = +e.target.value; apply(); };
  $('ft-v').onchange = (e) => { cfg.vibrate = e.target.checked; apply(); };
  b.onclick = () => { p.style.display = p.style.display === 'flex' ? 'none' : 'flex'; };
})();
