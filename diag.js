/* On-screen diagnostics: shows real errors on devices without a console. Tap 🐞 to toggle. */
(function () {
  const logs = [];
  let btn, panel, pre;
  const fmt = (v) => (v && (v.stack || v.message)) || String(v);
  function ensure() {
    if (btn || !document.body) return;
    btn = document.createElement('button');
    btn.textContent = '🐞';
    btn.setAttribute('aria-label', 'Diagnostics');
    btn.style.cssText = 'position:fixed;left:calc(50% - 150px);bottom:38px;z-index:99999;width:34px;height:34px;border-radius:50%;border:1px solid #345;background:#0b1a33cc;color:#fff;font-size:16px;opacity:.6';
    panel = document.createElement('div');
    panel.style.cssText = 'display:none;position:fixed;left:6px;right:6px;bottom:74px;max-height:55vh;overflow:auto;z-index:99999;background:#050c18f2;color:#cfe;border:1px solid #2a4a7a;border-radius:10px;padding:8px;font:11px/1.4 monospace;direction:ltr;text-align:left;white-space:pre-wrap';
    pre = document.createElement('div');
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.style.cssText = 'margin-bottom:6px;padding:4px 10px';
    copy.onclick = () => { try { navigator.clipboard.writeText(logs.join('\n')); copy.textContent = 'Copied'; } catch (_) {} };
    panel.append(copy, pre);
    btn.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; pre.textContent = logs.join('\n'); };
    document.body.append(btn, panel);
    render();
  }
  function label() {
    const v = document.createElement('div');
    v.textContent = 'v2.3';
    v.style.cssText = 'position:fixed;right:6px;bottom:34px;z-index:99998;font:10px monospace;color:#7fd;opacity:.6;pointer-events:none';
    document.body.appendChild(v);
  }
  let rq = 0;
  function render() { if (!pre || !panel || panel.style.display === 'none' || rq) return; rq = setTimeout(() => { rq = 0; pre.textContent = logs.join('\n'); }, 400); }
  function add(kind, msg, open) {
    logs.push('[' + kind + '] ' + msg);
    if (logs.length > 120) logs.shift();
    ensure(); render();
    if (open && panel) { panel.style.display = 'block'; pre.textContent = logs.join('\n'); }
  }
  window.__diag = { add, fatal: (m) => add('FATAL', m, true) };
  window.addEventListener('error', (e) => add('error', (e.message || 'error') + ' @ ' + (e.filename || '').split('/').pop() + ':' + (e.lineno || '?'), true));
  window.addEventListener('unhandledrejection', (e) => add('promise', fmt(e.reason), true));
  const ce = console.error.bind(console);
  let ceN = 0; console.error = (...a) => { if (ceN++ < 60) add('console.error', a.map(fmt).join(' ').slice(0, 300)); ce(...a); };
  document.addEventListener('DOMContentLoaded', () => {
    ensure(); label();
    add('info', 'build 2.3-perf | secure=' + isSecureContext + ' | isolated=' + self.crossOriginIsolated + ' | SAB=' + (typeof SharedArrayBuffer) + ' | SW=' + ('serviceWorker' in navigator));
    add('info', navigator.userAgent);
  });
  setTimeout(() => add('info', 'after 3s: SW controller=' + !!(navigator.serviceWorker && navigator.serviceWorker.controller) + ' | isolated=' + self.crossOriginIsolated), 3000);
})();
