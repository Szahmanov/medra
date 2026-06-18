const CACHE = 'medra-v2';
const ASSETS = ['/', '/index.html', '/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) {
    e.respondWith(fetch(e.request));
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      const clone = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, clone));
      return res;
    }).catch(() => caches.match('/index.html')))
  );
});

// Push notification received
self.addEventListener('push', e => {
  let data = { title: 'Medra', body: 'Време е за нови изследвания.', url: '/' };
  if (e.data) { try { data = e.data.json(); } catch {} }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate: [200, 100, 200],
      data: { url: data.url || '/' }
    })
  );
});

// Notification clicked
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/'));
});
