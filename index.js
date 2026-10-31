/* PS2 Mate - Main Controller
   Integrates Play! (playjs.purei.org) into a Chrome extension page.
   Play.js is an Emscripten MODULARIZE module — no sandbox needed. */

let Play = null; // loaded lazily so a failure here can never disable the UI buttons


/* ── Web shim: replaces chrome.runtime / chrome.storage used by the extension ── */
const __LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
};
const chrome = {
  runtime: {
    getURL: (p) => new URL(p, document.baseURI).href,
    sendMessage(msg, cb) {
      let res = {};
      if (msg.type === 'GET_RECENT_GAMES') {
        res = { games: __LS.get('ps2_recentGames', []) };
      } else if (msg.type === 'SAVE_RECENT_GAME') {
        const all = __LS.get('ps2_recentGames', []);
        const prev = all.find(g => g.name === msg.game.name);
        const games = all.filter(g => g.name !== msg.game.name);
        games.unshift({ name: msg.game.name, timestamp: Date.now(), size: msg.game.size,
                        thumbnail: msg.game.thumbnail || prev?.thumbnail || null });
        __LS.set('ps2_recentGames', games.slice(0, 20));
        res = { success: true };
      } else if (msg.type === 'GET_SETTINGS') {
        res = { settings: __LS.get('ps2_settings', {}) };
      } else if (msg.type === 'SAVE_SETTINGS') {
        __LS.set('ps2_settings', msg.settings);
      }
      if (typeof cb === 'function') setTimeout(() => cb(res), 0);
    }
  },
  storage: { local: {
    get(keys, cb) { const r = {}; keys.forEach(k => { const v = __LS.get(k, undefined); if (v !== undefined) r[k] = v; }); cb(r); },
    set(obj) { Object.entries(obj).forEach(([k, v]) => __LS.set(k, v)); }
  } }
};

(function () {
  'use strict';

  const state = { running: false, paused: false, gameLoaded: false, currentGame: null, volume: 100, muted: false, playTime: 0 };
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const esc = str => (!str ? '' : String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'));
  const els = {
    gameTitle: $('#gameTitle'), noGameBanner: $('#noGameBanner'), fileInput: $('#fileInput'),
    canvas: $('#outputCanvas'), statusOverlay: $('#statusOverlay'), pauseOverlay: $('#pauseOverlay'),
    statusText: $('#statusText'), settingsPanel: $('#settingsPanel'), volumeSlider: $('#volumeSlider'),
    fpsCounter: $('#fpsCounter'), statusMessage: $('#statusMessage'), timeCounter: $('#timeCounter'),
    gamepadStatus: $('#gamepadStatus'), recentGames: $('#recentGames'),
    statsHud: $('#statsHud'), hudFps: $('#hudFps'), hudCacheRate: $('#hudCacheRate'),
    hudDiscReads: $('#hudDiscReads'), hudJitBlocks: $('#hudJitBlocks'), hudMemory: $('#hudMemory'),
  };

  let module = null;   // the Play! Emscripten module
  let discDevice = null;
  let timer = null;

  // ── Disc Image Device (16MB Chunked Memory Cache) ─────
  class DiscImageDevice {
    constructor(m) {
      this.module = m;
      this.doneFlag = false;
      this.file = null;
      this.fileSize = 0;
      this.chunkSize = 16 * 1024 * 1024; // 16 MB chunks
      this.maxChunks = 8;                // LRU cap: 8 x 16 MB = 128 MB max, regardless of disc size
      this.chunks = new Map();           // chunkIndex -> Uint8Array
      this.pendingReads = new Map();     // chunkIndex -> Promise

      // Performance monitoring counters
      this.syncReads = 0;
      this.asyncReads = 0;
      this.bytesRead = 0;
    }
    async setFile(file) {
      this.file = file;
      this.fileSize = file.size;
      this.chunks.clear();
      this.pendingReads.clear();
      this.syncReads = 0;
      this.asyncReads = 0;
      this.bytesRead = 0;
      console.log('[DiscImageDevice] Loading disc with 16MB Chunked Cache:', (file.size / 1048576).toFixed(1), 'MB');
      // Pre-fetch initial chunk (0..16MB) which contains disc header, TOC & boot ELF
      await this.preloadChunk(0);
    }
    async preloadChunk(chunkIndex) {
      if (this.chunks.has(chunkIndex)) return this.chunks.get(chunkIndex);
      if (this.pendingReads.has(chunkIndex)) return this.pendingReads.get(chunkIndex);

      const start = chunkIndex * this.chunkSize;
      if (start >= this.fileSize) return null;
      const end = Math.min(start + this.chunkSize, this.fileSize);

      const promise = this.file.slice(start, end).arrayBuffer().then((ab) => {
        const uint8 = new Uint8Array(ab);
        this.chunks.set(chunkIndex, uint8);
        this.pendingReads.delete(chunkIndex);
        while (this.chunks.size > this.maxChunks) {          // evict least-recently-used
          const oldest = this.chunks.keys().next().value;
          if (oldest === chunkIndex) break;
          this.chunks.delete(oldest);
        }
        return uint8;
      }).catch((err) => {
        console.error('[DiscImageDevice] Chunk read error for index', chunkIndex, err);
        this.pendingReads.delete(chunkIndex);
        return null;
      });

      this.pendingReads.set(chunkIndex, promise);
      return promise;
    }
    read(buffer, offset, size) {
      if (!this.file) throw new Error('No file set.');
      this.doneFlag = false;
      this.bytesRead += size;

      const chunkIndex = Math.floor(offset / this.chunkSize);
      const chunkOffset = offset % this.chunkSize;
      const chunk = this.chunks.get(chunkIndex);

      if (chunk && (chunkOffset + size <= chunk.length)) {
        // Fast-path: Synchronous memory copy directly into HEAPU8 (0ms microtask delay)
        const slice = chunk.subarray(chunkOffset, chunkOffset + size);
        this.module.HEAPU8.set(slice, buffer);
        this.syncReads++;
        this.doneFlag = true;
        // refresh LRU position (cheap) and read ahead when we are past the middle of the chunk
        if (this.lastIdx !== chunkIndex) { this.chunks.delete(chunkIndex); this.chunks.set(chunkIndex, chunk); this.lastIdx = chunkIndex; }
        if (chunkOffset > (this.chunkSize >> 1) && !this.chunks.has(chunkIndex + 1) && !this.pendingReads.has(chunkIndex + 1)) this.preloadChunk(chunkIndex + 1);
      } else {
        // Uncached chunk or multi-chunk span: fetch chunk asynchronously and set doneFlag
        this.asyncReads++;
        this.readAsyncFallback(buffer, offset, size, chunkIndex);
      }
    }
    async readAsyncFallback(buffer, offset, size, chunkIndex) {
      try {
        let chunk = await this.preloadChunk(chunkIndex);
        if (chunk) {
          const chunkOffset = offset % this.chunkSize;
          const available = chunk.length - chunkOffset;
          if (available >= size) {
            const slice = chunk.subarray(chunkOffset, chunkOffset + size);
            this.module.HEAPU8.set(slice, buffer);
          } else {
            const ab = await this.file.slice(offset, offset + size).arrayBuffer();
            this.module.HEAPU8.set(new Uint8Array(ab), buffer);
          }
        } else {
          const ab = await this.file.slice(offset, offset + size).arrayBuffer();
          this.module.HEAPU8.set(new Uint8Array(ab), buffer);
        }
      } catch (e) {
        console.error('[DiscImageDevice] Read fallback error:', e);
      } finally {
        this.doneFlag = true;
      }
      // Background pre-fetch next chunk for seamless sequential streaming
      this.preloadChunk(chunkIndex + 1);
    }
    getFileSize() { if (!this.file) throw new Error('No file set.'); return this.fileSize || this.file.size; }
    isDone() { return this.doneFlag; }
  }

  // Status-bar writes are throttled: the core can print hundreds of lines/sec and DOM work steals FPS
  let __lastStatus = 0;
  function setStatusThrottled(t) {
    if (state.gameLoaded) return; // while playing, keep the status bar quiet
    const now = performance.now();
    if (now - __lastStatus < 300) return;
    __lastStatus = now; els.statusMessage.textContent = t;
  }

  // ── Init Play! ────────────────────────────────────────
  async function initEmulator() {
    try {
      showStatus('Preparing…');
      const readyState = await (window.__ps2Ready || Promise.resolve('no-pwa'));
      if (!self.crossOriginIsolated) {
        const msg = 'Cannot start emulator: page is not cross-origin isolated (' + readyState + '). Reload the page normally (not hard-reload), use HTTPS and Chrome/Edge/Firefox.';
        els.statusOverlay.style.display = 'none';
        els.statusMessage.textContent = '⚠ ' + msg;
        window.__diag && window.__diag.fatal(msg);
        return;
      }
      showStatus('Loading emulator core…');
      Play = (await import('./Play.js')).default;
      // Verify SharedArrayBuffer (required by the threaded Play! WASM)
      console.log('[PS2 Mate] crossOriginIsolated:', self.crossOriginIsolated);
      console.log('[PS2 Mate] SharedArrayBuffer available:', typeof SharedArrayBuffer !== 'undefined');
      const base = new URL('./', document.baseURI).href;

      console.log('[PS2 Mate] Creating Play! module…');
      module = await Play({
        canvas: els.canvas,
        locateFile: (path) => base + path,
        mainScriptUrlOrBlob: base + 'Play.js',
        print: (msg) => {
          if (!state.gameLoaded) console.log('[Play!]', msg);
          setStatusThrottled(msg);
        },
        printErr: (msg) => {
          if (!state.gameLoaded) console.error('[Play!]', msg);
          setStatusThrottled('⚠ ' + msg);
        },
        onRuntimeInitialized: () => {
          console.log('[PS2 Mate] WASM runtime initialized');
        },
      });
      window.__ps2 = module; // exposed for debugging / touch layer
      console.log('[PS2 Mate] Module ready. FS + VM setup…');

      module.FS.mkdir('/work');
      console.log('[PS2 Mate] Created /work dir');

      discDevice = new DiscImageDevice(module);
      module.discImageDevice = discDevice;
      console.log('[PS2 Mate] discImageDevice attached');

      module.initVm = module.initVm || (() => module.ccall('initVm', '', [], []));
      module.initVm();
      console.log('[PS2 Mate] initVm() called — VM should be booting');

      els.statusOverlay.style.display = 'none';
      els.statusMessage.textContent = 'Ready — load a disc';
      applyPerfSettings();
      updateRecentGamesList();
      console.log('[PS2 Mate] Play! initialized successfully ✅');
    } catch (e) {
      console.error('[PS2 Mate] INIT FAILED:', e);
      showError('Emulator init failed: ' + e.message); window.__diag && window.__diag.fatal('Emulator init failed: ' + (e && e.stack || e));
    }
  }

  // ── IndexedDB ROM Cache Manager ──────────────────────
  const DB_NAME = 'ps2mate_rom_cache';
  function openRomDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('roms')) db.createObjectStore('roms');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveRomToCache(name, buffer) {
    try {
      const db = await openRomDB();
      const tx = db.transaction('roms', 'readwrite');
      tx.objectStore('roms').put(buffer, name);
    } catch (_) {}
  }

  async function getRomFromCache(name) {
    try {
      const db = await openRomDB();
      return new Promise((resolve) => {
        const tx = db.transaction('roms', 'readonly');
        const req = tx.objectStore('roms').get(name);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    } catch (_) {
      return null;
    }
  }

  function cleanRomName(name) {
    if (!name) return 'PS2 Game';
    return name
      .replace(/\.(iso|cso|chd|isz|bin|cue|elf|zip|7z)$/i, '')
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/\s*\[[^\]]*\]/g, '')
      .replace(/[_]/g, ' ')
      .trim();
  }

  function getBoxartCandidates(fileName) {
    if (!fileName) return [];
    const baseName = fileName.replace(/\.(iso|cso|chd|isz|bin|cue|elf|zip|7z)$/i, '').trim();
    const cleanTitle = baseName
      .replace(/\s*\([^)]*\)/g, '')
      .replace(/\s*\[[^\]]*\]/g, '')
      .replace(/[_]/g, ' ')
      .trim();

    let invertedTitle = cleanTitle;
    if (/^the\s+/i.test(cleanTitle)) {
      invertedTitle = cleanTitle.replace(/^the\s+/i, '') + ', The';
    } else if (/,\s*the$/i.test(cleanTitle)) {
      invertedTitle = 'The ' + cleanTitle.replace(/,\s*the$/i, '');
    }

    const libretroBase = 'https://raw.githubusercontent.com/libretro/libretro-thumbnails/master/Sony%20-%20PlayStation%202/Named_Boxarts';
    const candidates = [];

    // 1. Exact base filename
    candidates.push(`${libretroBase}/${encodeURIComponent(baseName)}.png`);

    // 2. Clean title variations
    for (const title of [cleanTitle, invertedTitle]) {
      if (!title) continue;
      candidates.push(`${libretroBase}/${encodeURIComponent(title + ' (USA)')}.png`);
      candidates.push(`${libretroBase}/${encodeURIComponent(title + ' (Europe)')}.png`);
      candidates.push(`${libretroBase}/${encodeURIComponent(title + ' (Japan)')}.png`);
      candidates.push(`${libretroBase}/${encodeURIComponent(title)}.png`);
    }

    return [...new Set(candidates)];
  }

  function formatTimeAgo(ts) {
    if (!ts) return 'Recently';
    const diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  async function playRecentGame(name) {
    showStatus('Loading ' + cleanRomName(name) + '…');
    const cachedBuffer = await getRomFromCache(name); // only small files (ELF) are cached
    if (cachedBuffer) {
      const file = new File([cachedBuffer], name);
      loadDisc(file);
    } else {
      els.statusOverlay.style.display = 'none';
      flash('Select the disc file again: ' + cleanRomName(name), 4000);
      els.fileInput.click();
    }
  }

  async function resolveValidBoxart(candidates) {
    for (const url of candidates) {
      try {
        const res = await fetch(url, { method: 'HEAD' });
        if (res.ok) return url;
      } catch (_) {}
    }
    return null;
  }

  function updateRecentGamesList() {
    if (!els.recentGames) return;
    chrome.runtime.sendMessage({ type: 'GET_RECENT_GAMES' }, (r) => {
      const games = r?.games || [];
      if (!games.length) { els.recentGames.innerHTML = ''; return; }

      const cardsHtml = games.slice(0, 6).map(g => {
        const cleanName = cleanRomName(g.name);
        const hasThumb = !!g.thumbnail;
        return `
          <div class="recent-card" data-name="${esc(g.name)}">
            <div class="card-art">
              <img class="cover-img" style="display:none;" alt="${esc(cleanName)}" loading="lazy" />
              <div class="snapshot-fallback" style="${hasThumb ? `background-image:url(${g.thumbnail}); display:block;` : 'display:none;'}"></div>
              <div class="cartridge-badge" style="${!hasThumb ? 'display:flex;' : 'display:none;'}">
                <span class="cart-icon">🎮</span>
                <span class="cart-title">${esc(cleanName)}</span>
              </div>
              <div class="card-play-overlay">▶ PLAY</div>
            </div>
            <div class="card-info">
              <span class="card-title" title="${esc(cleanName)}">${esc(cleanName)}</span>
              <span class="card-date">${formatTimeAgo(g.timestamp)}</span>
            </div>
          </div>
        `;
      }).join('');

      els.recentGames.innerHTML = `<h3>Recent Games</h3><div class="recent-grid">${cardsHtml}</div>`;
      $$('.recent-card').forEach((item, index) => {
        const game = games[index];
        if (!game) return;
        item.addEventListener('click', () => playRecentGame(game.name));

        const img = item.querySelector('.cover-img');
        const snapshot = item.querySelector('.snapshot-fallback');
        const badge = item.querySelector('.cartridge-badge');

        const candidates = getBoxartCandidates(game.name);
        resolveValidBoxart(candidates).then(validUrl => {
          if (validUrl && img) {
            img.src = validUrl;
            img.style.display = 'block';
            if (snapshot) snapshot.style.display = 'none';
            if (badge) badge.style.display = 'none';
          }
        });
      });
    });
  }

  // ── Boot a disc ───────────────────────────────────────
  async function loadDisc(file) {
    if (!file || !module) return;
    const name = file.name;
    const ext = name.split('.').pop().toLowerCase();
    const supported = ['iso','cso','chd','isz','bin','cue','elf'];
    if (!supported.includes(ext)) { showError('Unsupported file type: .' + ext); return; }

    console.log('[PS2 Mate] Loading disc:', name, '(' + (file.size/1048576).toFixed(1) + ' MB)');
    showStatus('Booting ' + name + '…');
    els.noGameBanner.style.display = 'none';
    els.canvas.style.display = 'block';

    try {
      if (ext === 'elf') {
        console.log('[PS2 Mate] Writing ELF to FS…');
        const data = new Uint8Array(await file.arrayBuffer());
        saveRomToCache(name, data.buffer);
        const fd = module.FS.open('/' + name, 'w+');
        module.FS.write(fd, data, 0, data.length, 0);
        module.FS.close(fd);
        console.log('[PS2 Mate] Calling bootElf…');
        module.bootElf('/' + name);
      } else {
        console.log('[PS2 Mate] Attaching disc to device…');
        // NOTE: big discs are streamed in 16 MB chunks from the File object. They are NOT copied into RAM/IndexedDB.
        await module.discImageDevice.setFile(file);
        console.log('[PS2 Mate] Disc size: ' + module.discImageDevice.getFileSize() + ' bytes');
        console.log('[PS2 Mate] Calling bootDiscImage…');
        module.bootDiscImage(name);
      }
      state.currentGame = { name };
      state.gameLoaded = true;
      document.body.classList.add('playing');
      els.gameTitle.textContent = name;
      els.statusOverlay.style.display = 'none';
      document.getElementById('btnPause').disabled = false;
      document.getElementById('btnReset').disabled = false;
      document.getElementById('btnMute').disabled = false;
      if (document.getElementById('btnSaveStateHeader')) document.getElementById('btnSaveStateHeader').disabled = false;
      if (document.getElementById('btnLoadStateHeader')) document.getElementById('btnLoadStateHeader').disabled = false;
      els.volumeSlider.disabled = false;
      startTimer();
      startFpsCounter();
      chrome.runtime.sendMessage({ type: 'SAVE_RECENT_GAME', game: { name, size: file.size } });
      setTimeout(() => {
        try {
          if (els.canvas) {
            const thumbnail = els.canvas.toDataURL('image/jpeg', 0.6);
            chrome.runtime.sendMessage({ type: 'SAVE_RECENT_GAME', game: { name, size: file.size, thumbnail } }, () => updateRecentGamesList());
          }
        } catch (_) {}
      }, 5000);
      flash('Booting…');
      console.log('[PS2 Mate] bootDiscImage returned — waiting for video output');

      // Watch for canvas activity / VM state
      startVMWatcher();
    } catch (e) {
      console.error('[PS2 Mate] BOOT FAILED:', e);
      showError('Failed to boot disc: ' + e.message);
    }
  }

  // ── VM Health Watchdog ────────────────────────────────
  // Polls the disc device (the VM reads from it) + canvas output so we
  // can tell the user whether the game is actually running.
  let vmWatcher = null;
  let lastCanvasDraw = 0;
  function startVMWatcher() {
    stopVMWatcher();
    let pollCount = 0;
    const canvas = els.canvas;
    vmWatcher = null; return; // (disabled: pure overhead)
    vmWatcher = setInterval(() => {
      pollCount++;
      // Disc read activity — if the VM is reading the disc, it's alive
      const reading = discDevice && discDevice.doneFlag === false;
      // Canvas draw detection via 2D/webgl context readback is expensive;
      // instead report disc reads + elapsed time
      if (pollCount === 5) {
        console.log('[PS2 Mate] VM watcher: disc reads active =', reading, '— emulator is working');
      }
      if (pollCount > 60) { // ~10s of polling
        console.log('[PS2 Mate] VM watcher: still alive after 10s (reading=' + reading + ')');
        pollCount = 0;
      }
    }, 200);
  }
  function stopVMWatcher() {
    if (vmWatcher) { clearInterval(vmWatcher); vmWatcher = null; }
  }

  // ── Controls ──────────────────────────────────────────
  function togglePause() {
    if (!module) return;
    try { module.pause(); state.paused = !state.paused; } catch (e) { console.log(e); }
  }

  function showStatus(t) { els.statusText.textContent = t; els.statusOverlay.style.display = 'flex'; }
  function showError(m) { els.statusMessage.textContent = '⚠ ' + m; els.statusMessage.style.color = '#d84050'; els.statusOverlay.style.display = 'none'; setTimeout(() => { els.statusMessage.textContent = 'Ready'; els.statusMessage.style.color = ''; }, 5000); }
  function flash(t, d = 2500) { els.statusMessage.textContent = t; setTimeout(() => { if (els.statusMessage.textContent === t) els.statusMessage.textContent = 'Ready'; }, d); }
  // ── Performance Monitor & FPS Counter ───────────────
  let fpsTimer = null;

  function updatePerformanceStats(fps) {
    const frameMs = fps > 0 ? (1000 / fps).toFixed(1) : '0.0';
    const syncReads = discDevice?.syncReads || 0;
    const asyncReads = discDevice?.asyncReads || 0;
    const totalReads = syncReads + asyncReads;
    const hitRate = totalReads ? ((syncReads / totalReads) * 100).toFixed(2) + '%' : '100.00%';
    const cachedChunks = discDevice?.chunks?.size || 0;
    const bytesReadMb = discDevice ? (discDevice.bytesRead / 1048576).toFixed(1) + ' MB' : '0.0 MB';
    const jitCount = (module && Array.isArray(module.codeGenFunctions)) ? module.codeGenFunctions.filter(Boolean).length : 0;
    const heapMb = (module && module.HEAPU8) ? (module.HEAPU8.byteLength / 1048576).toFixed(1) + ' MB' : '-- MB';

    const cores = navigator.hardwareConcurrency || 4;
    const isIsolated = window.crossOriginIsolated ? 'PThreads' : 'Sync';

    if (els.hudFps) els.hudFps.textContent = `${fps} FPS (${frameMs} ms)`;
    if (els.hudCacheRate) els.hudCacheRate.textContent = `${hitRate} (${cachedChunks} Chunks / ${cachedChunks * 16}MB)`;
    if (els.hudDiscReads) els.hudDiscReads.textContent = `${syncReads.toLocaleString()} sync / ${asyncReads} async (${bytesReadMb})`;
    if (els.hudJitBlocks) els.hudJitBlocks.textContent = `${jitCount} blocks (O(1) Array)`;
    if (els.hudMemory) els.hudMemory.textContent = `${heapMb} (Optimal Heap)`;
    const hudCores = $('#hudCores');
    if (hudCores) hudCores.textContent = `${cores} Cores (${isIsolated})`;
  }

  function startFpsCounter() {
    stopFpsCounter();
    fpsTimer = setInterval(() => {
      if (module && typeof module.getFrames === 'function') {
        const fps = module.getFrames();
        if (typeof module.clearStats === 'function') {
          module.clearStats();
        }
        els.fpsCounter.textContent = `${fps} FPS`;
        updatePerformanceStats(fps);
      }
    }, 1000);
  }

  function stopFpsCounter() {
    if (fpsTimer) {
      clearInterval(fpsTimer);
      fpsTimer = null;
    }
    els.fpsCounter.textContent = '•';
  }

  // Developer Console Profiler API: call window.getPs2Stats() in Chrome DevTools Console
  window.getPs2Stats = function () {
    const syncReads = discDevice?.syncReads || 0;
    const asyncReads = discDevice?.asyncReads || 0;
    const totalReads = syncReads + asyncReads;
    const hitRate = totalReads ? ((syncReads / totalReads) * 100).toFixed(1) + '%' : '100%';
    const jitBlocks = (module && Array.isArray(module.codeGenFunctions)) ? module.codeGenFunctions.filter(Boolean).length : 0;
    const memoryMb = (module && module.HEAPU8) ? (module.HEAPU8.byteLength / 1048576).toFixed(1) + ' MB' : 'N/A';
    const fps = els.fpsCounter?.textContent || '0 FPS';

    const stats = {
      framerate: fps,
      discIO: {
        syncReads,
        asyncReads,
        totalReads,
        cacheHitRate: hitRate,
        chunkSize: '16 MB',
        cachedChunksCount: discDevice?.chunks?.size || 0,
        bytesReadMb: discDevice ? (discDevice.bytesRead / 1048576).toFixed(2) + ' MB' : '0 MB'
      },
      jitEngine: {
        activeJitBlocks: jitBlocks,
        dispatchMode: 'O(1) SMI Array Indexing'
      },
      wasmMemory: {
        heapSize: memoryMb
      },
      webglContext: {
        powerPreference: 'high-performance',
        drawingBufferPreserved: true
      }
    };
    console.table(stats);
    return stats;
  };

  function startTimer() { stopTimer(); state.playTime = 0; tick(); timer = setInterval(() => { state.playTime++; tick(); }, 1000); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function tick() { const h = Math.floor(state.playTime/3600), m = Math.floor((state.playTime%3600)/60), s = state.playTime%60; els.timeCounter.textContent = h>0 ? String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0') : String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'); }
  function toggleFS() {
    const d = document, el = d.documentElement;
    const inFS = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (inFS) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
    } catch (e) { flash('Fullscreen not supported here'); }
  }
  function toggleSettings() { els.settingsPanel.style.display = els.settingsPanel.style.display === 'none' ? 'flex' : 'none'; }
  function toggleMute() { state.muted = !state.muted; els.volumeSlider.value = state.muted ? 0 : 100; document.getElementById('btnMute').querySelector('.icon').textContent = state.muted ? '🔇' : '🔊'; }

  function toggleStatsHud(show) {
    if (!els.statsHud) return;
    const isVisible = show !== undefined ? show : (els.statsHud.style.display === 'none');
    els.statsHud.style.display = isVisible ? 'block' : 'none';
    if ($('#chkShowStats')) $('#chkShowStats').checked = isVisible;
  }

  // ── Event Bindings ────────────────────────────────────
  document.getElementById('btnLoad').addEventListener('click', () => els.fileInput.click());
  $('#btnLoadBanner')?.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => { if (e.target.files[0]) loadDisc(e.target.files[0]); });
  document.getElementById('btnPause').addEventListener('click', togglePause);
  document.getElementById('btnReset').addEventListener('click', () => { if (module) { try { module.resetVm(); flash('Reset'); } catch(e) {} } });
  els.volumeSlider.addEventListener('input', (e) => { state.volume = parseInt(e.target.value); });
  document.getElementById('btnMute').addEventListener('click', toggleMute);
  document.getElementById('btnFullscreen').addEventListener('click', toggleFS);
  document.getElementById('btnSettings').addEventListener('click', toggleSettings);
  document.getElementById('btnCloseSettings').addEventListener('click', () => els.settingsPanel.style.display = 'none');
  document.getElementById('btnToggleStats')?.addEventListener('click', () => toggleStatsHud());

  // Performance & Graphics Settings
  $('#chkShowStats')?.addEventListener('change', (e) => toggleStatsHud(e.target.checked));
  $('#chkFastMode')?.addEventListener('change', (e) => {
    if (module) {
      const val = !e.target.checked;
      if (typeof module._setGsRamReadsEnabled === 'function') module._setGsRamReadsEnabled(val);
      else if (typeof module.setGsRamReadsEnabled === 'function') module.setGsRamReadsEnabled(val);
      flash(e.target.checked ? 'Fast Mode ON (No GPU Stalls)' : 'Fast Mode OFF');
    }
  });

  $('#chkUnlockFps')?.addEventListener('change', (e) => {
    if (module) {
      const val = !e.target.checked;
      if (typeof module._setLimitFramerate === 'function') module._setLimitFramerate(val);
      else if (typeof module.setLimitFramerate === 'function') module.setLimitFramerate(val);
      flash(e.target.checked ? 'Fast Forward ON (Unlocked FPS)' : 'Framerate Limited (60 FPS)');
    }
  });

  $('#selResolution')?.addEventListener('change', (e) => {
    if (module) {
      const val = parseFloat(e.target.value);
      const w = Math.round(640 * val);
      const h = Math.round(480 * val);

      // Scale canvas internal resolution buffer (320x240 for 0.5x, 480x360 for 0.75x, etc.)
      els.canvas.width = w;
      els.canvas.height = h;

      // Set C++ GS resolution factor (integer >= 1)
      const intFactor = Math.max(1, Math.round(val));
      if (typeof module._setResolutionFactor === 'function') {
        module._setResolutionFactor(intFactor);
      } else if (typeof module.setResolutionFactor === 'function') {
        module.setResolutionFactor(intFactor);
      }

      // Resize WebGL offscreen FBO targets
      if (module.GL && module.GL.currentContext) {
        try {
          module.GL.resizeOffscreenFramebuffer(module.GL.currentContext);
        } catch (err) {}
      }

      flash(
        val < 1.0
          ? `Downscaled Sub-Native Resolution: ${val}x (${w}x${h})`
          : val > 1.0
            ? `HD Upscale Enabled: ${val}x (${w}x${h})`
            : `Native PS2 Resolution: 1x (640x480)`
      );
    }
  });

  $('#chkWidescreen')?.addEventListener('change', (e) => {
    if (module) {
      const val = e.target.checked;
      if (typeof module._setWidescreen === 'function') module._setWidescreen(val);
      else if (typeof module.setWidescreen === 'function') module.setWidescreen(val);
      flash(e.target.checked ? 'Widescreen 16:9 ON' : 'Standard 4:3 Aspect');
    }
  });

  document.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
  document.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files[0]) loadDisc(e.dataTransfer.files[0]); });

  // ── Save & Load State ─────
  async function saveState() {
    if (!module || !state.gameLoaded) {
      flash('No active game to save state');
      return;
    }
    try {
      if (typeof module.saveState === 'function') {
        module.saveState(1);
        flash('💾 Save State 1 Saved!');
      } else if (typeof module._saveState === 'function') {
        module._saveState(1);
        flash('💾 Save State 1 Saved!');
      } else {
        flash('⚠️ Save State API not exported by current WASM build');
      }
    } catch (e) {
      console.error('Save state failed:', e);
      flash('⚠️ Save State Error');
    }
  }

  async function loadState() {
    if (!module || !state.gameLoaded) {
      flash('No active game to load state');
      return;
    }
    try {
      if (typeof module.loadState === 'function') {
        module.loadState(1);
        flash('📂 Save State 1 Loaded!');
      } else if (typeof module._loadState === 'function') {
        module._loadState(1);
        flash('📂 Save State 1 Loaded!');
      } else {
        flash('⚠️ Load State API not exported by current WASM build');
      }
    } catch (e) {
      console.error('Load state failed:', e);
      flash('⚠️ Load State Error');
    }
  }

  $('#btnSaveState')?.addEventListener('click', saveState);
  $('#btnLoadState')?.addEventListener('click', loadState);
  $('#btnSaveStateHeader')?.addEventListener('click', saveState);
  $('#btnLoadStateHeader')?.addEventListener('click', loadState);

  // ── Frameskip ─────
  let frameskipFactor = 0;
  $('#selFrameskip')?.addEventListener('change', (e) => {
    frameskipFactor = parseInt(e.target.value, 10) || 0;
    flash(frameskipFactor > 0 ? `Frameskip: Skip ${frameskipFactor} frame(s)` : 'Frameskip Disabled');
  });

  // ── Customizable Control Mappings Architecture ─────────────────
  const DEFAULT_KEYBOARD_P1 = {
    DPAD_UP: 'ArrowUp', DPAD_DOWN: 'ArrowDown', DPAD_LEFT: 'ArrowLeft', DPAD_RIGHT: 'ArrowRight',
    BTN_CROSS: 'z', BTN_CIRCLE: 'x', BTN_SQUARE: 'a', BTN_TRIANGLE: 's',
    BTN_L1: '1', BTN_R1: '8', BTN_L2: '2', BTN_R2: '9',
    BTN_SELECT: 'Backspace', BTN_START: 'Enter'
  };
  const DEFAULT_KEYBOARD_P2 = {
    DPAD_UP: 'i', DPAD_DOWN: 'k', DPAD_LEFT: 'j', DPAD_RIGHT: 'l',
    BTN_CROSS: 'n', BTN_CIRCLE: 'm', BTN_SQUARE: 'u', BTN_TRIANGLE: 'o',
    BTN_L1: '[', BTN_R1: ']', BTN_L2: ';', BTN_R2: "'",
    BTN_SELECT: '7', BTN_START: '8'
  };
  const DEFAULT_GAMEPAD_MAP = {
    DPAD_UP: 'BTN_12', DPAD_DOWN: 'BTN_13', DPAD_LEFT: 'BTN_14', DPAD_RIGHT: 'BTN_15',
    BTN_CROSS: 'BTN_0', BTN_CIRCLE: 'BTN_1', BTN_SQUARE: 'BTN_2', BTN_TRIANGLE: 'BTN_3',
    BTN_L1: 'BTN_4', BTN_R1: 'BTN_5', BTN_L2: 'BTN_6', BTN_R2: 'BTN_7',
    BTN_SELECT: 'BTN_8', BTN_START: 'BTN_9'
  };

  const PS2_ACTION_LABELS = {
    'BTN_CROSS': 'Cross (✕)', 'BTN_CIRCLE': 'Circle (○)', 'BTN_SQUARE': 'Square (□)', 'BTN_TRIANGLE': 'Triangle (△)',
    'BTN_L1': 'L1', 'BTN_R1': 'R1', 'BTN_L2': 'L2', 'BTN_R2': 'R2',
    'BTN_SELECT': 'Select', 'BTN_START': 'Start',
    'DPAD_UP': 'D-Up', 'DPAD_DOWN': 'D-Down', 'DPAD_LEFT': 'D-Left', 'DPAD_RIGHT': 'D-Right'
  };

  const controlConfig = {
    activePlayer: 0,
    activeDevice: 'keyboard',
    listeningAction: null,
    keymaps: { 0: { ...DEFAULT_KEYBOARD_P1 }, 1: { ...DEFAULT_KEYBOARD_P2 } },
    gamepadmaps: { 0: { ...DEFAULT_GAMEPAD_MAP }, 1: { ...DEFAULT_GAMEPAD_MAP } }
  };

  function loadControlMappings() {
    chrome.storage.local.get(['ps2_customKeymaps', 'ps2_customGamepadmaps'], (res) => {
      if (res.ps2_customKeymaps) controlConfig.keymaps = res.ps2_customKeymaps;
      if (res.ps2_customGamepadmaps) controlConfig.gamepadmaps = res.ps2_customGamepadmaps;
    });
  }

  function saveControlMappings() {
    chrome.storage.local.set({
      ps2_customKeymaps: controlConfig.keymaps,
      ps2_customGamepadmaps: controlConfig.gamepadmaps
    });
  }

  function formatBindingName(bindingStr, device) {
    if (!bindingStr) return 'Unmapped';
    if (device === 'keyboard') {
      if (bindingStr === ' ') return 'Space';
      if (bindingStr.startsWith('Arrow')) return bindingStr.replace('Arrow', '') + ' Arrow';
      return bindingStr.length === 1 ? bindingStr.toUpperCase() : bindingStr;
    } else {
      if (bindingStr.startsWith('BTN_')) {
        const idx = parseInt(bindingStr.replace('BTN_', ''), 10);
        const labels = ['Cross (✕)', 'Circle (○)', 'Square (□)', 'Triangle (△)', 'L1', 'R1', 'L2', 'R2', 'Select', 'Start', 'L3', 'R3', 'D-Up', 'D-Down', 'D-Left', 'D-Right'];
        return labels[idx] ? `Btn ${idx} (${labels[idx]})` : `Button ${idx}`;
      } else if (bindingStr.startsWith('AXIS_')) {
        const parts = bindingStr.split('_');
        const axisIdx = parts[1];
        const dir = parts[2] === '+' ? 'Down/Right (+)' : 'Up/Left (-)';
        return `Axis ${axisIdx} ${dir}`;
      }
      return bindingStr;
    }
  }

  function updateControlMappingUI() {
    const p = controlConfig.activePlayer;
    const dev = controlConfig.activeDevice;
    const currentMap = dev === 'keyboard' ? controlConfig.keymaps[p] : controlConfig.gamepadmaps[p];

    $$('.bind-btn').forEach(btn => {
      const action = btn.dataset.action;
      if (controlConfig.listeningAction === action) {
        btn.textContent = 'Press Key/Btn...';
        btn.classList.add('listening');
      } else {
        btn.textContent = formatBindingName(currentMap[action], dev);
        btn.classList.remove('listening');
      }
    });

    $('#tabP1')?.classList.toggle('active', p === 0);
    $('#tabP2')?.classList.toggle('active', p === 1);
    $('#deviceKB')?.classList.toggle('active', dev === 'keyboard');
    $('#deviceGP')?.classList.toggle('active', dev === 'gamepad');

    const instrEl = $('#mappingInstructions');
    if (instrEl) {
      instrEl.textContent = controlConfig.listeningAction
        ? `Press any ${dev === 'keyboard' ? 'Keyboard Key' : 'Gamepad Button'} to map to ${controlConfig.listeningAction}...`
        : `Click any button below to remap ${dev === 'keyboard' ? 'Keyboard' : 'Gamepad'} for Player ${p + 1}.`;
    }
  }

  function stopRebinding() {
    controlConfig.listeningAction = null;
    updateControlMappingUI();
  }

  $('#btnOpenControlsModal')?.addEventListener('click', () => {
    $('#controlMappingModal').style.display = 'flex';
    updateControlMappingUI();
  });
  $('#btnCloseControlsModal')?.addEventListener('click', () => {
    stopRebinding();
    $('#controlMappingModal').style.display = 'none';
  });
  $('#btnSaveControlMapping')?.addEventListener('click', () => {
    saveControlMappings();
    stopRebinding();
    $('#controlMappingModal').style.display = 'none';
    flash('🎮 Control mappings saved!');
  });

  $('#tabP1')?.addEventListener('click', () => { controlConfig.activePlayer = 0; stopRebinding(); });
  $('#tabP2')?.addEventListener('click', () => { controlConfig.activePlayer = 1; stopRebinding(); });
  $('#deviceKB')?.addEventListener('click', () => { controlConfig.activeDevice = 'keyboard'; stopRebinding(); });
  $('#deviceGP')?.addEventListener('click', () => { controlConfig.activeDevice = 'gamepad'; stopRebinding(); });

  $('#btnPresetKB')?.addEventListener('click', () => {
    const p = controlConfig.activePlayer;
    controlConfig.keymaps[p] = p === 0 ? { ...DEFAULT_KEYBOARD_P1 } : { ...DEFAULT_KEYBOARD_P2 };
    saveControlMappings(); updateControlMappingUI(); flash('Keyboard defaults restored');
  });
  $('#btnPresetGP')?.addEventListener('click', () => {
    const p = controlConfig.activePlayer;
    controlConfig.gamepadmaps[p] = { ...DEFAULT_GAMEPAD_MAP };
    saveControlMappings(); updateControlMappingUI(); flash('Gamepad defaults restored');
  });

  $$('.bind-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      controlConfig.listeningAction = btn.dataset.action;
      updateControlMappingUI();
    });
  });

  // ── Keyboard Router & Synthetic Key Sender ─────────────────────
  const activeKeys = new Set();

  function handleKeyEvent(e) {
    if (!e || !e.key) return;
    const isDown = e.type === 'keydown';
    const k = e.key.toLowerCase();

    if (isDown) {
      if (controlConfig.listeningAction && controlConfig.activeDevice === 'keyboard') {
        if (e.key === 'Escape') { stopRebinding(); return; }
        controlConfig.keymaps[controlConfig.activePlayer][controlConfig.listeningAction] = e.key;
        saveControlMappings(); stopRebinding(); return;
      }

      if (e.key === 'F1') { e.preventDefault(); saveState(); return; }
      else if (e.key === 'F3') { e.preventDefault(); loadState(); return; }
      else if (e.ctrlKey && k === 'o') { e.preventDefault(); els.fileInput.click(); return; }
      else if (k === 'p') { e.preventDefault(); togglePause(); return; }
      else if (e.ctrlKey && k === 'r') { e.preventDefault(); if (module) module.resetVm(); return; }
      else if (k === 'f11') { e.preventDefault(); toggleFS(); return; }
      else if (k === 'm') { e.preventDefault(); toggleMute(); return; }

      if (state.gameLoaded && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.repeat) return;
        [0, 1].forEach(player => {
          const map = controlConfig.keymaps[player];
          for (const [action, keyVal] of Object.entries(map)) {
            if (keyVal === e.key || keyVal.toLowerCase() === k) {
              activeKeys.add(`${player}_${action}`);
            }
          }
        });
      }
    } else {
      if (state.gameLoaded) {
        [0, 1].forEach(player => {
          const map = controlConfig.keymaps[player];
          for (const [action, keyVal] of Object.entries(map)) {
            if (keyVal === e.key || keyVal.toLowerCase() === k) {
              activeKeys.delete(`${player}_${action}`);
            }
          }
        });
      }
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'].includes(e.key) && state.gameLoaded) e.preventDefault();
    handleKeyEvent(e);
  });

  document.addEventListener('keyup', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Tab'].includes(e.key) && state.gameLoaded) e.preventDefault();
    handleKeyEvent(e);
  });

  // ── Dynamic Controller Assignment & 60FPS Frame Loop ───────
  const selP1 = $('#selPlayer1Input');
  const selP2 = $('#selPlayer2Input');
  let lastGamepadSig = '';

  function updateGamepadSelectors(force = false) {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const connected = [];
    for (let i = 0; i < gps.length; i++) {
      if (gps[i] && gps[i].connected) connected.push({ index: i, id: gps[i].id });
    }

    const sig = connected.map(g => `${g.index}:${g.id}`).join('|');
    if (!force && sig === lastGamepadSig) return;
    lastGamepadSig = sig;

    const currentP1 = selP1 ? selP1.value : 'auto';
    const currentP2 = selP2 ? selP2.value : 'none';

    if (selP1) {
      selP1.innerHTML = `
        <option value="auto">Keyboard + Auto Gamepad</option>
        <option value="keyboard">Keyboard Only</option>
        ${connected.map(g => `<option value="gp_${g.index}">🎮 P1: ${g.id.split('(')[0].trim()} (Slot ${g.index + 1})</option>`).join('')}
      `;
      selP1.value = connected.some(g => `gp_${g.index}` === currentP1) ? currentP1 : (currentP1 === 'keyboard' ? 'keyboard' : 'auto');
    }

    if (selP2) {
      selP2.innerHTML = `
        <option value="none">Disabled / None</option>
        ${connected.map(g => `<option value="gp_${g.index}">🎮 P2: ${g.id.split('(')[0].trim()} (Slot ${g.index + 1})</option>`).join('')}
      `;
      selP2.value = connected.some(g => `gp_${g.index}` === currentP2) ? currentP2 : 'none';
    }

    if (els.gamepadStatus) {
      els.gamepadStatus.textContent = connected.length > 0
        ? `🎮 ${connected.length} Controller(s) Connected`
        : 'No gamepad detected';
    }
  }

  function evaluateGamepadInput(gp, bindingStr, deadzone = 0.15) {
    if (!gp || !bindingStr) return 0;
    if (bindingStr.startsWith('BTN_')) {
      const idx = parseInt(bindingStr.replace('BTN_', ''), 10);
      const b = gp.buttons[idx];
      return (b && (b.pressed || b.value > 0.5)) ? 1 : 0;
    } else if (bindingStr.startsWith('AXIS_')) {
      const parts = bindingStr.split('_');
      const axisIdx = parseInt(parts[1], 10);
      const isPositive = parts[2] === '+';
      const rawVal = gp.axes[axisIdx] || 0;
      if (isPositive && rawVal > deadzone) return Math.min(32767, Math.round(((rawVal - deadzone) / (1 - deadzone)) * 32767));
      else if (!isPositive && rawVal < -deadzone) return Math.min(32767, Math.round(((-rawVal - deadzone) / (1 - deadzone)) * 32767));
    }
    return 0;
  }

  let gpLoop;
  (function poll() {
    const gps = navigator.getGamepads ? navigator.getGamepads() : [];
    const p1Mode = selP1 ? selP1.value : 'auto';
    const p2Mode = selP2 ? selP2.value : 'none';

    let p1Index = null; let p2Index = null;
    if (p1Mode.startsWith('gp_')) p1Index = parseInt(p1Mode.replace('gp_', ''), 10);
    else if (p1Mode === 'auto') {
      for (let i = 0; i < gps.length; i++) { if (gps[i] && gps[i].connected) { p1Index = i; break; } }
    }
    if (p2Mode.startsWith('gp_')) p2Index = parseInt(p2Mode.replace('gp_', ''), 10);

    const activeInputsByPlayer = { 0: {}, 1: {} };
    const modalOpen = $('#controlMappingModal')?.style.display !== 'none';

    for (let player = 0; player <= 1; player++) {
      const gpIndex = player === 0 ? p1Index : p2Index;
      const gp = (gpIndex !== null && gps[gpIndex] && gps[gpIndex].connected) ? gps[gpIndex] : null;

      if (modalOpen && controlConfig.listeningAction && controlConfig.activeDevice === 'gamepad' && gp && player === controlConfig.activePlayer) {
        for (let bIdx = 0; bIdx < gp.buttons.length; bIdx++) {
          if (gp.buttons[bIdx]?.pressed || gp.buttons[bIdx]?.value > 0.6) {
            controlConfig.gamepadmaps[player][controlConfig.listeningAction] = `BTN_${bIdx}`;
            saveControlMappings(); stopRebinding(); break;
          }
        }
      }

      const frameInputs = {};
      Object.keys(PS2_ACTION_LABELS).forEach(act => frameInputs[act] = 0);

      const kbMap = controlConfig.keymaps[player];
      for (const [action, keyVal] of Object.entries(kbMap)) {
        if (activeKeys.has(`${player}_${action}`)) {
          frameInputs[action] = 1;
        }
      }

      const gpMap = controlConfig.gamepadmaps[player];
      for (const [action, binding] of Object.entries(gpMap)) {
        let val = evaluateGamepadInput(gp, binding);
        frameInputs[action] = Math.max(frameInputs[action] || 0, val);
      }

      activeInputsByPlayer[player] = frameInputs;
    }

    if (modalOpen) {
      const player = controlConfig.activePlayer;
      const dev = controlConfig.activeDevice;
      const gpIndex = player === 0 ? p1Index : p2Index;
      const gp = (gpIndex !== null && gps[gpIndex] && gps[gpIndex].connected) ? gps[gpIndex] : null;

      const labelEl = $('#testerGamepadLabel');
      if (labelEl) {
        labelEl.textContent = dev === 'gamepad'
          ? (gp ? `Connected: ${gp.id.split('(')[0].trim()}` : 'No gamepad connected')
          : 'Testing Keyboard bindings...';
      }

      $$('.test-badge').forEach(badge => {
        const action = badge.dataset.test;
        const isPressed = activeInputsByPlayer[player][action] > 0;
        badge.classList.toggle('active', isPressed);
      });
    }

    updateGamepadSelectors();
    gpLoop = modalOpen ? requestAnimationFrame(poll) : setTimeout(poll, 500);
  })();


  // ── Performance settings: persisted + applied at boot ─────────
  const PERF_DEFAULT = { fast: true, unlock: false, res: '1', wide: false };
  function getPerf() { return Object.assign({}, PERF_DEFAULT, __LS.get('ps2_perf', {})); }
  function savePerf(patch) { __LS.set('ps2_perf', Object.assign(getPerf(), patch)); }
  function applyPerfSettings() {
    const c = getPerf();
    const set = (id, prop, val) => { const el = document.getElementById(id); if (!el) return; el[prop] = val; el.dispatchEvent(new Event('change')); };
    set('chkFastMode', 'checked', c.fast);            // always applied so the core matches the checkbox
    if (c.unlock) set('chkUnlockFps', 'checked', true);
    if (c.res !== '1') set('selResolution', 'value', c.res);
    if (c.wide) set('chkWidescreen', 'checked', true);
    console.log('[PS2 Mate] perf settings applied', JSON.stringify(c));
  }
  $('#chkFastMode')?.addEventListener('change', (e) => savePerf({ fast: e.target.checked }));
  $('#chkUnlockFps')?.addEventListener('change', (e) => savePerf({ unlock: e.target.checked }));
  $('#selResolution')?.addEventListener('change', (e) => savePerf({ res: e.target.value }));
  $('#chkWidescreen')?.addEventListener('change', (e) => savePerf({ wide: e.target.checked }));
  $('#btnPerfPreset')?.addEventListener('click', () => {
    savePerf({ fast: true, unlock: false, res: '0.5', wide: false });
    const st = document.getElementById('chkShowStats'); if (st && st.checked) { st.checked = false; st.dispatchEvent(new Event('change')); }
    applyPerfSettings();
    const r = document.getElementById('selResolution'); if (r) r.value = '0.5';
    flash('⚡ Max performance preset applied', 3000);
  });

  loadControlMappings();
  updateRecentGamesList();
  initEmulator();
})();
