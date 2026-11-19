// Service worker: caches the app shell so the app opens offline with previously captured rosters.
// Only this app's own files are cached. Google and Sabre requests are never intercepted.
const VERSION = 'prm-0.1.0';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest', 'bookmarklet.html',
  'js/app.js', 'js/db.js', 'js/dates.js', 'js/tz.js', 'js/model.js', 'js/parser.js', 'js/events.js', 'js/google.js', 'js/bookmarklet-code.js', 'js/bookmarklet-install.js',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first for our own files (so updates arrive), falling back to cache when offline.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
