# Minimal Music

Минималистичный музыкальный PWA-плеер: поиск треков через YouTube Data API, воспроизведение через скрытый YouTube IFrame Player, личная библиотека («Моя музыка») на Firebase (Firestore + анонимная авторизация).

Прод: **https://minimal-music-app.vercel.app**

## Стек

- Ванильный JS (ES-модули), без фреймворка
- [Vite](https://vitejs.dev/) — dev-сервер и сборка
- YouTube Data API v3 — поиск
- YouTube IFrame Player API — воспроизведение
- Firebase: Firestore (хранение лайкнутых треков) + Authentication (Anonymous)
- Service Worker — офлайн-кэш статики (PWA)
- Деплой: Vercel (автодеплой из `main`)

## Структура

```
index.html          разметка + панель плеера
main.js             вся логика: поиск, плеер, Firebase
styles.css          стили
public/
  manifest.json     PWA-манифест
  sw.js             service worker
  icon-*.png        иконки PWA
firestore.rules      правила доступа к Firestore (задеплоены)
firebase.json / .firebaserc   конфиг Firebase CLI
```

Всё, что лежит в `public/`, Vite копирует в сборку как есть — это важно, потому что `vite build` иначе подхватывает только файлы, на которые есть прямая ссылка в `index.html`, а `sw.js` и часть иконок ссылаются друг на друга через `manifest.json`/рантайм-строки, а не через теги в HTML.

## Разработка

```bash
npm install
npm run dev       # dev-сервер Vite
npm run build     # прод-сборка в dist/
npm run preview   # локальный просмотр сборки
```

## Настройка ключей

В `main.js` два места с конфигурацией, которые нужно заполнить своими значениями при разворачивании проекта с нуля:

1. **`YOUTUBE_API_KEY`** — ключ YouTube Data API v3 из [Google Cloud Console](https://console.cloud.google.com/apis/credentials). Обязательно ограничь его по HTTP referrer (домен деплоя), иначе квоту может исчерпать кто угодно, кто найдёт ключ в исходниках фронтенда.
2. **`firebaseConfig`** — конфиг веб-приложения из Firebase Console (Project settings → General → Your apps) или `firebase apps:sdkconfig WEB <appId>`. Сам `apiKey` в этом объекте не секрет — безопасность обеспечивают правила Firestore (`firestore.rules`), не сокрытие конфига.

## Firebase: база и правила

Проект: `minimal-music-app-e3bd3`.

- Firestore Database должен быть создан (Native mode).
- Authentication → Sign-in method → **Anonymous** должен быть включён — библиотека привязывает лайкнутые треки к анонимному `uid` устройства.
- Правила Firestore лежат в `firestore.rules` и ограничивают чтение/удаление документа только его владельцем (`request.auth.uid == resource.data.uid`). Задеплоить после изменений:

```bash
npx firebase-tools deploy --only firestore:rules --project minimal-music-app-e3bd3
```

## Деплой

Продакшн — Vercel, подключён к GitHub-репозиторию: пуш в `main` триггерит автодеплой. Ручной деплой:

```bash
npx vercel --prod
```

## Известные ограничения

- Нет очереди/автопереключения треков — только ручной play на каждый результат поиска.
- Анонимная библиотека привязана к браузеру/устройству: очистка данных сайта или другое устройство — новый `uid`, старые лайки не видны.
- YouTube API квота ограничена (10 000 unit/день по умолчанию), у поиска высокая цена запроса — при активном использовании квота может закончиться раньше полуночи по Тихоокеанскому времени.
