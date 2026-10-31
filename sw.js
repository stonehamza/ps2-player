/* PS2 Web — Service Worker v2
 * - Adds COOP/COEP so SharedArrayBuffer works on GitHub Pages
 * - Network-first for code (always fresh when online), cache-first for wasm/icons, full offline fallback
 */
const CACHE = 'ps2-web-v2.4.0';
const CORE = [
  './', 'index.html', 'index.css', 'index.js', 'pwa.js', 'diag.js', 'touch.js', 'manifest.webmanifest',
  'Play.js', 'Play.wasm',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(CORE.map((u) => c.add(new Request(u, { cache: 'reload' })))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ps2-web-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function iso(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque' || resp.type === 'opaqueredirect') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'cross-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\.(iso|chd|bin)$/i.test(url.pathname)) return; // never cache/proxy disc images

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const heavy = /\.(wasm|png)$/i.test(url.pathname);
    if (heavy) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return iso(hit);
    }
    try {
      const res = await fetch(req);
      if (res.status === 200 && res.type === 'basic') cache.put(req, res.clone()).catch(() => {});
      return iso(res);
    } catch (err) {
      let hit = await cache.match(req, { ignoreSearch: true });
      if (!hit && req.mode === 'navigate') hit = await cache.match('index.html') || await cache.match('./');
      return hit ? iso(hit) : new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
