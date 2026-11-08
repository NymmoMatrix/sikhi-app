/* Sikhi — service worker
   Shell + data are precached so the app opens and reads with no signal.
   Images are cached on demand (274 of them would be wasteful to precache).
   The Hukamnama is network-first with a cached fallback. */

const VERSION = 'sikhi-v24';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
  './fonts/gurmukhi-serif.ttf', './fonts/gurmukhi-serif-regular.ttf',
  './data/bani-index.json', './data/quotes.json',
  './data/hukamnama.json', './data/calendar.json',
];
/* Per-bani verse files (data/bani-*.json) are NOT precached — they are pulled
   on demand and then cached by the same-origin cache-first branch below, so a
   bani becomes offline-readable the first time it is opened. */

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // addAll is all-or-nothing; add individually so one 404 can't break install
    await Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    // deliberately NOT skipWaiting(): a new worker waits until the page asks it
    // to take over, so a running recitation is never swapped out mid-read.
  })());
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Hukamnama API — try network, fall back to the last good response
  if (url.hostname === 'api.banidb.com') {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(VERSION);
        e.waitUntil(c.put(req, fresh.clone()));
        return fresh;
      } catch {
        const hit = await caches.match(req);
        return hit || new Response('{}', { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // same-origin only from here
  if (url.origin !== location.origin) return;

  // The archive index gains a row every day: network-first so a newly archived
  // day shows up as soon as there is a connection, cached copy when offline.
  if (url.pathname.endsWith('/data/hukam-index.json')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(VERSION);
        e.waitUntil(c.put(req, fresh.clone()));
        return fresh;
      } catch {
        const hit = await caches.match(req);
        return hit || new Response('{"count":0,"days":[]}',
          { headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // Audio (a recitation): cache-first, and answer byte-range requests out of
  // the cached copy so seeking works offline instead of restarting at 0.
  // Cached on first open (a page-side fetch, which carries no Range header) —
  // a few MB per bani is too much to precache at install.
  if (/\.(m4a|mp3|aac|m4b|opus|ogg|oga|wav)$/i.test(url.pathname)) {
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const key = url.origin + url.pathname;
      const hit = await cache.match(key);
      const range = req.headers.get('range');
      if (hit) {
        if (!range) return hit;
        const buf = await hit.arrayBuffer();
        const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
        let start, end;
        if (!m[1] && m[2]) {                     // suffix range: the last N bytes
          start = Math.max(0, buf.byteLength - parseInt(m[2], 10));
          end = buf.byteLength - 1;
        } else {
          start = m[1] ? parseInt(m[1], 10) : 0;
          end = m[2] ? parseInt(m[2], 10) : buf.byteLength - 1;
        }
        if (!(start >= 0) || start >= buf.byteLength || start > end) {
          start = 0;
          end = buf.byteLength - 1;
        }
        end = Math.min(end, buf.byteLength - 1);
        return new Response(buf.slice(start, end + 1), {
          status: 206,
          statusText: 'Partial Content',
          headers: {
            'Content-Type': hit.headers.get('Content-Type') || 'audio/mp4',
            'Content-Range': `bytes ${start}-${end}/${buf.byteLength}`,
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
          },
        });
      }
      const res = await fetch(req);
      if (res.ok && res.status === 200) await cache.put(key, res.clone());
      return res;
    })());
    return;
  }

  // everything else: cache-first, refresh in the background
  e.respondWith((async () => {
    const hit = await caches.match(req);
    // The write must be awaited (or held open with waitUntil). A fire-and-forget
    // put is dropped when the worker is torn down straight after responding --
    // that is why per-bani files never reached the cache.
    const net = fetch(req).then(async res => {
      if (res.ok) {
        const c = await caches.open(VERSION);
        await c.put(req, res.clone());
      }
      return res;
    }).catch(() => null);
    return hit || (await net) || new Response('offline', { status: 503 });
  })());
});
