const CACHE_NAME = 'music-app-shell-v2';

// ИСПРАВЛЕНО: Добавлены точки для относительных путей (специально для GitHub Pages)
// Также добавлен manifest.json для полного оффлайн-доступа
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './styles.css',
  './main.js',
  './manifest.json'
];

// Установка воркера и кэширование файлов интерфейса
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Кэширование файлов приложения...');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Перехват запросов (чтобы интерфейс грузился без интернета)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((response) => {
      // Если файл есть в кэше — отдаем его, иначе делаем запрос в интернет
      return response || fetch(event.request);
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