const CACHE_NAME = 'music-app-shell-v4';

// Только стабильные пути из public/ — хэшированные assets/index-*.js/css
// от vite build сюда не входят (их имя меняется на каждой сборке),
// они докладываются в кэш во время выполнения через fetch-обработчик ниже.
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png'
];

// Установка воркера и кэширование стабильных файлов оболочки приложения
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Кэширование файлов приложения...');
      return cache.addAll(PRECACHE_ASSETS);
    })
  );
});

// Перехват запросов: отдаём из кэша, иначе идём в сеть и докладываем
// успешный ответ в кэш (так хэшированные JS/CSS бандлы попадают в офлайн-кэш сами)
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          if (response.ok && event.request.url.startsWith(self.location.origin)) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          }
          return response;
        })
        .catch(() => cached);
    })
  );
});

// Обновление кэша (удаление старых версий, если поменялся CACHE_NAME)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Удаление старого кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
