const CACHE = 'colmena-v13';
const PRECACHE = [
  '/css/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/biometric.js',
  '/manifest.json',
  '/img/icon-192.png',
  '/img/icon-512.png',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/vendor/leaflet.markercluster.js',
  '/vendor/leaflet.markercluster.css',
  '/vendor/leaflet.markercluster.default.css',
  '/vendor/chart.js',
  '/vendor/qrcode.min.js',
  '/vendor/socket.io.min.js',
  '/vendor/images/marker-icon.png',
  '/vendor/images/marker-icon-2x.png',
  '/vendor/images/marker-shadow.png',
  '/vendor/images/layers.png',
  '/vendor/images/layers-2x.png'
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE)).catch(() => {})
  );
});

self.addEventListener('activate', e => {
  self.clients.claim();
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener('fetch', e => {
  let u;
  try { u = new URL(e.request.url); } catch { return; }
  if (u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/_capacitor')) return;
  if (u.pathname.startsWith('/api/')) {
    e.respondWith(networkFirst(e.request));
    return;
  }
  if (u.pathname.startsWith('/tiles/') || u.pathname.startsWith('/uploads/')) {
    return;
  }
  if (u.pathname === '/' || u.pathname === '/index.html') {
    e.respondWith(networkFirst(e.request));
    return;
  }
  e.respondWith(cacheFirst(e.request));
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

async function networkFirst(req) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(req, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  } catch {
    clearTimeout(timer);
    refreshInBackground(req);
    const hit = await caches.match(req);
    if (hit) {
      const h = new Headers(hit.headers);
      h.set('X-SW-Stale', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
    }
    return new Response(JSON.stringify({ offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function refreshInBackground(req) {
  try {
    const res = await fetch(req);
    if (!res.ok) return;
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    const path = new URL(req.url).pathname;
    const list = await clients.matchAll({ includeUncontrolled: true });
    list.forEach(client => client.postMessage({ type: 'sw-refresh', path }));
  } catch (e) { /* sin red */ }
}

self.addEventListener('push', function(event) {
  let data = { title: 'PRIoridad Territorial', body: '', url: '/' };
  try {
    const parsed = event.data ? JSON.parse(event.data.text()) : {};
    data = { ...data, ...parsed };
  } catch {}
  const opts = {
    body: data.body,
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    data: { url: data.url }
  };
  event.waitUntil(self.registration.showNotification(data.title, opts));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
    for (const client of clientList) {
      if (client.url.includes(self.location.origin) && 'focus' in client) return client.focus();
    }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
