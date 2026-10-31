/* PS2 Web — On-screen touch controls (virtual gamepad)
 * Translates touches into the keyboard events the Play! core listens to.
 * Settings (enable / size / opacity / vibration) live in the ⚙️ Settings panel.
 */
(function () {
  'use strict';

  // ── PS2 action → keyboard event (Play! default keyboard layout) ──────────
  // Edit here if a button does not react in your game.
  const K = (code, key, keyCode, location) => ({ code, key, keyCode, location: location || 0 });
  const KEYS = {
    UP: K('ArrowUp', 'ArrowUp', 38), DOWN: K('ArrowDown', 'ArrowDown', 40),
    LEFT: K('ArrowLeft', 'ArrowLeft', 37), RIGHT: K('ArrowRight', 'ArrowRight', 39),
    CROSS: K('KeyZ', 'z', 90), CIRCLE: K('KeyX', 'x', 88),
    SQUARE: K('KeyA', 'a', 65), TRIANGLE: K('KeyS', 's', 83),
    L1: K('Digit1', '1', 49), L2: K('Digit2', '2', 50), L3: K('Digit3', '3', 51),
    R1: K('Digit8', '8', 56), R2: K('Digit9', '9', 57), R3: K('Digit0', '0', 48),
    START: K('Enter', 'Enter', 13),
    SELECT: K('ShiftRight', 'Shift', 16, 2),
    SELECT_ALT: K('Backspace', 'Backspace', 8),
    // left analog stick
    LS_UP: K('KeyT', 't', 84), LS_LEFT: K('KeyF', 'f', 70), LS_DOWN: K('KeyG', 'g', 71), LS_RIGHT: K('KeyH', 'h', 72),
    // right analog stick
    RS_UP: K('KeyI', 'i', 73), RS_LEFT: K('KeyJ', 'j', 74), RS_DOWN: K('KeyK', 'k', 75), RS_RIGHT: K('KeyL', 'l', 76)
  };
  window.__touchKeys = KEYS;

  // ── Config ────────────────────────────────────────────────────────────────
  const LS_KEY = 'ps2_touch_cfg';
  const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || 'ontouchstart' in window;
  const defaults = { enabled: isTouch, size: 100, opacity: 70, vibrate: true };
  let cfg = Object.assign({}, defaults);
  try { Object.assign(cfg, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); } catch (_) {}
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (_) {} };

  // ── Key sender ────────────────────────────────────────────────────────────
  const held = new Map(); // keyName -> count
  function fire(type, def) {
    const target = document.getElementById('outputCanvas') || document;
    const ev = new KeyboardEvent(type, {
      key: def.key, code: def.code, location: def.location, keyCode: def.keyCode, which: def.keyCode,
      bubbles: true, cancelable: true, composed: true
    });
    // some browsers ignore keyCode/which from the init dict
    try { Object.defineProperty(ev, 'keyCode', { get: () => def.keyCode }); Object.defineProperty(ev, 'which', { get: () => def.keyCode }); } catch (_) {}
    target.dispatchEvent(ev);
  }
  function keyDown(name) {
    const n = (held.get(name) || 0) + 1; held.set(name, n);
    if (n === 1) { fire('keydown', KEYS[name]); if (name === 'SELECT') keyDown('SELECT_ALT'); }
  }
  function keyUp(name) {
    const n = (held.get(name) || 0) - 1;
    if (n > 0) { held.set(name, n); return; }
    if (held.has(name)) { held.delete(name); fire('keyup', KEYS[name]); if (name === 'SELECT') keyUp('SELECT_ALT'); }
  }
  function releaseAll() { gpHeld.clear(); [...held.keys()].forEach((k) => { held.delete(k); fire('keyup', KEYS[k]); }); document.querySelectorAll('#tc-root .on').forEach((e) => e.classList.remove('on')); }
  function buzz() { if (cfg.vibrate && navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} } }

  // ── CSS ───────────────────────────────────────────────────────────────────
  const css = `
  #tc-root{--u:calc(min(5.2vh,3.2vw) * var(--tc-scale,1));position:fixed;inset:0;z-index:40;pointer-events:none;display:none;
    opacity:var(--tc-opacity,.7);-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;touch-action:none;font-family:system-ui,sans-serif}
  #tc-root.show{display:block}
  #tc-root *{box-sizing:border-box;-webkit-tap-highlight-color:transparent;touch-action:none}
  #tc-root .c{position:absolute;pointer-events:auto;color:#e8f4ff;border:2px solid rgba(220,235,255,.85);background:rgba(20,40,70,.35);
    display:flex;align-items:center;justify-content:center;font-weight:700;font-size:calc(var(--u)*.85);line-height:1}
  #tc-root .c.on{background:rgba(90,170,255,.65);border-color:#fff}
  #tc-root .sh{height:calc(var(--u)*1.3);width:calc(var(--u)*3.4);border-radius:calc(var(--u)*.4);font-size:calc(var(--u)*.8)}
  #tc-root .fb{width:calc(var(--u)*2.4);height:calc(var(--u)*2.4);border-radius:50%}
  #tc-root .sm{width:calc(var(--u)*1.7);height:calc(var(--u)*1.7);border-radius:50%;font-size:calc(var(--u)*.6)}
  #tc-root .pill{width:calc(var(--u)*3);height:calc(var(--u)*1.3);border-radius:calc(var(--u)*.65);font-size:calc(var(--u)*.6)}
  #tc-root .pad{width:calc(var(--u)*5);height:calc(var(--u)*5);border-radius:50%;background:rgba(20,40,70,.25)}
  #tc-root .dp{border-radius:50%}
  #tc-root .dp i{position:absolute;font-style:normal;font-size:calc(var(--u)*1.1);opacity:.85}
  #tc-root .dp i.on{color:#6cf;opacity:1}
  #tc-root .dp .u{top:6%;left:50%;transform:translateX(-50%)} #tc-root .dp .d{bottom:6%;left:50%;transform:translateX(-50%)}
  #tc-root .dp .l{left:8%;top:50%;transform:translateY(-50%)} #tc-root .dp .r{right:8%;top:50%;transform:translateY(-50%)}
  #tc-root .knob{position:absolute;width:44%;height:44%;border-radius:50%;background:rgba(210,230,255,.55);border:2px solid #fff;pointer-events:none;
    left:28%;top:28%}
  #tc-root .sym-t{color:#5fd7a8}#tc-root .sym-c{color:#ff7b86}#tc-root .sym-x{color:#7fb0ff}#tc-root .sym-s{color:#f4a3e8}
  /* settings section */
  .tc-set .setting-row input[type=range]{width:55%}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);

  // ── Build overlay ─────────────────────────────────────────────────────────
  const root = document.createElement('div'); root.id = 'tc-root';
  const U = 'var(--u)';
  const mk = (cls, html, css, parent) => { const e = document.createElement('div'); e.className = 'c ' + cls; e.innerHTML = html || ''; e.style.cssText = css || ''; (parent || root).appendChild(e); return e; };
  const top = `calc(var(--top,48px) + ${U}*.3)`;
  const BOT = 'var(--bot,34px)';

  function holdButton(el, ...names) {
    const pointers = new Set();
    const down = (e) => { e.preventDefault(); if (pointers.size === 0) { el.classList.add('on'); names.forEach(keyDown); buzz(); } pointers.add(e.pointerId); try { el.setPointerCapture(e.pointerId); } catch (_) {} };
    const up = (e) => { if (!pointers.delete(e.pointerId)) return; if (pointers.size === 0) { el.classList.remove('on'); names.forEach(keyUp); } };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); el.addEventListener('lostpointercapture', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // shoulders
  holdButton(mk('sh', 'L2', `left:calc(${U}*.5);top:${top}`), 'L2');
  holdButton(mk('sh', 'L1', `left:calc(${U}*4.1);top:${top}`), 'L1');
  holdButton(mk('sh', 'R1', `right:calc(${U}*4.1);top:${top}`), 'R1');
  holdButton(mk('sh', 'R2', `right:calc(${U}*.5);top:${top}`), 'R2');
  // pause (calls the toolbar button)
  const pauseB = mk('sm', '❚❚', `right:calc(${U}*8.2);top:calc(${top} - ${U}*.2)`);
  pauseB.addEventListener('pointerdown', (e) => { e.preventDefault(); const b = document.getElementById('btnPause'); if (b && !b.disabled) b.click(); });

  // face buttons (diamond)
    const face = mk('', '', `right:calc(${U}*1.3);bottom:calc(${BOT} + ${U}*5.8);width:calc(${U}*6.2);height:calc(${U}*6.2);border:0;background:none;pointer-events:none`);
  const fpos = { t: 'left:50%;top:0;transform:translateX(-50%)', x: 'left:50%;bottom:0;transform:translateX(-50%)', s: 'left:0;top:50%;transform:translateY(-50%)', c: 'right:0;top:50%;transform:translateY(-50%)' };
  holdButton(mk('fb sym-t', '△', fpos.t, face), 'TRIANGLE');
  holdButton(mk('fb sym-x', '✕', fpos.x, face), 'CROSS');
  holdButton(mk('fb sym-s', '□', fpos.s, face), 'SQUARE');
  holdButton(mk('fb sym-c', '○', fpos.c, face), 'CIRCLE');
  // L3 / R3
  holdButton(mk('sm', 'L3', `left:calc(${U}*6.9);bottom:calc(${BOT} + ${U}*2)`), 'L3');
  holdButton(mk('sm', 'R3', `right:calc(${U}*6.9);bottom:calc(${BOT} + ${U}*2)`), 'R3');
  // select / start
  holdButton(mk('pill', 'SELECT', `left:50%;bottom:calc(${BOT} + ${U}*.4);transform:translateX(calc(-100% - ${U}*.3))`), 'SELECT');
  holdButton(mk('pill', 'START', `left:50%;bottom:calc(${BOT} + ${U}*.4);transform:translateX(${U}*.3)`), 'START');

  // generic "direction pad" handler (used for D-pad and the two sticks)
  function directional(el, map, opts) {
    let pid = null; const active = new Set();
    const knob = opts.knob ? el.querySelector('.knob') : null;
    const arrows = opts.arrows ? { UP: el.querySelector('.u'), DOWN: el.querySelector('.d'), LEFT: el.querySelector('.l'), RIGHT: el.querySelector('.r') } : null;
    function set(dirs) {
      ['UP', 'DOWN', 'LEFT', 'RIGHT'].forEach((d) => {
        const want = dirs.has(d), has = active.has(d);
        if (want && !has) { active.add(d); keyDown(map[d]); }
        else if (!want && has) { active.delete(d); keyUp(map[d]); }
        if (arrows) arrows[d].classList.toggle('on', want);
      });
    }
    function update(e) {
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
      let dx = e.clientX - cx, dy = e.clientY - cy; const len = Math.hypot(dx, dy) || 1;
      const lim = opts.knob ? R * 0.55 : R; const k = len > lim ? lim / len : 1;
      if (knob) knob.style.transform = `translate(${dx * k}px,${dy * k}px)`;
      const t = R * opts.threshold; const dirs = new Set();
      if (len > t) { const nx = dx / len, ny = dy / len; if (ny < -0.38) dirs.add('UP'); if (ny > 0.38) dirs.add('DOWN'); if (nx < -0.38) dirs.add('LEFT'); if (nx > 0.38) dirs.add('RIGHT'); }
      const before = active.size; set(dirs); if (active.size > before) buzz();
    }
    function end(e) { if (e.pointerId !== pid) return; pid = null; el.classList.remove('on'); if (knob) knob.style.transform = ''; set(new Set()); }
    el.addEventListener('pointerdown', (e) => { if (pid !== null) return; e.preventDefault(); pid = e.pointerId; try { el.setPointerCapture(pid); } catch (_) {} el.classList.add('on'); update(e); });
    el.addEventListener('pointermove', (e) => { if (e.pointerId === pid) { e.preventDefault(); update(e); } });
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const dpad = mk('pad dp', '<i class="u">▲</i><i class="d">▼</i><i class="l">◀</i><i class="r">▶</i>', `left:calc(${U}*1.4);bottom:calc(${BOT} + ${U}*5.8)`);
  directional(dpad, { UP: 'UP', DOWN: 'DOWN', LEFT: 'LEFT', RIGHT: 'RIGHT' }, { arrows: true, threshold: 0.22 });
  const lstick = mk('pad', '<div class="knob"></div>', `left:calc(${U}*1.4);bottom:calc(${BOT} + ${U}*.4)`);
  directional(lstick, { UP: 'LS_UP', DOWN: 'LS_DOWN', LEFT: 'LS_LEFT', RIGHT: 'LS_RIGHT' }, { knob: true, threshold: 0.3 });
  const rstick = mk('pad', '<div class="knob"></div>', `right:calc(${U}*1.4);bottom:calc(${BOT} + ${U}*.4)`);
  directional(rstick, { UP: 'RS_UP', DOWN: 'RS_DOWN', LEFT: 'RS_LEFT', RIGHT: 'RS_RIGHT' }, { knob: true, threshold: 0.3 });

  // ── Apply config / visibility ─────────────────────────────────────────────
  function apply() {
    root.style.setProperty('--tc-scale', (cfg.size / 100).toFixed(2));
    root.style.setProperty('--tc-opacity', (cfg.opacity / 100).toFixed(2));
    const tb = document.getElementById('toolbar'), sb = document.getElementById('statusBar');
    if (tb) root.style.setProperty('--top', Math.round(tb.getBoundingClientRect().bottom) + 'px');
    if (sb) root.style.setProperty('--bot', Math.round(sb.getBoundingClientRect().height) + 'px');
  }
  window.addEventListener('resize', () => apply());
  window.addEventListener('orientationchange', () => setTimeout(apply, 200));
  function gameRunning() { const b = document.getElementById('btnPause'); return !!b && !b.disabled; }
  function blocked() {
    const sp = document.getElementById('settingsPanel'); const cm = document.getElementById('controlMappingModal');
    return (sp && sp.style.display !== 'none' && sp.style.display !== '') || (cm && cm.style.display !== 'none' && cm.style.display !== '');
  }
  let lastShow = false;
  function refresh() {
    const show = cfg.enabled && gameRunning() && !blocked();
    root.classList.toggle('show', show);
    if (lastShow && !show) releaseAll();
    lastShow = show;
  }

  // ── Settings section (injected into the existing panel) ───────────────────
  function buildSettings() {
    const body = document.querySelector('#settingsPanel .panel-body');
    if (!body || body.querySelector('.tc-set')) return;
    const sec = document.createElement('section'); sec.className = 'settings-section tc-set';
    sec.innerHTML = `<h3>Touch Controls / أزرار اللمس</h3>
      <div class="setting-row"><label for="tcEnable">Show touch buttons</label><input type="checkbox" id="tcEnable"></div>
      <div class="setting-row"><label for="tcSize">Size</label><input type="range" id="tcSize" min="60" max="150" step="5"></div>
      <div class="setting-row"><label for="tcOpacity">Opacity</label><input type="range" id="tcOpacity" min="20" max="100" step="5"></div>
      <div class="setting-row"><label for="tcVib">Vibration</label><input type="checkbox" id="tcVib"></div>
      <p class="about-text" style="margin-top:4px">Buttons appear while a game is running.</p>`;
    body.insertBefore(sec, body.firstChild);
    const $ = (id) => sec.querySelector('#' + id);
    $('tcEnable').checked = cfg.enabled; $('tcSize').value = cfg.size; $('tcOpacity').value = cfg.opacity; $('tcVib').checked = cfg.vibrate;
    $('tcEnable').onchange = (e) => { cfg.enabled = e.target.checked; save(); refresh(); };
    $('tcSize').oninput = (e) => { cfg.size = +e.target.value; save(); apply(); };
    $('tcOpacity').oninput = (e) => { cfg.opacity = +e.target.value; save(); apply(); };
    $('tcVib').onchange = (e) => { cfg.vibrate = e.target.checked; save(); };
  }


  // ── Bluetooth / USB gamepad → keyboard events (the core only listens to keys) ──
  const GP_BTN = { 0: 'CROSS', 1: 'CIRCLE', 2: 'SQUARE', 3: 'TRIANGLE', 4: 'L1', 5: 'R1', 6: 'L2', 7: 'R2', 8: 'SELECT', 9: 'START', 10: 'L3', 11: 'R3', 12: 'UP', 13: 'DOWN', 14: 'LEFT', 15: 'RIGHT' };
  const gpHeld = new Set(); let gpTimer = null;
  function gpTick() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null; for (const g of pads) { if (g && g.connected) { gp = g; break; } }
    const want = new Set();
    if (gp) {
      gp.buttons.forEach((b, i) => { if (GP_BTN[i] && (b.pressed || b.value > 0.5)) want.add(GP_BTN[i]); });
      const dz = 0.45, ax = (i) => gp.axes[i] || 0;
      if (ax(0) < -dz) want.add('LS_LEFT'); if (ax(0) > dz) want.add('LS_RIGHT');
      if (ax(1) < -dz) want.add('LS_UP'); if (ax(1) > dz) want.add('LS_DOWN');
      if (ax(2) < -dz) want.add('RS_LEFT'); if (ax(2) > dz) want.add('RS_RIGHT');
      if (ax(3) < -dz) want.add('RS_UP'); if (ax(3) > dz) want.add('RS_DOWN');
    }
    want.forEach((n) => { if (!gpHeld.has(n)) { gpHeld.add(n); keyDown(n); } });
    [...gpHeld].forEach((n) => { if (!want.has(n)) { gpHeld.delete(n); keyUp(n); } });
    gpTimer = gp ? setTimeout(gpTick, 16) : null;
  }
  window.addEventListener('gamepadconnected', () => { if (!gpTimer) gpTimer = setTimeout(gpTick, 16); });
  window.addEventListener('gamepaddisconnected', () => { if (!gpTimer) gpTimer = setTimeout(gpTick, 0); });

  function init() {
    document.body.appendChild(root); apply(); buildSettings();
    setInterval(refresh, 250);
    // block page gestures (double-tap zoom, pull-to-refresh) while playing
    document.addEventListener('touchmove', (e) => { if (root.classList.contains('show') && e.target.closest && e.target.closest('#tc-root')) e.preventDefault(); }, { passive: false });
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
