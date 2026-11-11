// AgroRuta Equipo · service worker (app instalable, funciona sin señal, notificaciones)
const CACHE = 'ar-equipo-202611111411';
const SHELL = ['./', './index.html', './supabase.js', './config.js', './nube.js', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())) });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x.startsWith('ar-equipo-202611111411') && x !== CACHE).map(x => caches.delete(x)))).then(() => self.clients.claim())) });
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || !u.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r.url, { cache: 'no-cache', credentials: 'same-origin' }).then(res => { const c = res.clone(); caches.open(CACHE).then(x => x.put('./index.html', c)); return res }).catch(() => caches.match('./index.html'))); return }
  e.respondWith(fetch(r, { cache: 'no-cache' }).then(res => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(r, c)) } return res }).catch(() => caches.match(r)));
});
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {} } catch (x) { d = { body: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(d.title || 'AgroRuta Equipo', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: d.url || './' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(L => {
    const w = L.find(c => c.url.startsWith(self.registration.scope));
    if (w) { w.postMessage({ tipo: 'abrir', url }); return w.focus() }
    return self.clients.openWindow(url);
  }));
});
