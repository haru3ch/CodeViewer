// オフラインでもアプリ本体が開けるようにするための Service Worker。
// アプリのファイルだけをキャッシュする（AI への通信はキャッシュしない）。
// アプリを更新したら VERSION を上げる。
const VERSION = 'v17';
const CACHE = `code-reader-${VERSION}`;
const SHELL = [
  './', 'index.html', 'style.css', 'manifest.webmanifest',
  'js/main.js', 'js/debug.js', 'js/gemini.js', 'js/find.js', 'js/outline.js', 'js/db.js', 'js/files.js', 'js/viewer.js', 'js/ai.js', 'js/chat.js',
  'vendor/vendor.js',
  'fonts/fonts.css', 'fonts/jetbrains-mono-latin-400-normal.woff2', 'fonts/jetbrains-mono-latin-700-normal.woff2',
  'icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// キャッシュを先に返しつつ、裏で新しい版を取りに行く（次に開いたときに反映）
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const net = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { e.waitUntil(net); return hit; }
    return (await net) || (await cache.match('index.html')) || Response.error();
  })());
});
