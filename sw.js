/* html2pwa service worker: offline app shell. Version changes whenever the file list/sizes change. */
const VERSION = 'html2pwa-1bf332b9ed';
const SHELL = [
 "./",
 "css/app.css",
 "fonts/Cinzel-Bold.ttf",
 "fonts/CourierPrime-Regular.ttf",
 "fonts/Montserrat-Regular.ttf",
 "fonts/Montserrat-SemiBold.ttf",
 "fonts/Rajdhani-Bold.ttf",
 "fonts/Rajdhani-SemiBold.ttf",
 "img/banner-800.jpg",
 "img/banner-800.webp",
 "img/banner.jpg",
 "img/banner.webp",
 "img/crest.png",
 "index.html",
 "js/app.js",
 "js/indicators.worker.js",
 "manifest.webmanifest",
 "pwa-deeplink.js",
 "pwa-icons/favicon-32.png",
 "pwa-icons/icon-152.png",
 "pwa-icons/icon-167.png",
 "pwa-icons/icon-180.png",
 "pwa-icons/icon-192.png",
 "pwa-icons/icon-512.png",
 "pwa-icons/icon-maskable-512.png"
];
self.addEventListener('install', e => e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== VERSION).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).catch(() => caches.match('index.html'))); return; }  // deep links -> cached shell offline
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => hit || fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(VERSION).then(x => x.put(r, c)); } return res; })));
});
