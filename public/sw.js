const CACHE_NAME = 'music-app-shell-v8';

// Свои аудиофайлы, скачанные кнопкой «Скачать для офлайна» в мероприятии.
// Кладёт их туда сама страница (main.js), воркер только отдаёт. Имя без версии:
// при обновлении оболочки этот кэш не удаляется, иначе пропадала бы музыка.
const FILES_CACHE = 'music-files';
const FILES_ORIGIN = 'https://minimal-music-files.uudnik.workers.dev';

// Только стабильные пути из public/ — хэшированные assets/index-*.js/css
// от vite build сюда не входят (их имя меняется на каждой сборке),
// они докладываются в кэш во время выполнения через fetch-обработчик ниже.
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './favicon.svg',
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

// Перехват запросов: сначала сеть (чтобы новые деплои сразу были видны),
// удачный ответ докладываем в кэш, а к кэшу обращаемся только офлайн —
// иначе cache-first держал бы пользователей на старой версии бандла
// после каждого деплоя, пока сам sw.js не поменяется.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.url.startsWith(`${FILES_ORIGIN}/files/`)) {
    event.respondWith(serveFile(event.request));
    return;
  }
  // Чужие домены (YouTube, Firebase, шрифты) не трогаем: их запросы
  // должны идти напрямую в сеть, а не через кэш service worker.
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && event.request.url.startsWith(self.location.origin)) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Обновление кэша (удаление старых версий, если поменялся CACHE_NAME)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME && cacheName !== FILES_CACHE) {
            console.log('Удаление старого кэша:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});

// Аудиофайл: из кэша, если скачан, иначе из сети. <audio> почти всегда шлёт
// Range (а Safari без ответа 206 вообще не играет) — режем сохранённый файл сами
async function serveFile(request) {
  const cache = await caches.open(FILES_CACHE);
  // ignoreVary: воркер отвечает с «Vary: Origin», а <audio> шлёт запрос без Origin
  const cached = await cache.match(request.url, { ignoreVary: true });
  if (!cached) return fetch(request);

  const range = request.headers.get('Range');
  if (!range) return cached;

  const blob = await cached.blob();
  const size = blob.size;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  let start = 0;
  let end = size - 1;
  if (match && match[1] !== '') {
    start = Number(match[1]);
    if (match[2] !== '') end = Math.min(Number(match[2]), size - 1);
  } else if (match && match[2] !== '') {
    start = Math.max(0, size - Number(match[2]));
  }
  if (start > end || start >= size) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(blob.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': cached.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes'
    }
  });
}
