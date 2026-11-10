// sw.js — 오프라인에서도 열리게 앱 파일을 보관한다.
// 온라인이면 항상 서버의 최신 파일을 쓰고(보관본도 갱신), 연결이 없을 때만 보관본을 쓴다 → 업데이트가 늦게 반영되는 일이 없다.
const CACHE = 'tabsheet-v1';
const SHELL = ['./', 'index.html', 'app.js', 'core.js', 'stitch.js', 'pdf.js', 'media.js', 'timefmt.js', 'detect.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  const name = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  // 앱 파일만 다룬다. 영상(videos/ 목록, blob)이나 다른 요청은 건드리지 않는다.
  if (e.request.method !== 'GET' || url.origin !== location.origin || !SHELL.includes(name === '' ? './' : name)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
