/* Zeva app service worker.
   Keeps the app shell and the menu readable on a weak connection:
   pages are network-first (fresh prices), images and icons cache-first. */

var VERSION = 'zeva-app-v10214';
var SHELL = [
  '/app.html',
  '/menu.html',
  '/manifest.webmanifest',
  '/assets/site.css',
  '/assets/img/icon-192.png',
  '/assets/img/icon-512.png',
  '/assets/img/insta-1.jpg',
  '/assets/img/insta-2.jpg',
  '/assets/img/insta-3.jpg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return Promise.all(SHELL.map(function (url) {
        return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === VERSION ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;

  var wantsHtml = request.mode === 'navigate' ||
    (request.headers.get('accept') || '').indexOf('text/html') !== -1;

  if (wantsHtml) {
    event.respondWith(
      fetch(request).then(function (response) {
        var copy = response.clone();
        caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
        return response;
      }).catch(function () {
        return caches.match(request).then(function (hit) {
          return hit || caches.match('/app.html');
        });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) {
        fetch(request).then(function (response) {
          if (response && response.ok) caches.open(VERSION).then(function (cache) { cache.put(request, response.clone()); });
        }).catch(function () {});
        return hit;
      }
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(VERSION).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      });
    })
  );
});
