import qrcode from 'qrcode-generator';

// --- 1. РЕГИСТРАЦИЯ SERVICE WORKER (ДЛЯ PWA) ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service Worker зарегистрирован!', reg))
            .catch(err => console.log('Ошибка SW:', err));
    });
}

// Прогреваем Firebase в фоне уже после того, как страница отрисовалась —
// не блокируем первый показ поиска, но к первому лайку SDK, скорее всего, уже готов
window.addEventListener('load', () => {
    const warmUp = () => loadFirebase();
    if ('requestIdleCallback' in window) {
        requestIdleCallback(warmUp, { timeout: 3000 });
    } else {
        setTimeout(warmUp, 2000);
    }
});

// --- 2. КОНФИГУРАЦИЯ FIREBASE И YOUTUBE ---
const firebaseConfig = {
    apiKey: "AIzaSyDCYcwNHXw0Vv3OJEAPl1qgi03H-Y_qfBU",
    authDomain: "minimal-music-app-e3bd3.firebaseapp.com",
    projectId: "minimal-music-app-e3bd3",
    storageBucket: "minimal-music-app-e3bd3.firebasestorage.app",
    messagingSenderId: "1081743657641",
    appId: "1:1081743657641:web:a5ebfcc79fc50f8b2177b8"
};

// --- 2.1 ЛЕНИВАЯ ЗАГРУЗКА FIREBASE ---
// Firebase SDK (~700КБ) нужен только для «Моя музыка» — не блокируем им
// поиск и воспроизведение, а подгружаем по требованию (и заранее в фоне,
// пока пользователь читает результаты поиска).
let firebasePromise = null;
function loadFirebase() {
    if (!firebasePromise) {
        firebasePromise = (async () => {
            const [
                { initializeApp },
                { getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc, updateDoc, setDoc, getDoc, onSnapshot },
                {
                    getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator, signOut,
                    GoogleAuthProvider, linkWithPopup, signInWithPopup, signInWithCredential,
                    EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword, sendPasswordResetEmail
                }
            ] = await Promise.all([
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"),
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"),
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js")
            ]);

            const app = initializeApp(firebaseConfig);
            const db = getFirestore(app);
            const auth = getAuth(app);
            auth.languageCode = 'ru'; // письма о сбросе пароля и окно Google — по-русски
            // Для проверки входа по почте локально: localStorage.authEmulator = '1'
            // и `npx firebase-tools emulators:start --only auth` — пароли не уходят в сеть
            if (location.hostname === 'localhost' && localStorage.getItem('authEmulator')) {
                connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
            }

            // Данные привязаны к uid: без входа — анонимный uid устройства,
            // после входа через Google или почту — uid аккаунта (общий для всех устройств)
            let currentUser = null;
            const authListeners = [];
            const authReady = new Promise((resolve) => {
                onAuthStateChanged(auth, (user) => {
                    if (user) {
                        currentUser = user;
                        resolve(user);
                        authListeners.forEach(fn => fn(user));
                    } else {
                        // Ни аккаунта, ни анонимной сессии — первый запуск или после «Выйти».
                        // Анонимно входим только здесь, иначе выбили бы человека из аккаунта
                        signInAnonymously(auth).catch((error) => {
                            console.error("Ошибка анонимного входа:", error);
                        });
                    }
                });
            });

            return {
                db, collection, addDoc, getDocs, query, where, deleteDoc, doc, updateDoc, setDoc, getDoc, onSnapshot,
                auth, signOut, GoogleAuthProvider, linkWithPopup, signInWithPopup, signInWithCredential,
                EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword, sendPasswordResetEmail,
                authReady,
                getCurrentUser: () => auth.currentUser || currentUser,
                // Возвращает функцию отписки
                onAuthChange: (fn) => {
                    authListeners.push(fn);
                    return () => {
                        const i = authListeners.indexOf(fn);
                        if (i >= 0) authListeners.splice(i, 1);
                    };
                }
            };
        })();
    }
    return firebasePromise;
}

// Ссылка из QR-кода для гостей: ?guest=<id мероприятия> — вместо приложения
// открывается страница заказа песни (раздел 14)
const GUEST_EVENT_ID = new URLSearchParams(location.search).get('guest');
// ?bingo=<id> — карточка музыкального бинго на телефоне гостя (раздел 16)
const BINGO_EVENT_ID = new URLSearchParams(location.search).get('bingo');

// Константы приложения
const YOUTUBE_API_KEY = "AIzaSyBgrlvnKuTsj4HSitEUT3Ae4yJLbNozfd8";
// Свои аудиофайлы лежат в Cloudflare Workers KV, загрузка и отдача — через воркер (worker/index.js)
const FILES_API = "https://minimal-music-files.uudnik.workers.dev";

const searchInput = document.getElementById('search-input');
const trackList = document.getElementById('track-list');
const navSearch = document.getElementById('nav-search');
const navLibrary = document.getElementById('nav-library');
const navEvents = document.getElementById('nav-events');
const searchContainer = document.getElementById('search-container');
const eventsView = document.getElementById('events-view');
const pickBanner = document.getElementById('pick-banner');

const loadMoreBtn = document.getElementById('load-more-btn');

const audioWrapper = document.getElementById('audio-wrapper');
const filePlayer = document.getElementById('file-player');
const uploadBar = document.getElementById('upload-bar');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npPlayPause = document.getElementById('np-playpause');
const npLike = document.getElementById('np-like');
const npSeek = document.getElementById('np-seek');
const npCurrent = document.getElementById('np-current');
const npDuration = document.getElementById('np-duration');
const npCover = document.getElementById('np-cover');

// --- 2.2 ИКОНКИ ---
// Линейные SVG-иконки вместо эмодзи: эмодзи на каждом телефоне рисуются по-своему
// (▶️ — оранжевым квадратом) и не красятся в цвета темы. currentColor — цвет кнопки
const svg = (body, filled = false) =>
    `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
    play: svg('<path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.2-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z"/>', true),
    pause: svg('<rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/>', true),
    heart: svg('<path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.5 2.9C19.5 15.4 12 20 12 20z"/>'),
    heartFilled: svg('<path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 7.5 2.9C19.5 15.4 12 20 12 20z"/>', true),
    trash: svg('<path d="M4.5 7h15M9.5 7V5.2c0-.7.5-1.2 1.2-1.2h2.6c.7 0 1.2.5 1.2 1.2V7M6.5 7l.8 11.6c.1.8.7 1.4 1.5 1.4h6.4c.8 0 1.4-.6 1.5-1.4L17.5 7M10.3 11v5M13.7 11v5"/>'),
    busy: svg('<path d="M12 4a8 8 0 1 0 8 8" class="spin"/>'),
    error: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v4.5M12 16h.01"/>'),
    note: svg('<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
    close: svg('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
    arrowUp: svg('<path d="M12 19V5M6.5 10.5 12 5l5.5 5.5"/>'),
    arrowDown: svg('<path d="M12 5v14M6.5 13.5 12 19l5.5-5.5"/>'),
    arrowLeft: svg('<path d="M19 12H5M10.5 6.5 5 12l5.5 5.5"/>'),
    download: svg('<path d="M12 4v11M7 10.5l5 5 5-5M5 19.5h14"/>'),
    copy: svg('<rect x="8.5" y="8.5" width="11.5" height="11.5" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>'),
    stage: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4M8 20h8"/><path d="M10.5 7.8v4.4l3.6-2.2z" fill="currentColor"/>'),
    printer: svg('<path d="M7 9V4h10v5"/><rect x="4" y="9" width="16" height="7" rx="2"/><rect x="7" y="13.5" width="10" height="6.5" rx="1"/>'),
    phone: svg('<rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/>'),
    qr: svg('<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18v2M18 14h2"/>'),
    loop: svg('<path d="M17 3l3 3-3 3M4 11.5V10a4 4 0 0 1 4-4h12M7 21l-3-3 3-3M20 12.5V14a4 4 0 0 1-4 4H4"/>'),
    signal: svg('<path d="M4 10v4h3l7 4V6l-7 4H4zM17.5 9a4 4 0 0 1 0 6"/>'),
    silence: svg('<path d="M4 10v4h3l6 4V6l-6 4H4zM16.5 9.5l5 5M21.5 9.5l-5 5"/>'),
    freeze: svg('<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5"/>'),
    quiz: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.4a2.4 2.4 0 1 1 3.2 2.3c-.6.3-.9.8-.9 1.4v.5M12 16.6h.01"/>'),
    bingo: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/>'),
    eye: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
    skip: svg('<path d="M6 5.5v13l9.5-6.5z" fill="currentColor"/><path d="M18.5 5.5v13"/>'),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', true),
    folder: svg('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
    clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    star: svg('<path d="M12 3.5l2.4 5.2 5.6.6-4.2 3.8 1.2 5.5L12 15.8l-5 2.8 1.2-5.5L4 9.3l5.6-.6z"/>'),
    briefcase: svg('<rect x="3.5" y="7.5" width="17" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17"/>'),
    balloon: svg('<path d="M12 15c-3.3 0-6-3-6-6.5S8.7 2.5 12 2.5s6 2.6 6 6-2.7 6.5-6 6.5zM10.8 15l-.6 1.6h3.6l-.6-1.6M12 16.6c0 2.2-1.8 2.6-1 4.9"/>'),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/>'),
    medal: svg('<circle cx="12" cy="15" r="5"/><path d="M8.5 3.5 12 10l3.5-6.5"/><path d="M12 12.6l.8 1.5 1.6.2-1.2 1.1.3 1.6-1.5-.8-1.5.8.3-1.6-1.2-1.1 1.6-.2z" fill="currentColor" stroke="none"/>'),
    rings: svg('<circle cx="9" cy="14.5" r="5"/><circle cx="15" cy="14.5" r="5"/><path d="M10.5 4.5h3L15 6.8l-3 2.2-3-2.2z"/>'),
    calendar: svg('<rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>')
};

// Иконка как DOM-узел — для el(): el('button', {}, ico('copy'), 'Копия')
function ico(name, cls = 'ic') {
    const t = document.createElement('template');
    t.innerHTML = ICONS[name];
    const node = t.content.firstChild;
    node.classList.add(cls);
    return node;
}

// Кнопка с иконкой и подписью: подпись можно менять, не теряя иконку
function setIconLabel(btn, name, text) {
    btn.replaceChildren(ico(name), document.createTextNode(text));
}

// ♡ / ❤️ / корзина / ожидание / ошибка — состояние в data-state, а не в тексте кнопки
const LIKE_STATES = {
    like: { icon: 'heart', label: 'Добавить в «Моя музыка»' },
    liked: { icon: 'heartFilled', label: 'В «Моей музыке»' },
    busy: { icon: 'busy', label: 'Сохраняем…' },
    error: { icon: 'error', label: 'Не удалось сохранить — нажмите ещё раз' },
    trash: { icon: 'trash', label: 'Убрать из «Моей музыки»' }
};

function setLikeState(btn, state) {
    btn.dataset.state = state;
    btn.innerHTML = ICONS[LIKE_STATES[state].icon];
    btn.setAttribute('aria-label', LIKE_STATES[state].label);
}

function setPlayPauseIcon(playing) {
    npPlayPause.innerHTML = playing ? ICONS.pause : ICONS.play;
    npPlayPause.setAttribute('aria-label', playing ? 'Пауза' : 'Играть');
}

// Обложка: у видео YouTube — кадр-превью по ID, у своего файла — нота на подложке
function coverUrl(track, size = 'mqdefault') {
    if (!track || track.source === 'file' || !track.audio) return '';
    return `https://i.ytimg.com/vi/${encodeURIComponent(track.audio)}/${size}.jpg`;
}

function coverNode(track) {
    const box = document.createElement('div');
    box.className = 'cover';
    fillCover(box, track);
    return box;
}

function fillCover(box, track) {
    box.replaceChildren();
    const url = coverUrl(track);
    if (url) {
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => { img.remove(); box.innerHTML = ICONS.note; });
        box.append(img);
    } else {
        box.innerHTML = ICONS.note;
    }
}

setPlayPauseIcon(false);
setLikeState(npLike, 'like');

// --- 3. ЗАГРУЗКА YOUTUBE ПЛЕЕРА ---
let ytPlayer;
let currentSource = 'youtube'; // 'youtube' | 'file' — какой плеер сейчас главный
let progressInterval = null;
let isSeeking = false;

// Очередь нон-стоп воспроизведения (заполняется только при проигрывании из «Моя музыка»)
let currentTracks = [];
let currentIsLibrary = false;
let activeQueue = null;
let activeQueueIndex = -1;
let activeQueueIsLibrary = false;
// false — очередь играет один раз и останавливается (блок-«сигнал» в сценарии)
let activeQueueLoop = true;
let currentPlayingIsLibrary = false;

// Последние результаты поиска — чтобы не терять их при переходе на вкладку «Моя музыка» и обратно
let lastSearchTracks = null;
let lastSearchQuery = '';
let nextPageToken = null;

// Асинхронно загружаем скрипт YouTube IFrame API (гостю, заказывающему песню, плеер не нужен)
if (!GUEST_EVENT_ID && !BINGO_EVENT_ID) {
    const tag = document.createElement('script');
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}

// Эта функция автоматически вызовется, когда скрипт YouTube загрузится
window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('yt-player', {
        // Плеер живёт в окне видео режима ведущего (вне его оно сдвинуто за край
        // экрана) и растягивается на всё окно — см. #show-video в styles.css
        height: '100%',
        width: '100%',
        videoId: '',
        playerVars: {
            'autoplay': 0,
            'controls': 0,
            'playsinline': 1 // Важно для работы на смартфонах
        },
        events: {
            'onStateChange': onPlayerStateChange,
            'onError': onPlayerError
        }
    });
};

function onPlayerStateChange(event) {
    if (isFileSource()) return; // сейчас играет свой файл — события YouTube не наши
    if (event.data === YT.PlayerState.PLAYING) {
        // Плеер запускался приглушённым, чтобы обойти блокировку автовоспроизведения
        // со звуком в браузере — как только видео реально заиграло, возвращаем звук
        if (ytPlayer.isMuted && ytPlayer.isMuted()) {
            ytPlayer.unMute();
        }
        onPlaybackPlaying();
    } else if (event.data === YT.PlayerState.PAUSED) {
        onPlaybackPaused();
    } else if (event.data === YT.PlayerState.ENDED) {
        onPlaybackEnded();
    }
}

// Многие официальные треки лейблов (каналы «… - Topic», «Official Audio») запрещено
// встраивать на сторонние сайты — плеер отдаёт ошибку 150/101 и молча стоит
function onPlayerError(event) {
    if (isFileSource()) return;
    console.warn("YouTube не может проиграть трек, код ошибки:", event.data);
    onPlaybackError();
}

// --- 3.1 СВОИ ФАЙЛЫ: <audio> ---
filePlayer.addEventListener('play', () => { if (isFileSource()) onPlaybackPlaying(); });
filePlayer.addEventListener('pause', () => { if (isFileSource() && !filePlayer.ended) onPlaybackPaused(); });
filePlayer.addEventListener('ended', () => { if (isFileSource()) onPlaybackEnded(); });
filePlayer.addEventListener('error', () => {
    if (!isFileSource() || !filePlayer.getAttribute('src')) return;
    console.warn("Не удалось проиграть файл:", filePlayer.error);
    onPlaybackError();
});

// --- 3.2 ОБЩИЙ ИНТЕРФЕЙС ПЛЕЕРА ---
// Трек играет либо в YouTube-плеере (audio — ID видео), либо в <audio>
// (source: 'file', audio — ссылка на файл в хранилище воркера). Всё остальное приложение
// управляет воспроизведением только через эти функции.
function isFileSource() {
    return currentSource === 'file';
}

function playerIsPlaying() {
    if (isFileSource()) return !filePlayer.paused && !filePlayer.ended;
    return !!(ytPlayer && ytPlayer.getPlayerState && ytPlayer.getPlayerState() === YT.PlayerState.PLAYING);
}

function playerPlay() {
    if (isFileSource()) {
        filePlayer.play().catch(error => console.warn("Не удалось запустить файл:", error));
    } else if (ytPlayer && ytPlayer.playVideo) {
        ytPlayer.playVideo();
    }
}

function playerPause() {
    if (isFileSource()) filePlayer.pause();
    else if (ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
}

function playerTime() {
    if (isFileSource()) return filePlayer.currentTime;
    return ytPlayer && ytPlayer.getCurrentTime ? ytPlayer.getCurrentTime() : 0;
}

function playerDuration() {
    if (isFileSource()) return filePlayer.duration || 0;
    return ytPlayer && ytPlayer.getDuration ? ytPlayer.getDuration() : 0;
}

function playerSeek(seconds) {
    if (isFileSource()) filePlayer.currentTime = seconds;
    else if (ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(seconds, true);
}

// Громкость 0–100, как у YouTube
function playerGetVolume() {
    if (isFileSource()) return Math.round(filePlayer.volume * 100);
    return ytPlayer && ytPlayer.getVolume ? ytPlayer.getVolume() : 100;
}

function playerSetVolume(volume) {
    if (isFileSource()) filePlayer.volume = Math.max(0, Math.min(1, volume / 100));
    else if (ytPlayer && ytPlayer.setVolume) ytPlayer.setVolume(volume);
}

function onPlaybackPlaying() {
    gameOnPlaying();
    setPlayPauseIcon(true);
    startProgressLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updateShowPlayPause();
}

function onPlaybackPaused() {
    gameOnPaused();
    setPlayPauseIcon(false);
    stopProgressLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    updateShowPlayPause();
}

function onPlaybackEnded() {
    stopProgressLoop();
    setSeek(0);
    npCurrent.textContent = '0:00';

    // Квиз и бинго сами решают, что дальше
    if (gameOnEnded()) {
        updateShowPlayPause();
        return;
    }
    // Нон-стоп: сразу включаем следующий трек из того же списка
    if (!playNext()) {
        setPlayPauseIcon(false);
        renderShowNow('Блок завершён');
    }
    updateShowPlayPause();
}

// Помечаем трек недоступным и без паузы переходим к следующему
function onPlaybackError() {
    const track = activeQueue && activeQueue[activeQueueIndex];
    if (track) {
        track.unavailable = true;
        if (activeQueue === currentTracks) markTrackCardUnavailable(activeQueueIndex);
    }
    if (!playNext()) {
        stopProgressLoop();
        setPlayPauseIcon(false);
        npTitle.textContent = 'Трек недоступен';
        updateShowPlayPause();
    }
}

// Включает следующий проигрываемый трек очереди; false — если такого нет
// (или очередь «один раз» дошла до конца)
function playNext() {
    if (!activeQueue || activeQueue.length === 0) return false;
    for (let step = 1; step <= activeQueue.length; step++) {
        if (!activeQueueLoop && activeQueueIndex + step >= activeQueue.length) return false;
        const nextIndex = (activeQueueIndex + step) % activeQueue.length;
        if (!activeQueue[nextIndex].unavailable) {
            playFromList(nextIndex, activeQueue, activeQueueIsLibrary);
            return true;
        }
    }
    return false;
}

function playPrevious() {
    if (!activeQueue || activeQueue.length === 0) return;
    if (playerTime() > 3) {
        playerSeek(0);
        return;
    }
    const prevIndex = (activeQueueIndex - 1 + activeQueue.length) % activeQueue.length;
    playFromList(prevIndex, activeQueue, activeQueueIsLibrary);
}

// --- 3.3 УПРАВЛЕНИЕ С ЭКРАНА БЛОКИРОВКИ / НАУШНИКОВ (Media Session API) ---
function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (action, handler) => {
        try { ms.setActionHandler(action, handler); } catch { /* действие не поддерживается */ }
    };
    safe('play', playerPlay);
    safe('pause', playerPause);
    safe('seekto', (details) => {
        if (details.seekTime != null) playerSeek(details.seekTime);
    });
    // В «Угадай мелодию» и бинго «следующий» с наушников — ход игры, а не просто трек
    safe('nexttrack', () => {
        if (activeGame && activeGame.type === 'quiz') quizNext();
        else if (activeGame && activeGame.type === 'bingo') bingoNext();
        else playNext();
    });
    safe('previoustrack', playPrevious);
}
setupMediaSession();

function updateMediaSession(name, artist, track = null) {
    if (!('mediaSession' in navigator)) return;
    // На экране блокировки — обложка трека, у своих файлов — иконка приложения
    const cover = coverUrl(track, 'hqdefault');
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: name || '',
            artist: artist || '',
            artwork: cover ? [{ src: cover, sizes: '480x360', type: 'image/jpeg' }] : [
                { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
            ]
        });
    } catch { /* MediaMetadata недоступен */ }
}

// --- 4. УТИЛИТЫ ---
function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Позиция ползунка и закрашенная (латунная) часть дорожки до него
function setSeek(percent) {
    npSeek.value = percent;
    npSeek.style.setProperty('--p', `${Number(percent) || 0}%`);
}

function startProgressLoop() {
    stopProgressLoop();
    progressInterval = setInterval(() => {
        if (isSeeking) return;
        const duration = playerDuration();
        const current = playerTime();
        if (duration > 0) {
            setSeek((current / duration) * 100);
            npDuration.textContent = formatTime(duration);
        }
        npCurrent.textContent = formatTime(current);
    }, 500);
}

function stopProgressLoop() {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
}

// --- 5.1 УПРАВЛЕНИЕ ПЛЕЕРОМ (PAUSE / SEEK) ---
npPlayPause.addEventListener('click', () => {
    if (playerIsPlaying()) {
        playerPause();
    } else {
        playerPlay();
    }
});

// «Сердечко» рядом с play/pause — лайк/удаление текущего играющего трека
npLike.addEventListener('click', async () => {
    if (npLike.dataset.state === 'trash') {
        if (await handleDelete(npLike) === false) return; // отказались удалять файл
        // Удалённый трек больше не играет по кругу в очереди «Моей музыки»
        const playing = activeQueue && activeQueue[activeQueueIndex];
        if (playing && currentPlayingIsLibrary) playing.unavailable = true;
        setLikeState(npLike, 'like');
        currentPlayingIsLibrary = false;
        // Удалённый свой файл повторно «лайкнуть» нельзя — прячем кнопку
        if (npLike.dataset.source === 'file') npLike.classList.add('hidden');
        // Карточка удалённого трека не должна оставаться в открытой «Моей музыке»
        if (navLibrary.classList.contains('active')) loadLibrary();
    } else {
        handleLike(npLike);
    }
});

npSeek.addEventListener('input', () => {
    isSeeking = true;
    setSeek(npSeek.value);
    npCurrent.textContent = formatTime((npSeek.value / 100) * playerDuration());
});

npSeek.addEventListener('change', () => {
    const duration = playerDuration();
    if (duration > 0) playerSeek((npSeek.value / 100) * duration);
    isSeeking = false;
});

// --- 5. ЛОГИКА НАВИГАЦИИ ---
// Переключает экран: 'search' | 'library' | 'events'
function showView(view) {
    navSearch.classList.toggle('active', view === 'search');
    navLibrary.classList.toggle('active', view === 'library');
    navEvents.classList.toggle('active', view === 'events');
    searchContainer.classList.toggle('hidden', view === 'events');
    trackList.classList.toggle('hidden', view === 'events');
    eventsView.classList.toggle('hidden', view !== 'events');
    uploadBar.classList.toggle('hidden', view !== 'library');
    if (view !== 'search') loadMoreBtn.classList.add('hidden');
    renderPickBanner(view);
}

navSearch.addEventListener('click', () => {
    showView('search');
    if (lastSearchTracks) {
        renderSearchResults();
        updateLoadMoreButton();
    } else {
        trackList.innerHTML = '<p class="status">Введите название песни для поиска</p>';
    }
});

navLibrary.addEventListener('click', async () => {
    showView('library');
    loadLibrary();
});

navEvents.addEventListener('click', () => {
    showView('events');
    if (currentEvent) {
        renderEventDetail();
    } else {
        loadEvents();
    }
});

// --- 6. РАБОТА С YOUTUBE API (ПОИСК) ---
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const queryText = searchInput.value;
        if (queryText) searchMusic(queryText);
    }
});

// Номер последнего запроса к поиску: ответ устаревшего запроса (пользователь уже
// искал другое) не должен перезаписать новые результаты или подмешаться к ним
let searchSeq = 0;

// Канал YouTube, чьи треки сейчас показаны ({ id, title }), или null — обычный поиск
let lastSearchChannel = null;
// Результаты поиска до перехода на канал — «← Назад» возвращает их без нового запроса
let searchBack = null; // { query, tracks, nextPageToken }

async function searchMusic(queryText) {
    lastSearchChannel = null;
    searchBack = null;
    await runSearch(queryText, null, 'Ищем музыку на YouTube...');
}

// Все треки канала (автора), на имя которого нажали под названием песни
async function openChannel(channelId, channelTitle) {
    if (!channelId) return;
    if (lastSearchChannel && lastSearchChannel.id === channelId && navSearch.classList.contains('active')) return;
    // Запоминаем обычный поиск, чтобы к нему можно было вернуться; если уже смотрим
    // другой канал — «Назад» по-прежнему ведёт к исходному поиску
    if (!lastSearchChannel && lastSearchTracks) {
        searchBack = { query: lastSearchQuery, tracks: lastSearchTracks, nextPageToken };
    }
    lastSearchChannel = { id: channelId, title: channelTitle || 'Канал' };
    window.scrollTo(0, 0);
    await runSearch('', channelId, `Загружаем треки «${lastSearchChannel.title}»...`);
}

// Возврат с канала к результатам поиска, из которого на него перешли
function closeChannel() {
    lastSearchChannel = null;
    const back = searchBack;
    searchBack = null;
    searchSeq++; // незаконченная загрузка канала не должна прийти поверх
    if (back) {
        lastSearchQuery = back.query;
        lastSearchTracks = back.tracks;
        nextPageToken = back.nextPageToken;
        searchInput.value = back.query;
        renderSearchResults();
    } else {
        lastSearchQuery = '';
        lastSearchTracks = null;
        nextPageToken = null;
        trackList.innerHTML = '<p class="status">Введите название песни для поиска</p>';
    }
    updateLoadMoreButton();
}

async function runSearch(queryText, channelId, loadingText) {
    // Строка поиска видна и в «Моей музыке» — результаты всегда показываем на вкладке
    // «Поиск», иначе ♡ у найденных треков сработал бы как удаление из библиотеки
    if (!navSearch.classList.contains('active')) showView('search');
    const seq = ++searchSeq;
    trackList.replaceChildren(...channelHeader(), el('p', { class: 'status' }, loadingText));
    loadMoreBtn.classList.add('hidden');
    lastSearchQuery = queryText;
    nextPageToken = null;

    const page = await fetchSearchPage({ query: queryText, channelId }, null);
    if (seq !== searchSeq) return;
    if (page === null) return; // ошибка уже отображена внутри fetchSearchPage

    nextPageToken = page.nextPageToken;
    lastSearchTracks = page.tracks;
    if (!navSearch.classList.contains('active')) return; // ушли на другую вкладку
    renderSearchResults();
    updateLoadMoreButton();
}

// Результаты поиска, а над треками канала — шапка с его названием и «← Назад»
function renderSearchResults() {
    renderTracks(lastSearchTracks, false);
    if (lastSearchChannel) trackList.prepend(...channelHeader());
}

function channelHeader() {
    if (!lastSearchChannel) return [];
    return [el('div', { class: 'channel-header' },
        el('button', { class: 'link-btn', dataset: { action: 'channel-back' } },
            ico('arrowLeft'), searchBack && searchBack.query ? `К поиску «${searchBack.query}»` : 'Назад'),
        el('strong', {}, `Треки канала: ${lastSearchChannel.title}`))];
}

// Догружает следующую страницу результатов поиска и добавляет её к текущему списку
async function loadMoreTracks() {
    if (!nextPageToken || (!lastSearchQuery && !lastSearchChannel)) return;

    const seq = searchSeq;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Загрузка...';

    const page = await fetchSearchPage(
        { query: lastSearchQuery, channelId: lastSearchChannel && lastSearchChannel.id }, nextPageToken);

    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Ещё';

    if (seq !== searchSeq || page === null) return;
    nextPageToken = page.nextPageToken;
    const moreTracks = page.tracks;

    const previousTracks = lastSearchTracks;
    lastSearchTracks = [...(lastSearchTracks || []), ...moreTracks];
    // Если сейчас играет поиск — догруженные треки тоже попадают в очередь нон-стоп
    if (activeQueue && activeQueue === previousTracks) activeQueue = lastSearchTracks;
    renderSearchResults();
    updateLoadMoreButton();
}

// channelId — только видео этого канала, популярные сверху. Категорию «Музыка» для
// канала не требуем: каверы и нейросетевые песни авторы часто ставят в «Развлечения»
function youtubeSearchUrl(queryText, pageToken = null, channelId = null) {
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&type=video&videoEmbeddable=true&videoSyndicated=true&key=${YOUTUBE_API_KEY}`;
    if (queryText) url += `&q=${encodeURIComponent(queryText)}`;
    url += channelId ? `&channelId=${encodeURIComponent(channelId)}&order=viewCount` : '&videoCategoryId=10';
    if (pageToken) url += `&pageToken=${pageToken}`;
    return url;
}

// Результаты YouTube в формате треков приложения
// search.list отдаёт названия с HTML-сущностями («Rock &amp; Roll», «Don&#39;t») —
// раскодируем, иначе через textContent они видны как есть. <textarea> разбирает
// только сущности: разметка и скрипты в нём не выполняются
const entityDecoder = document.createElement('textarea');
function decodeEntities(text) {
    if (!text || !text.includes('&')) return text || '';
    entityDecoder.innerHTML = text;
    return entityDecoder.value;
}

function youtubeItemsToTracks(items = []) {
    return items.filter(item => item.id && item.id.videoId).map(item => ({
        id: item.id.videoId,
        name: decodeEntities(item.snippet.title),
        artist_name: decodeEntities(item.snippet.channelTitle),
        channelId: item.snippet.channelId || '',
        audio: item.id.videoId // В качестве "аудио" передаем ID видео
    }));
}

// Запрашивает одну страницу результатов у YouTube Data API:
// { tracks, nextPageToken } или null (ошибку показывает сама, если запрос не устарел)
async function fetchSearchPage({ query, channelId = null }, pageToken) {
    const url = youtubeSearchUrl(query, pageToken, channelId);
    const seq = searchSeq;
    const showError = (text) => {
        if (seq === searchSeq && navSearch.classList.contains('active')) {
            // Шапку канала оставляем, чтобы из ошибки можно было вернуться «← Назад»
            trackList.replaceChildren(...channelHeader(), el('p', { class: 'status' }, text));
        }
    };

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("Ошибка YouTube API:", data.error.message);
            // 403 quotaExceeded — суточная квота YouTube API кончилась, ключ тут ни при чём
            const quota = (data.error.errors || []).some(e => e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded');
            showError(quota ? 'Лимит поиска YouTube на сегодня исчерпан. Попробуйте завтра.' : 'Ошибка API. Проверьте ключ.');
            return null;
        }

        return { tracks: youtubeItemsToTracks(data.items || []), nextPageToken: data.nextPageToken || null };
    } catch (error) {
        console.error("Ошибка сети:", error);
        showError('Ошибка сети. Проверьте подключение.');
        return null;
    }
}

function updateLoadMoreButton() {
    loadMoreBtn.classList.toggle('hidden', !nextPageToken);
}

loadMoreBtn.addEventListener('click', loadMoreTracks);

// --- 7. ОТРИСОВКА ИНТЕРФЕЙСА ---
function renderTracks(tracks, isLibrary) {
    trackList.innerHTML = '';
    currentTracks = tracks || [];
    currentIsLibrary = isLibrary;

    if (!tracks || tracks.length === 0) {
        trackList.innerHTML = '<p class="status">Список пуст</p>';
        return;
    }

    tracks.forEach((track, index) => {
        const trackCard = document.createElement('div');
        trackCard.className = track.unavailable ? 'track-card unavailable' : 'track-card';
        if (activeQueue === tracks && activeQueueIndex === index) trackCard.classList.add('is-playing');

        const info = document.createElement('div');
        info.className = 'track-info';
        const nameEl = document.createElement('strong');
        nameEl.textContent = track.name;
        // Канал YouTube кликабелен — открывает остальные треки этого автора
        const isChannelLink = track.channelId && !(lastSearchChannel && lastSearchChannel.id === track.channelId && !isLibrary);
        const artistEl = document.createElement(isChannelLink ? 'button' : 'span');
        artistEl.textContent = track.artist_name;
        if (isChannelLink) {
            artistEl.className = 'artist-link';
            artistEl.dataset.index = String(index);
            artistEl.setAttribute('aria-label', `Все треки: ${track.artist_name}`);
        }
        info.append(nameEl, artistEl);

        const actions = document.createElement('div');
        actions.className = 'actions';

        const playBtn = document.createElement('button');
        playBtn.className = 'play-btn';
        playBtn.innerHTML = ICONS.play;
        playBtn.setAttribute('aria-label', `Играть «${track.name}»`);
        Object.assign(playBtn.dataset, {
            index: String(index),
            url: track.audio,
            name: track.name,
            artist: track.artist_name
        });

        // Пока выбираем треки для блока сценария — у каждого трека кнопка «＋»
        if (pickBlock()) {
            const addBtn = document.createElement('button');
            addBtn.className = 'add-btn';
            addBtn.innerHTML = ICONS.plus;
            addBtn.setAttribute('aria-label', 'Добавить в блок');
            addBtn.dataset.index = String(index);
            actions.append(addBtn);
        }

        const likeBtn = document.createElement('button');
        likeBtn.className = 'like-btn';
        setLikeState(likeBtn, isLibrary ? 'trash' : 'like');
        Object.assign(likeBtn.dataset, {
            index: String(index),
            id: track.id,
            url: track.audio,
            name: track.name,
            artist: track.artist_name,
            docid: track.docId || '',
            source: track.source || '',
            key: track.fileKey || '',
            channel: track.channelId || ''
        });

        actions.append(playBtn, likeBtn);
        trackCard.append(coverNode(track), info, actions);
        trackList.appendChild(trackCard);
    });
}

// Карточку ищем по индексу трека, а не по порядку в списке: после удаления
// карточек из «Моей музыки» порядковые номера с индексами уже не совпадают
function markTrackCardUnavailable(index) {
    const btn = trackList.querySelector(`.play-btn[data-index="${index}"]`);
    const card = btn && btn.closest('.track-card');
    if (card) card.classList.add('unavailable');
}

// --- 8. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ ---
trackList.addEventListener('click', (e) => {
    // Внутри кнопок теперь SVG-иконки — клик приходит в <path>, поднимаемся до кнопки
    const target = e.target.closest('button');
    if (!target) return;

    if (target.closest('[data-action="channel-back"]')) {
        closeChannel();
    } else if (target.classList.contains('artist-link')) {
        const track = currentTracks[Number(target.dataset.index)];
        if (track) openChannel(track.channelId, track.artist_name);
    } else if (target.classList.contains('play-btn')) {
        startList(Number(target.dataset.index), currentTracks, currentIsLibrary);
    } else if (target.classList.contains('add-btn')) {
        addTrackToPickTarget(currentTracks[Number(target.dataset.index)], target);
    } else if (target.classList.contains('like-btn')) {
        // Что делает кнопка, решает показанный список, а не активная вкладка
        if (currentIsLibrary) {
            handleDelete(target);
        } else {
            handleLike(target);
        }
    }
});

// --- 9. СОХРАНЕНИЕ В БИБЛИОТЕКУ (FIREBASE) ---
async function handleLike(btn) {
    const track = btn.dataset;
    // Уже сохранён или сохраняется — повторное нажатие не должно плодить дубли
    if (['busy', 'liked'].includes(btn.dataset.state)) return;
    setLikeState(btn, 'busy');

    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const uid = fb.getCurrentUser().uid;
        // Трек мог быть лайкнут раньше (в прошлом поиске) — второй копии в «Моей музыке» не нужно
        const existing = await fb.getDocs(fb.query(fb.collection(fb.db, "liked_tracks"),
            fb.where("uid", "==", uid), fb.where("audioUrl", "==", track.url)));
        if (!existing.empty) {
            setLikeState(btn, 'liked');
            return;
        }
        // Записываем информацию о треке в Firestore, привязывая к текущему пользователю
        await fb.addDoc(fb.collection(fb.db, "liked_tracks"), {
            uid,
            trackId: track.id,
            name: track.name,
            artist: track.artist,
            audioUrl: track.url, // ID видео
            channelId: track.channel || '', // чтобы и в «Моей музыке» автор был кликабельным
            timestamp: Date.now()
        });

        setLikeState(btn, 'liked');
    } catch (error) {
        console.error("Ошибка сохранения:", error);
        setLikeState(btn, 'error');
    }
}

// «Моя музыка» = свои загруженные файлы сверху + лайкнутые треки YouTube
let librarySeq = 0; // более ранняя загрузка не должна перерисовать более позднюю

async function loadLibrary() {
    const seq = ++librarySeq;
    trackList.innerHTML = '<p class="status">Загружаем вашу библиотеку...</p>';
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const q = fb.query(fb.collection(fb.db, "liked_tracks"), fb.where("uid", "==", fb.getCurrentUser().uid));
        const [querySnapshot, files] = await Promise.all([fb.getDocs(q), loadMyFiles()]);
        const tracks = [];

        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            tracks.push({
                docId: docSnap.id,
                id: data.trackId,
                name: data.name,
                artist_name: data.artist,
                audio: data.audioUrl,
                channelId: data.channelId || '',
                timestamp: data.timestamp || 0
            });
        });
        // Firestore отдаёт документы в порядке случайных id, а не по времени —
        // свежие лайки сверху сортируем сами
        tracks.sort((a, b) => b.timestamp - a.timestamp);

        // Пока грузились, пользователь мог уйти на другую вкладку или запустить загрузку заново
        if (seq !== librarySeq || !navLibrary.classList.contains('active')) return;
        renderTracks([...files, ...tracks], true);
    } catch (error) {
        console.error("Ошибка загрузки библиотеки:", error);
        if (seq !== librarySeq || !navLibrary.classList.contains('active')) return;
        trackList.innerHTML = '<p class="status">Не удалось загрузить библиотеку.</p>';
    }
}

// Убирает карточку удалённого трека; сам трек помечаем недоступным, чтобы нон-стоп
// очередь «Моей музыки» его больше не включала (индексы карточек при этом не сдвигаются)
function removeTrackCard(btn, card) {
    if (card) {
        const track = currentTracks[Number(btn.dataset.index)];
        if (track) track.unavailable = true;
        card.remove();
    }
    if (trackList.querySelectorAll('.track-card').length === 0 && currentIsLibrary) {
        trackList.innerHTML = '<p class="status">Список пуст</p>';
    }
}

async function handleDelete(btn) {
    const card = btn.closest('.track-card');
    const docId = btn.dataset.docid;

    // Файл удаляется из облака насовсем — переспрашиваем
    if (btn.dataset.source === 'file') {
        if (!confirm(`Удалить файл «${btn.dataset.name}» из облака? В блоках мероприятий он перестанет играть.`)) return false;
        removeTrackCard(btn, card);
        try {
            await filesApi(`/files/${encodeFileKey(btn.dataset.key)}`, { method: 'DELETE' });
            recentlyDeleted.add(btn.dataset.key);
        } catch (error) {
            console.error("Ошибка удаления файла:", error);
            alert("Не удалось удалить файл.");
        }
        return;
    }

    removeTrackCard(btn, card);

    try {
        if (docId) {
            const fb = await loadFirebase();
            await fb.deleteDoc(fb.doc(fb.db, "liked_tracks", docId));
        }
    } catch (error) {
        console.error("Ошибка при удалении:", error);
        alert("Ошибка при удалении из базы.");
    }
}

// --- 9.1 СВОИ ФАЙЛЫ В ОБЛАКЕ (CLOUDFLARE WORKERS KV) ---
// Ключ файла — «<uid>/<uuid>/<имя>»; в URL каждую часть кодируем отдельно, слэши оставляем
function encodeFileKey(key) {
    return key.split('/').map(encodeURIComponent).join('/');
}

function formatSize(bytes) {
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(bytes / 1024)} КБ`;
}

async function getIdToken() {
    const fb = await loadFirebase();
    await fb.authReady;
    return fb.getCurrentUser().getIdToken();
}

// Запрос к воркеру с Firebase ID-токеном — воркер пускает только к своим файлам
async function filesApi(path, options = {}) {
    const token = await getIdToken();
    const response = await fetch(`${FILES_API}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
}

// Список в Workers KV обновляется с задержкой до минуты — только что загруженные
// и удалённые файлы помним сами, чтобы библиотека не «теряла» и не «воскрешала» их
const recentUploads = [];
const recentlyDeleted = new Set();
const MAX_FILE_BYTES = 25 * 1024 * 1024; // предел воркера (значение в KV)

// Свои файлы в формате треков; при ошибке воркера библиотека показывается без них
async function loadMyFiles() {
    try {
        const { files: listed } = await filesApi('/list');
        const files = [
            ...recentUploads.filter(up => !listed.some(f => f.key === up.key)),
            ...listed
        ].filter(f => !recentlyDeleted.has(f.key));
        return files.map(file => ({
            id: file.key,
            fileKey: file.key,
            source: 'file',
            name: file.name.replace(/\.[a-z0-9]{2,4}$/i, ''),
            artist_name: `Мой файл · ${formatSize(file.size)}`,
            audio: `${FILES_API}/files/${encodeFileKey(file.key)}`
        }));
    } catch (error) {
        console.warn("Не удалось загрузить список файлов:", error);
        return [];
    }
}

const uploadInput = document.getElementById('upload-input');
const uploadStatus = document.getElementById('upload-status');

uploadInput.addEventListener('change', async () => {
    const files = [...uploadInput.files];
    uploadInput.value = ''; // чтобы тот же файл можно было выбрать ещё раз
    if (files.length === 0) return;

    let failed = 0;
    for (const [i, file] of files.entries()) {
        const prefix = files.length > 1 ? `${i + 1} из ${files.length}: ` : '';
        if (file.size > MAX_FILE_BYTES) {
            failed++;
            console.warn("Файл больше 25 МБ, пропущен:", file.name);
            continue;
        }
        try {
            const uploaded = await uploadFile(file, (percent) => {
                uploadStatus.textContent = `Загрузка ${prefix}${file.name} — ${percent}%`;
            });
            recentUploads.unshift(uploaded);
        } catch (error) {
            failed++;
            console.error("Ошибка загрузки файла:", file.name, error);
        }
    }
    uploadStatus.textContent = failed
        ? `Готово, но ${failed} из ${files.length} не загрузились (файлы больше 25 МБ не принимаются)`
        : `Загружено: ${files.length}`;
    if (navLibrary.classList.contains('active')) loadLibrary();
});

// XMLHttpRequest, а не fetch — нужен прогресс отправки для больших файлов
async function uploadFile(file, onProgress) {
    const token = await getIdToken();
    // Некоторые браузеры не знают тип у .m4a/.flac — подставляем по расширению
    const ext = file.name.split('.').pop().toLowerCase();
    const type = file.type.startsWith('audio/') ? file.type
        : ({ mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac' }[ext] || 'audio/mpeg');

    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `${FILES_API}/upload?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        xhr.setRequestHeader('Content-Type', type);
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
            else reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error('Ошибка сети'));
        xhr.send(file);
    });
}

// --- 10. ВОСПРОИЗВЕДЕНИЕ (YOUTUBE ИЛИ СВОЙ ФАЙЛ) ---
// Запуск нового списка пользователем (не переход к следующему треку внутри очереди)
function startList(index, tracks, isLibrary, { loop = true, block = null } = {}) {
    // Пользователь включил другое, пока затухал прошлый блок, — его выбор главнее:
    // отложенный запуск блока не должен перебить только что включённый трек
    cancelFade();
    stopGame();
    activeQueueLoop = loop;
    playingBlock = block;
    playFromList(index, tracks, isLibrary);
}

function playFromList(index, tracks, isLibrary) {
    const track = tracks[index];
    if (!track) return;

    // Очередь нон-стоп — список, из которого запустили трек (поиск или «Моя музыка»)
    activeQueue = tracks;
    activeQueueIndex = index;
    activeQueueIsLibrary = isLibrary;

    updateNowPlayingLikeButton(track, isLibrary);
    playMusic(track);
    highlightPlayingCard();
}

// Подсвечивает в открытом списке трек, который сейчас играет
function highlightPlayingCard() {
    trackList.querySelectorAll('.track-card.is-playing').forEach(card => card.classList.remove('is-playing'));
    if (activeQueue !== currentTracks) return;
    const btn = trackList.querySelector(`.play-btn[data-index="${activeQueueIndex}"]`);
    if (btn) btn.closest('.track-card').classList.add('is-playing');
}

// Синхронизирует «сердечко» внизу с треком, который сейчас играет
function updateNowPlayingLikeButton(track, isLibrary) {
    currentPlayingIsLibrary = isLibrary;
    setLikeState(npLike, isLibrary ? 'trash' : 'like');
    // Свой файл лайкать некуда — он и так в «Моей музыке»
    npLike.classList.toggle('hidden', track.source === 'file' && !isLibrary);
    Object.assign(npLike.dataset, {
        id: track.id,
        url: track.audio,
        name: track.name,
        artist: track.artist_name,
        docid: track.docId || '',
        source: track.source || '',
        key: track.fileKey || '',
        channel: track.channelId || ''
    });
}

function playMusic(track) {
    const { audio, name, artist_name: artist } = track;

    if (track.source === 'file') {
        // Сначала переключаем источник — тогда события остановленного YouTube игнорируются
        currentSource = 'file';
        if (ytPlayer && ytPlayer.stopVideo) ytPlayer.stopVideo();
        filePlayer.volume = 1; // могли оставить приглушённым после затухания
        filePlayer.src = audio;
        filePlayer.play().catch(error => console.warn("Не удалось запустить файл:", error));
    } else {
        if (!ytPlayer || !ytPlayer.loadVideoById) {
            // Без сети скрипт YouTube не загрузится вовсе — пропускаем трек, как недоступный
            console.warn("Плеер YouTube еще не загрузился.");
            currentSource = 'youtube';
            filePlayer.pause();
            renderShowNow('YouTube без интернета недоступен');
            onPlaybackError();
            return;
        }
        currentSource = 'youtube';
        filePlayer.pause();
        // Запускаем приглушённым: браузеры блокируют автовоспроизведение со звуком,
        // если клик пришёл не напрямую в iframe плеера, а приглушённое всегда разрешено.
        // Звук возвращаем в onPlayerStateChange, как только видео реально заиграло.
        ytPlayer.mute();
        ytPlayer.setVolume(100); // могли оставить приглушённой после затухания
        ytPlayer.loadVideoById(audio);
    }

    npTitle.textContent = name || '—';
    npArtist.textContent = artist || '';
    fillCover(npCover, track);
    setSeek(0);
    npCurrent.textContent = '0:00';
    npDuration.textContent = '0:00';
    audioWrapper.classList.remove('hidden');
    updateMediaSession(name, artist, track);
    renderShowNow();

    console.log("Играет:", name);
}

// --- 11. МЕРОПРИЯТИЯ И СЦЕНАРИЙ ---
// Мероприятие — документ в коллекции events: название, тип, дата и блоки сценария.
// Блок — отрезок вечера со своей музыкой: «фон» играет по кругу, «сигнал» — один раз
// (выход, награждение, гимн). Блок без треков — тишина (речи, тосты).
// Блок шаблона: [название, фон по кругу?, игра] — игры см. раздел 16
const EVENT_TYPES = {
    corporate: { label: 'Корпоратив', icon: 'briefcase', blocks: [
        ['Сбор гостей', true], ['Открытие', false], ['Награждение', false],
        ['Банкет', true], ['Музыкальное бинго', false, 'bingo'], ['Угадай мелодию', false, 'quiz'],
        ['Танцы', true], ['Финал', false]
    ] },
    kids: { label: 'Детский праздник', icon: 'balloon', blocks: [
        ['Встреча гостей', true], ['Выход аниматора', false], ['Игра «Замри»', true, 'freeze'],
        ['Торт и свечи', false], ['Дискотека', true], ['Прощание', false]
    ] },
    quizparty: { label: 'Квиз-вечеринка', icon: 'mic', blocks: [
        ['Сбор гостей', true], ['Угадай мелодию: раунд 1', false, 'quiz'], ['Перерыв', true],
        ['Музыкальное бинго', false, 'bingo'], ['Угадай мелодию: финал', false, 'quiz'],
        ['Награждение', false], ['Танцы', true]
    ] },
    official: { label: 'Официальный приём', icon: 'medal', blocks: [
        ['Сбор гостей', true], ['Гимн', false], ['Выход официальных лиц', false],
        ['Выступления', false], ['Фуршет', true], ['Завершение', false]
    ] },
    wedding: { label: 'Свадьба', icon: 'rings', blocks: [
        ['Сбор гостей', true], ['Выход молодых', false], ['Банкет', true],
        ['Первый танец', false], ['Торт', false], ['Танцы', true]
    ] },
    other: { label: 'Другое', icon: 'calendar', blocks: [['Блок 1', true]] }
};

let events = [];
let currentEvent = null;  // { id, title, type, date, blocks }
let pickTarget = null;    // { blockId } — в какой блок добавляем треки из поиска
let playingBlock = null;  // { eventId, blockId } — какой блок сейчас звучит

function newBlockId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function eventTypeInfo(type) {
    return EVENT_TYPES[type] || EVENT_TYPES.other;
}

function formatEventDate(date) {
    if (!date) return 'Без даты';
    const [y, m, d] = date.split('-');
    return `${d}.${m}.${y}`;
}

// Маленький помощник для разметки: el('button', { class: 'x', dataset: {...} }, 'текст', child)
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
    }
    node.append(...children.filter(c => c != null));
    return node;
}

let eventsOffline = false; // список показан из скачанных копий, сети нет

async function loadEvents() {
    currentEvent = null;
    stopRequests();
    eventsView.replaceChildren(el('p', { class: 'status' }, 'Загружаем мероприятия...'));
    try {
        // На площадке сеть бывает «есть, но не грузит» — не ждём её дольше 8 секунд
        const loaded = await withTimeout((async () => {
            const fb = await loadFirebase();
            await fb.authReady;
            const q = fb.query(fb.collection(fb.db, "events"), fb.where("uid", "==", fb.getCurrentUser().uid));
            const snapshot = await fb.getDocs(q);
            // Без сети Firestore не падает, а молча отдаёт пустой локальный кэш —
            // считаем это офлайном и показываем скачанные копии
            if (snapshot.metadata.fromCache) throw new Error('Firestore офлайн');
            const list = [];
            snapshot.forEach(docSnap => list.push({ id: docSnap.id, ...docSnap.data() }));
            return list;
        })(), 8000);
        events = loaded;
        eventsOffline = false;
        // Скачанные копии держим свежими — вдруг сценарий меняли на другой вкладке
        for (const ev of events) if (getOfflineEvents()[ev.id]) storeOfflineEvent(ev);
    } catch (error) {
        console.warn("Мероприятия из сети недоступны, показываем скачанные:", error);
        events = Object.values(getOfflineEvents());
        eventsOffline = true;
        if (events.length === 0) {
            eventsView.replaceChildren(el('p', { class: 'status' }, 'Нет сети, а скачанных мероприятий нет.'));
            return;
        }
    }
    // Ближайшие по дате сверху, без даты — в конце
    events.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'));
    renderEventsList();
}

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Нет ответа за ${ms / 1000} с`)), ms))
    ]);
}

// --- 11.1 ОФЛАЙН: скачанные мероприятия и файлы ---
// Копия мероприятия — в localStorage (её хватает, чтобы открыть сценарий без сети),
// сами аудиофайлы — в Cache Storage «music-files», откуда их отдаёт service worker
const OFFLINE_EVENTS_KEY = 'offline-events';
const FILES_CACHE = 'music-files';

function getOfflineEvents() {
    try {
        return JSON.parse(localStorage.getItem(OFFLINE_EVENTS_KEY)) || {};
    } catch {
        return {};
    }
}

function storeOfflineEvent(ev) {
    const all = getOfflineEvents();
    all[ev.id] = { id: ev.id, title: ev.title, type: ev.type, date: ev.date, blocks: ev.blocks };
    try {
        localStorage.setItem(OFFLINE_EVENTS_KEY, JSON.stringify(all));
    } catch (error) {
        console.warn("Не удалось сохранить копию мероприятия:", error);
    }
}

function removeOfflineEvent(id) {
    const all = getOfflineEvents();
    delete all[id];
    try { localStorage.setItem(OFFLINE_EVENTS_KEY, JSON.stringify(all)); } catch { /* не критично */ }
}

function eventFileTracks(ev) {
    const seen = new Set();
    return ev.blocks.flatMap(b => b.tracks)
        .filter(t => t.source === 'file' && !seen.has(t.audio) && seen.add(t.audio));
}

async function countCachedFiles(ev) {
    const files = eventFileTracks(ev);
    if (!('caches' in window) || files.length === 0) return { cached: 0, total: files.length };
    const cache = await caches.open(FILES_CACHE);
    const hits = await Promise.all(files.map(t => cache.match(t.audio, { ignoreVary: true })));
    return { cached: hits.filter(Boolean).length, total: files.length };
}

async function downloadEventForOffline(button) {
    const ev = currentEvent;
    if (!('caches' in window)) {
        alert('Этот браузер не умеет сохранять файлы для офлайна.');
        return;
    }
    // Просим браузер не вычищать скачанное при нехватке места
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    storeOfflineEvent(ev);

    const files = eventFileTracks(ev);
    const cache = await caches.open(FILES_CACHE);
    let done = 0;
    let failed = 0;
    button.disabled = true;
    for (const track of files) {
        setIconLabel(button, 'download', `Скачиваем ${done + failed + 1} из ${files.length}…`);
        try {
            if (!(await cache.match(track.audio, { ignoreVary: true }))) {
                const response = await fetch(track.audio);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                await cache.put(track.audio, response);
            }
            done++;
        } catch (error) {
            failed++;
            console.error("Не удалось скачать:", track.name, error);
        }
    }
    button.disabled = false;
    if (currentEvent === ev && !eventsView.classList.contains('hidden')) renderEventDetail();
    if (failed) alert(`Не скачались ${failed} из ${files.length} файлов — попробуйте ещё раз при хорошей сети.`);
}

// Подпись под кнопкой: сколько своих файлов уже на устройстве и что с YouTube
async function renderOfflineStatus(ev, node) {
    const { cached, total } = await countCachedFiles(ev);
    const ytCount = ev.blocks.flatMap(b => b.tracks).filter(t => t.source !== 'file').length;
    const saved = !!getOfflineEvents()[ev.id];
    const parts = [];
    if (total) parts.push(`своих файлов на устройстве: ${cached} из ${total}`);
    else parts.push('своих файлов в сценарии нет');
    if (ytCount) parts.push(`треки YouTube (${ytCount}) без интернета не играют`);
    if (saved && cached === total) parts.unshift('✓ готово к работе без сети');
    node.textContent = parts.join(' · ');
}

function renderEventsList() {
    const typeSelect = el('select', { name: 'type' },
        ...Object.entries(EVENT_TYPES).map(([value, info]) => el('option', { value }, info.label)));

    const form = el('form', { class: 'event-create' },
        el('input', { name: 'title', type: 'text', placeholder: 'Название мероприятия', required: true }),
        el('div', { class: 'event-create-row' },
            typeSelect,
            el('input', { name: 'date', type: 'date' })),
        el('button', { type: 'submit', class: 'primary-btn' }, ico('plus'), 'Создать по шаблону'));
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        createEvent(form.elements.title.value.trim(), form.elements.type.value, form.elements.date.value);
    });

    const list = events.length === 0
        ? el('p', { class: 'status' }, 'Мероприятий пока нет')
        : el('div', {}, ...events.map(ev => {
            const info = eventTypeInfo(ev.type);
            return el('button', { class: 'event-card', dataset: { action: 'open-event', id: ev.id } },
                el('span', { class: 'event-icon' }, ico(info.icon)),
                el('span', { class: 'event-card-info' },
                    el('strong', {}, ev.title),
                    el('span', {}, `${formatEventDate(ev.date)} · ${info.label} · блоков: ${(ev.blocks || []).length}`)));
        }));

    eventsView.replaceChildren(form, list);
}

async function createEvent(title, type, date) {
    if (!title) return;
    const blocks = eventTypeInfo(type).blocks.map(([blockTitle, loop, game = '']) => ({
        id: newBlockId(), title: blockTitle, time: '', loop, game, tracks: []
    }));
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const data = { uid: fb.getCurrentUser().uid, title, type, date, blocks, createdAt: Date.now() };
        const ref = await fb.addDoc(fb.collection(fb.db, "events"), data);
        const ev = { id: ref.id, ...data };
        events.push(ev);
        openEvent(ev);
    } catch (error) {
        console.error("Ошибка создания мероприятия:", error);
        alert("Не удалось создать мероприятие.");
    }
}

function openEvent(ev) {
    // Старые или повреждённые документы могут быть без блоков/треков — не падаем на них
    ev.blocks = (ev.blocks || []).map(b => ({ ...b, tracks: b.tracks || [] }));
    currentEvent = ev;
    startRequests(ev);
    renderEventDetail();
    window.scrollTo(0, 0);
}

// Сохраняем мероприятие целиком — блоков немного, а так проще не разъехаться
async function saveEvent() {
    if (!currentEvent || eventsOffline) return; // без сети работаем по копии, не сохраняем
    const { id, title, date, type, blocks } = currentEvent;
    try {
        const fb = await loadFirebase();
        await fb.updateDoc(fb.doc(fb.db, "events", id), { title, date, type, blocks });
        if (getOfflineEvents()[id]) storeOfflineEvent(currentEvent);
        syncPublicTitle(currentEvent);
    } catch (error) {
        console.error("Ошибка сохранения мероприятия:", error);
        alert("Не удалось сохранить изменения.");
    }
}

function renderEventDetail() {
    const ev = currentEvent;
    const info = eventTypeInfo(ev.type);
    const offlineStatus = el('p', { class: 'offline-status' }, '…');

    const header = el('div', { class: 'event-header' },
        el('button', { class: 'link-btn', dataset: { action: 'back' } }, ico('arrowLeft'), 'Все мероприятия'),
        el('input', { class: 'event-title-input', value: ev.title, dataset: { field: 'title' } }),
        el('div', { class: 'event-meta' },
            el('span', { class: 'event-type' }, ico(info.icon), info.label),
            el('input', { type: 'date', value: ev.date || '', dataset: { field: 'date' } })),
        el('div', { class: 'event-actions' },
            el('button', { class: 'primary-btn', dataset: { action: 'show' } }, ico('stage'), 'Режим ведущего'),
            el('button', { class: 'ghost-btn', dataset: { action: 'duplicate' }, title: 'Копия сценария с треками' }, ico('copy'), 'Копия'),
            el('button', { class: 'ghost-btn icon-only', dataset: { action: 'delete-event' }, 'aria-label': 'Удалить мероприятие' }, ico('trash'))),
        el('button', { class: 'ghost-btn', dataset: { action: 'download' } }, ico('download'), 'Скачать для офлайна'),
        offlineStatus,
        eventsOffline ? el('p', { class: 'offline-note' }, 'Нет сети — открыта скачанная копия, изменения не сохранятся') : null);
    renderOfflineStatus(ev, offlineStatus);

    const blocks = ev.blocks.map((block, i) => {
        const isPlaying = playingBlock && playingBlock.eventId === ev.id && playingBlock.blockId === block.id;
        const tracks = block.tracks.length === 0
            ? el('p', { class: 'block-empty' }, 'Без музыки — тишина')
            : el('ol', { class: 'block-tracks' }, ...block.tracks.map((track, t) =>
                el('li', {},
                    el('button', { class: 'mini-btn', dataset: { action: 'play-track', block: i, track: t }, 'aria-label': 'Играть' }, ico('play')),
                    el('span', { class: 'block-track-name' }, track.source === 'file' ? ico('folder') : null, track.name),
                    el('button', { class: 'mini-btn', dataset: { action: 'remove-track', block: i, track: t }, 'aria-label': 'Убрать' }, ico('close')))));

        return el('div', { class: isPlaying ? 'block-card playing' : 'block-card' },
            el('div', { class: 'block-row' },
                el('input', { type: 'time', value: block.time || '', dataset: { field: 'time', block: i } }),
                el('input', { class: 'block-title-input', value: block.title, dataset: { field: 'block-title', block: i } }),
                el('button', { class: 'play-btn', innerHTML: ICONS.play, dataset: { action: 'play-block', block: i }, 'aria-label': 'Запустить блок' })),
            el('div', { class: 'block-row block-tools' },
                el('select', { dataset: { field: 'loop', block: i } },
                    el('option', { value: 'loop', selected: block.loop }, 'Фон по кругу'),
                    el('option', { value: 'once', selected: !block.loop }, 'Сигнал, один раз')),
                el('button', { class: 'mini-btn', dataset: { action: 'move-up', block: i }, disabled: i === 0, 'aria-label': 'Выше' }, ico('arrowUp')),
                el('button', { class: 'mini-btn', dataset: { action: 'move-down', block: i }, disabled: i === ev.blocks.length - 1, 'aria-label': 'Ниже' }, ico('arrowDown')),
                el('button', { class: 'mini-btn', dataset: { action: 'remove-block', block: i }, 'aria-label': 'Удалить блок' }, ico('trash'))),
            el('div', { class: 'block-row block-tools' },
                el('select', { dataset: { field: 'game', block: i } },
                    ...Object.entries(GAMES).map(([value, g]) =>
                        el('option', { value, selected: (block.game || '') === value }, g.label)))),
            block.game ? el('p', { class: 'block-game-hint' }, GAMES[block.game].hint) : null,
            block.game === 'bingo' ? el('div', { class: 'block-row' },
                el('button', { class: 'ghost-btn', dataset: { action: 'bingo-print', block: i } }, ico('printer'), 'Карточки'),
                el('button', { class: 'ghost-btn', dataset: { action: 'bingo-qr', block: i } }, ico('phone'), 'На телефоны')) : null,
            tracks,
            el('button', { class: 'link-btn', dataset: { action: 'pick', block: i } }, ico('plus'), 'Добавить трек'));
    });

    renderRequestsPanel();
    eventsView.replaceChildren(header, requestsPanel, ...blocks,
        el('button', { class: 'ghost-btn add-block-btn', dataset: { action: 'add-block' } }, ico('plus'), 'Добавить блок'));
}

eventsView.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const { action } = target.dataset;
    const blockIndex = Number(target.dataset.block);
    const block = currentEvent && currentEvent.blocks[blockIndex];

    switch (action) {
        case 'open-event': {
            const ev = events.find(item => item.id === target.dataset.id);
            if (ev) openEvent(ev);
            break;
        }
        case 'back':
            loadEvents();
            break;
        case 'show':
            openShowMode();
            break;
        case 'download':
            downloadEventForOffline(target);
            break;
        case 'duplicate':
            duplicateEvent();
            break;
        case 'bingo-print':
            printBingoCards(block);
            break;
        case 'bingo-qr':
            publishBingo(currentEvent, block).then(ok => {
                if (ok) openQrFullscreen(bingoUrl(currentEvent.id), 'Карточка бинго');
            });
            break;
        case 'delete-event':
            if (confirm(`Удалить «${currentEvent.title}»?`)) deleteEvent();
            break;
        case 'play-block':
            playBlock(blockIndex);
            break;
        case 'play-track':
            playBlock(blockIndex, Number(target.dataset.track));
            break;
        case 'remove-track':
            block.tracks.splice(Number(target.dataset.track), 1);
            saveEvent();
            renderEventDetail();
            break;
        case 'move-up':
        case 'move-down': {
            const to = action === 'move-up' ? blockIndex - 1 : blockIndex + 1;
            const blocks = currentEvent.blocks;
            [blocks[blockIndex], blocks[to]] = [blocks[to], blocks[blockIndex]];
            saveEvent();
            renderEventDetail();
            break;
        }
        case 'remove-block':
            if (block.tracks.length === 0 || confirm(`Удалить блок «${block.title}» вместе с треками?`)) {
                currentEvent.blocks.splice(blockIndex, 1);
                saveEvent();
                renderEventDetail();
            }
            break;
        case 'add-block':
            currentEvent.blocks.push({ id: newBlockId(), title: 'Новый блок', time: '', loop: true, tracks: [] });
            saveEvent();
            renderEventDetail();
            break;
        case 'pick':
            pickTarget = { blockId: block.id };
            navSearch.click();
            break;
    }
});

eventsView.addEventListener('change', (e) => {
    const { field } = e.target.dataset;
    if (!field || !currentEvent) return;
    const block = currentEvent.blocks[Number(e.target.dataset.block)];
    const value = e.target.value;

    if (field === 'title') currentEvent.title = value.trim() || currentEvent.title;
    else if (field === 'date') currentEvent.date = value;
    else if (field === 'time') block.time = value;
    else if (field === 'block-title') block.title = value.trim() || block.title;
    else if (field === 'loop') block.loop = value === 'loop';
    else if (field === 'game') {
        block.game = value;
        saveEvent();
        renderEventDetail(); // подсказка и кнопки бинго зависят от игры
        return;
    }
    saveEvent();
});

async function deleteEvent() {
    const id = currentEvent.id;
    try {
        const fb = await loadFirebase();
        await fb.deleteDoc(fb.doc(fb.db, "events", id));
        // Ссылка у гостей перестанет работать вместе с мероприятием
        // Не полагаемся на загруженные publicEvent/requests — удаление могли нажать раньше
        const publicRef = fb.doc(fb.db, "public_events", id);
        if ((await fb.getDoc(publicRef).catch(() => null))?.exists()) await fb.deleteDoc(publicRef).catch(() => {});
        const eventRequests = await fb.getDocs(fb.query(fb.collection(fb.db, "requests"),
            fb.where("ownerUid", "==", fb.getCurrentUser().uid), fb.where("eventId", "==", id))).catch(() => null);
        if (eventRequests) await Promise.all(eventRequests.docs.map(d => fb.deleteDoc(d.ref).catch(() => {})));
        removeOfflineEvent(id);
        if (playingBlock && playingBlock.eventId === id) playingBlock = null;
        loadEvents();
    } catch (error) {
        console.error("Ошибка удаления мероприятия:", error);
        alert("Не удалось удалить мероприятие.");
    }
}

// Блок, в который сейчас добавляем треки, или null: открыли другое мероприятие,
// вернулись к списку или удалили блок — тогда кнопки «＋» не показываем вовсе
function pickBlock() {
    if (!pickTarget || !currentEvent) return null;
    return currentEvent.blocks.find(b => b.id === pickTarget.blockId) || null;
}

// Плашка «Добавляете в блок …» над поиском/библиотекой, пока выбираем треки
function renderPickBanner(view) {
    const block = pickBlock();
    if (!block || view === 'events') {
        pickBanner.classList.add('hidden');
        return;
    }
    pickBanner.replaceChildren(
        el('span', {}, `Добавляете в «${block.title}» · треков: ${block.tracks.length}`),
        el('button', { class: 'primary-btn', dataset: { action: 'pick-done' } }, 'Готово'));
    pickBanner.classList.remove('hidden');
}

pickBanner.addEventListener('click', (e) => {
    if (!e.target.closest('[data-action="pick-done"]')) return;
    pickTarget = null;
    navEvents.click();
});

function addTrackToPickTarget(track, btn) {
    const block = pickBlock();
    if (!block || !track) return;
    block.tracks.push({
        id: track.id, name: track.name, artist_name: track.artist_name, audio: track.audio,
        // undefined Firestore не примет — поле source пишем только у своих файлов
        ...(track.source === 'file' ? { source: 'file', fileKey: track.fileKey } : {})
    });
    saveEvent();
    btn.innerHTML = ICONS.check;
    btn.disabled = true;
    renderPickBanner('search');
}

// Новое затухание отменяет незаконченное: двойное нажатие «Следующий блок» или
// смена блока посреди отрывка квиза иначе запускали бы оба callback'а, а второе
// затухание начиналось бы с уже убавленной громкости и так её и оставляло
let activeFade = null; // { timer, startVolume, source }

// Отменяет затухание вместе с отложенным действием и возвращает громкость
function cancelFade() {
    if (!activeFade) return;
    clearInterval(activeFade.timer);
    if (activeFade.source === currentSource) playerSetVolume(activeFade.startVolume);
    activeFade = null;
}

// Плавно уводит громкость в ноль, затем вызывает callback (смена блока без обрыва звука)
function fadeOutThen(callback, ms = 1200) {
    let startVolume = null;
    if (activeFade) {
        clearInterval(activeFade.timer);
        if (activeFade.source === currentSource) startVolume = activeFade.startVolume;
        activeFade = null;
    }
    if (!playerIsPlaying()) {
        if (startVolume !== null) playerSetVolume(startVolume);
        callback();
        return;
    }
    const steps = 12;
    if (startVolume === null) startVolume = playerGetVolume();
    const fadingSource = currentSource;
    let step = 0;
    const fade = { startVolume, source: fadingSource };
    activeFade = fade;
    const timer = fade.timer = setInterval(() => {
        step++;
        // Источник сменился посреди затухания — громкость нового трека не трогаем
        if (currentSource === fadingSource) playerSetVolume(Math.round(startVolume * (1 - step / steps)));
        if (step >= steps) {
            clearInterval(timer);
            activeFade = null;
            callback();
            // Если callback только поставил на паузу — возвращаем громкость,
            // иначе после «Играть» музыка продолжится беззвучно. Если же callback
            // переключил источник (YouTube ↔ файл), громкость нового уже выставлена
            if (currentSource === fadingSource) playerSetVolume(startVolume);
        }
    }, ms / steps);
}

function playBlock(blockIndex, trackIndex = 0) {
    const ev = currentEvent;
    const block = ev && ev.blocks[blockIndex];
    if (!block) return;

    if (block.game && block.tracks.length && !showMode.classList.contains('open')) openShowMode();
    fadeOutThen(() => {
        stopGame();
        if (block.tracks.length && block.game) {
            startGame(ev, block, trackIndex);
        } else if (block.tracks.length === 0) {
            // Блок-тишина: просто останавливаем музыку
            playingBlock = { eventId: ev.id, blockId: block.id };
            activeQueue = null;
            playerPause();
            renderShowNow('Тишина');
        } else {
            // Копия треков — пометки «недоступен» не должны попасть в сохранённое мероприятие
            const tracks = block.tracks.map(t => ({ ...t }));
            startList(trackIndex, tracks, false, { loop: block.loop, block: { eventId: ev.id, blockId: block.id } });
        }
        if (!eventsView.classList.contains('hidden') && currentEvent === ev) renderEventDetail();
        renderShowBlocks();
    });
}

// --- 12. РЕЖИМ ВЕДУЩЕГО ---
// Полноэкранный пульт: видно видео (YouTube требует видимый плеер), текущий блок,
// большая кнопка «Следующий блок» и весь сценарий. Экран не гаснет (Wake Lock).
const showMode = document.getElementById('show-mode');
const showEventTitle = document.getElementById('show-event-title');
const showClock = document.getElementById('show-clock');
const showBlockTitle = document.getElementById('show-block-title');
const showTrackTitle = document.getElementById('show-track-title');
const showBlocks = document.getElementById('show-blocks');
const showPlayPause = document.getElementById('show-playpause');
let clockTimer = null;
let wakeLock = null;

function openShowMode() {
    if (!currentEvent) return;
    showEventTitle.textContent = currentEvent.title;
    showMode.classList.add('open');
    showMode.removeAttribute('inert');
    document.body.classList.add('show-open');
    updateClock();
    clearInterval(clockTimer); // повторное открытие не должно плодить таймеры
    clockTimer = setInterval(updateClock, 1000);
    if (!wakeLock || wakeLock.released) requestWakeLock();
    renderShowNow();
    renderShowBlocks();
    updateShowPlayPause();
}

function closeShowMode() {
    showMode.classList.remove('open');
    showMode.setAttribute('inert', '');
    document.body.classList.remove('show-open');
    clearInterval(clockTimer);
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
    if (currentEvent && !eventsView.classList.contains('hidden')) renderEventDetail();
}

function updateClock() {
    showClock.textContent = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

async function requestWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
        const lock = await navigator.wakeLock.request('screen');
        // Пульт успели закрыть, пока ждали разрешения, — замок сразу отпускаем
        if (!showMode.classList.contains('open')) {
            lock.release().catch(() => {});
            return;
        }
        wakeLock = lock;
    } catch (error) {
        console.warn("Не удалось запретить гашение экрана:", error);
    }
}

// Wake Lock снимается, когда вкладка уходит в фон — возвращаем его
document.addEventListener('visibilitychange', () => {
    // Только если прежний действительно снят: лишний «висящий» замок не отпустился бы
    // при закрытии пульта, и экран перестал бы гаснуть вовсе
    if (document.visibilityState === 'visible' && showMode.classList.contains('open')
        && (!wakeLock || wakeLock.released)) requestWakeLock();
});

function currentBlockIndex() {
    if (!playingBlock || !currentEvent || playingBlock.eventId !== currentEvent.id) return -1;
    return currentEvent.blocks.findIndex(b => b.id === playingBlock.blockId);
}

function renderShowNow(status) {
    if (!showMode.classList.contains('open')) return;
    const index = currentBlockIndex();
    const block = index >= 0 ? currentEvent.blocks[index] : null;
    showBlockTitle.textContent = block ? block.title : 'Ничего не запущено';
    const track = activeQueue && activeQueue[activeQueueIndex];
    const hidden = activeGame && activeGame.type === 'quiz' && !activeGame.revealed;
    showTrackTitle.textContent = status || (block && track ? (hidden ? '??? — угадайте!' : track.name) : '');
    renderGame();
}

function renderShowBlocks() {
    if (!showMode.classList.contains('open') || !currentEvent) return;
    const current = currentBlockIndex();
    showBlocks.replaceChildren(...currentEvent.blocks.map((block, i) =>
        el('li', {},
            el('button', { class: i === current ? 'show-block current' : 'show-block', dataset: { block: i } },
                el('span', { class: 'show-block-time' }, block.time || '—'),
                el('span', { class: 'show-block-title' }, block.title),
                el('span', { class: 'show-block-kind' },
                    ico(block.game ? GAMES[block.game].icon : block.tracks.length === 0 ? 'silence' : (block.loop ? 'loop' : 'signal')))))));
    const currentEl = showBlocks.querySelector('.current');
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest' });
}

function updateShowPlayPause() {
    const playing = playerIsPlaying();
    setIconLabel(showPlayPause, playing ? 'pause' : 'play', playing ? 'Пауза' : 'Играть');
}

showBlocks.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-block]');
    if (btn) playBlock(Number(btn.dataset.block));
});

document.getElementById('show-close').addEventListener('click', closeShowMode);

document.getElementById('show-next').addEventListener('click', () => {
    if (!currentEvent || currentEvent.blocks.length === 0) return;
    const next = currentBlockIndex() + 1;
    if (next < currentEvent.blocks.length) playBlock(next);
});

showPlayPause.addEventListener('click', () => {
    if (playerIsPlaying()) {
        playerPause();
    } else if (!activeQueue && currentBlockIndex() >= 0) {
        playBlock(currentBlockIndex());
    } else {
        playerPlay();
    }
});

document.getElementById('show-stop').addEventListener('click', () => {
    fadeOutThen(() => {
        playerPause();
        renderShowNow('Остановлено');
    });
});

// --- 13. АККАУНТ: GOOGLE ИЛИ ПОЧТА (НЕОБЯЗАТЕЛЬНО) ---
// Без входа всё работает как раньше — на анонимном uid этого устройства.
// Вход нужен, чтобы видеть свои мероприятия, лайки и файлы на всех устройствах.
// - Первое устройство: анонимная сессия превращается в аккаунт (link), uid прежний.
// - Аккаунт уже есть (вход на втором устройстве): входим в него и переносим
//   туда всё, что было на этом устройстве без аккаунта.
const accountBtn = document.getElementById('account-btn');
const accountSheet = document.getElementById('account-sheet');
let accountUid = null; // чей uid сейчас показан — чтобы перерисовать экраны при смене

const AUTH_ERRORS = {
    'auth/invalid-email': 'Неверный адрес почты',
    'auth/missing-password': 'Введите пароль',
    'auth/weak-password': 'Пароль должен быть не короче 6 символов',
    'auth/email-already-in-use': 'Аккаунт с этой почтой уже есть — нажмите «Войти»',
    'auth/invalid-credential': 'Неверная почта или пароль',
    'auth/wrong-password': 'Неверная почта или пароль',
    'auth/user-not-found': 'Неверная почта или пароль',
    'auth/too-many-requests': 'Слишком много попыток, попробуйте позже',
    'auth/popup-blocked': 'Браузер заблокировал окно входа — разрешите всплывающие окна',
    'auth/popup-closed-by-user': 'Окно входа закрыто',
    'auth/cancelled-popup-request': 'Окно входа закрыто',
    'auth/network-request-failed': 'Нет сети',
    'auth/credential-already-in-use': 'Этот аккаунт уже используется',
    'migrate-failed': 'Вы вошли, но перенести в аккаунт данные этого устройства не удалось'
};

function authErrorText(error) {
    return AUTH_ERRORS[error.code] || `Не получилось: ${error.message}`;
}

function isSignedIn(user) {
    return !!user && !user.isAnonymous;
}

function updateAccountButton(user) {
    if (isSignedIn(user)) {
        const name = user.displayName || user.email || 'Аккаунт';
        accountBtn.textContent = name.trim()[0].toUpperCase();
        accountBtn.classList.add('signed-in');
        accountBtn.setAttribute('aria-label', `Аккаунт: ${name}`);
    } else {
        accountBtn.textContent = 'Войти';
        accountBtn.classList.remove('signed-in');
        accountBtn.setAttribute('aria-label', 'Войти в аккаунт');
    }
}

// Сменился пользователь — перерисовываем открытый экран с его данными.
// force — данные того же пользователя изменились (перенесли с устройства)
function afterAuthChange(user, force = false) {
    updateAccountButton(user);
    if (accountUid === user.uid && !force) return;
    const firstTime = accountUid === null && !force;
    accountUid = user.uid;
    if (firstTime) return; // первый вход при загрузке — экраны и так грузят данные после authReady
    recentUploads.length = 0;
    recentlyDeleted.clear();
    currentEvent = null;
    // Подписка на заказы прежнего пользователя после выхода упала бы с отказом в
    // доступе, а «＋» продолжал бы целиться в блок чужого мероприятия
    stopRequests();
    pickTarget = null;
    renderPickBanner();
    if (navSearch.classList.contains('active') && lastSearchTracks) renderSearchResults();
    if (navLibrary.classList.contains('active')) loadLibrary();
    if (navEvents.classList.contains('active')) loadEvents();
}

// Подписываемся и сразу показываем текущего — первое событие входа могло пройти до подписки
loadFirebase().then(async (fb) => {
    fb.onAuthChange(afterAuthChange);
    await fb.authReady;
    afterAuthChange(fb.getCurrentUser());
}).catch(() => {});

accountBtn.addEventListener('click', openAccountSheet);
accountSheet.addEventListener('click', (e) => {
    if (e.target === accountSheet) closeAccountSheet(); // клик мимо карточки
});

async function openAccountSheet() {
    accountSheet.classList.remove('hidden');
    renderAccountSheet(null, 'Загрузка…');
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        renderAccountSheet(fb.getCurrentUser());
    } catch (error) {
        renderAccountSheet(null, 'Нет связи с сервером входа');
    }
}

function closeAccountSheet() {
    accountSheet.classList.add('hidden');
}

function renderAccountSheet(user, statusText = '') {
    const status = el('p', { class: 'account-status', id: 'account-status' }, statusText);
    const close = el('button', { class: 'sheet-close', 'aria-label': 'Закрыть', dataset: { action: 'close' } }, ico('close'));
    let body;

    if (isSignedIn(user)) {
        const via = user.providerData.some(p => p.providerId === 'google.com') ? 'через Google' : 'по почте';
        body = [
            el('h2', { id: 'account-title' }, 'Аккаунт'),
            el('p', {}, 'Вы вошли ', via, ': ', el('strong', {}, user.displayName || user.email)),
            user.displayName && user.email ? el('p', { class: 'account-email' }, user.email) : null,
            el('p', { class: 'account-hint' }, 'Мероприятия, «Моя музыка» и свои файлы доступны на всех устройствах, где вы вошли в этот аккаунт.'),
            el('button', { class: 'ghost-btn wide', dataset: { action: 'sign-out' } }, 'Выйти'),
            status
        ];
    } else {
        const form = el('form', { class: 'account-form', id: 'email-form' },
            el('input', { type: 'email', name: 'email', placeholder: 'Почта', autocomplete: 'email', required: true }),
            el('input', { type: 'password', name: 'password', placeholder: 'Пароль (от 6 символов)', autocomplete: 'current-password', minLength: 6 }),
            el('div', { class: 'account-row' },
                el('button', { type: 'submit', class: 'primary-btn', dataset: { action: 'email-login' } }, 'Войти'),
                el('button', { type: 'button', class: 'ghost-btn', dataset: { action: 'email-register' } }, 'Создать аккаунт')),
            el('button', { type: 'button', class: 'link-btn', dataset: { action: 'reset' } }, 'Забыли пароль?'));
        body = [
            el('h2', { id: 'account-title' }, 'Вход'),
            el('p', { class: 'account-hint' }, 'Сейчас вы без аккаунта — всё хранится только на этом устройстве. Войдите, чтобы видеть мероприятия и музыку на телефоне и компьютере. Можно продолжать и без входа.'),
            el('button', { class: 'google-btn', dataset: { action: 'google' } }, el('span', { class: 'google-g' }, 'G'), 'Войти через Google'),
            el('div', { class: 'account-divider' }, 'или по почте'),
            form,
            status,
            el('button', { class: 'link-btn wide', dataset: { action: 'close' } }, 'Продолжить без входа')
        ];
    }
    accountSheet.querySelector('.sheet-card').replaceChildren(close, ...body.filter(Boolean));
}

function setAccountStatus(text, isError = false) {
    const status = document.getElementById('account-status');
    if (!status) return;
    status.textContent = text;
    status.classList.toggle('error', isError);
}

accountSheet.addEventListener('submit', (e) => {
    e.preventDefault();
    accountAction('email-login');
});

accountSheet.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    // Кнопку отправки формы обработает 'submit' (он же ловит Enter в поле пароля)
    if (!btn || (btn.type === 'submit' && btn.form)) return;
    accountAction(btn.dataset.action);
});

async function accountAction(action) {
    if (action === 'close') {
        closeAccountSheet();
        return;
    }
    const form = document.getElementById('email-form');
    const email = form ? form.elements.email.value.trim() : '';
    const password = form ? form.elements.password.value : '';
    const buttons = accountSheet.querySelectorAll('button');
    buttons.forEach(b => { b.disabled = true; });

    let fb = null;
    try {
        fb = await loadFirebase();
        await fb.authReady;
        if (action === 'google') {
            setAccountStatus('Открываем окно Google…');
            await signInWithGoogle(fb);
        } else if (action === 'email-login') {
            if (!email || !password) throw { code: !email ? 'auth/invalid-email' : 'auth/missing-password' };
            setAccountStatus('Входим…');
            await switchAccount(fb, () => fb.signInWithEmailAndPassword(fb.auth, email, password));
        } else if (action === 'email-register') {
            if (!email || !password) throw { code: !email ? 'auth/invalid-email' : 'auth/missing-password' };
            setAccountStatus('Создаём аккаунт…');
            // Анонимную сессию превращаем в аккаунт — данные этого устройства остаются на месте
            await fb.linkWithCredential(fb.getCurrentUser(), fb.EmailAuthProvider.credential(email, password));
            afterAuthChange(fb.getCurrentUser());
        } else if (action === 'reset') {
            if (!email) throw { code: 'auth/invalid-email' };
            await fb.sendPasswordResetEmail(fb.auth, email);
            renderAccountSheet(fb.getCurrentUser());
            document.getElementById('email-form').elements.email.value = email;
            setAccountStatus(`Если аккаунт с почтой ${email} есть, на неё пришло письмо со ссылкой для нового пароля. Проверьте и папку «Спам».`);
            return;
        } else if (action === 'sign-out') {
            if (!confirm('Выйти из аккаунта? На этом устройстве откроется пустое приложение без аккаунта; ваши данные останутся в аккаунте.')) return;
            // onAuthStateChanged сам создаст новую анонимную сессию — ждём её.
            // Подписываемся до выхода, чтобы не пропустить событие, и отписываемся после
            let unsubscribe = () => {};
            const anonReady = new Promise(resolve => { unsubscribe = fb.onAuthChange(resolve); });
            await fb.signOut(fb.auth);
            await anonReady;
            unsubscribe();
        }
        renderAccountSheet(fb.getCurrentUser(), isSignedIn(fb.getCurrentUser()) ? '✓ Готово' : 'Вы вышли из аккаунта');
    } catch (error) {
        console.warn("Ошибка входа:", error);
        if (fb && isSignedIn(fb.getCurrentUser())) renderAccountSheet(fb.getCurrentUser());
        setAccountStatus(authErrorText(error), true);
    } finally {
        accountSheet.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
}

async function signInWithGoogle(fb) {
    const provider = new fb.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const user = fb.getCurrentUser();
    if (!user.isAnonymous) {
        await fb.signInWithPopup(fb.auth, provider);
        return;
    }
    try {
        // Первое устройство: анонимная сессия становится аккаунтом, uid и данные прежние
        await fb.linkWithPopup(user, provider);
        afterAuthChange(fb.getCurrentUser());
    } catch (error) {
        if (error.code !== 'auth/credential-already-in-use') throw error;
        // Аккаунт уже есть — входим в него и переносим данные этого устройства
        const credential = fb.GoogleAuthProvider.credentialFromError(error);
        await switchAccount(fb, () => fb.signInWithCredential(fb.auth, credential));
    }
}

// Вход в существующий аккаунт с переносом данных анонимной сессии этого устройства
async function switchAccount(fb, signIn) {
    const anon = fb.getCurrentUser();
    let saved = null;
    let readFailed = false;
    if (anon && anon.isAnonymous) {
        try {
            const byUid = (name) => fb.query(fb.collection(fb.db, name), fb.where("uid", "==", anon.uid));
            const [liked, evs] = await Promise.all([fb.getDocs(byUid("liked_tracks")), fb.getDocs(byUid("events"))]);
            saved = {
                liked: liked.docs.map(d => d.data()),
                events: evs.docs.map(d => ({ id: d.id, ...d.data() })),
                token: await anon.getIdToken()
            };
        } catch (error) {
            // Не смогли прочитать данные устройства — входить всё равно даём, но предупреждаем
            console.error("Не удалось прочитать данные устройства для переноса:", error);
            readFailed = true;
        }
    }

    await signIn();
    const user = fb.getCurrentUser();
    if (saved) {
        setAccountStatus('Переносим данные этого устройства в аккаунт…');
        await migrateAnonData(fb, user, saved);
    }
    afterAuthChange(user, true);
    if (readFailed) throw { code: 'migrate-failed' };
}

async function migrateAnonData(fb, user, saved) {
    // 1. Файлы: воркер перекладывает их под uid аккаунта и возвращает новые ключи
    const keyMap = new Map();
    try {
        const { moved } = await filesApi('/migrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromToken: saved.token })
        });
        moved.forEach(({ from, to }) => keyMap.set(from, to));
        await moveCachedFiles(keyMap);
    } catch (error) {
        console.error("Не удалось перенести файлы:", error);
    }
    const remapTrack = (track) => {
        const to = track.fileKey && keyMap.get(track.fileKey);
        return to ? { ...track, fileKey: to, audio: `${FILES_API}/files/${encodeFileKey(to)}` } : track;
    };

    // 2. Лайки — без дублей с теми, что уже есть в аккаунте
    const existing = await fb.getDocs(fb.query(fb.collection(fb.db, "liked_tracks"), fb.where("uid", "==", user.uid)));
    const known = new Set(existing.docs.map(d => d.data().audioUrl));
    for (const like of saved.liked) {
        if (known.has(like.audioUrl)) continue;
        known.add(like.audioUrl);
        await fb.addDoc(fb.collection(fb.db, "liked_tracks"), { ...like, uid: user.uid });
    }

    // 3. Мероприятия — копией под аккаунт; скачанные для офлайна копии переименовываем
    const offline = getOfflineEvents();
    for (const ev of saved.events) {
        const { id, ...data } = ev;
        const blocks = data.blocks.map(b => ({ ...b, tracks: b.tracks.map(remapTrack) }));
        const ref = await fb.addDoc(fb.collection(fb.db, "events"), { ...data, blocks, uid: user.uid });
        if (offline[id]) {
            removeOfflineEvent(id);
            storeOfflineEvent({ id: ref.id, ...data, blocks });
        }
    }
    // Анонимные оригиналы остаются в базе — удалить их может только их владелец,
    // а он уже вышел. На работу приложения это не влияет.
}

// Скачанные для офлайна файлы переезжают на новые адреса — переносим и копии в кэше
async function moveCachedFiles(keyMap) {
    if (!('caches' in window) || keyMap.size === 0) return;
    const cache = await caches.open(FILES_CACHE);
    for (const [from, to] of keyMap) {
        const fromUrl = `${FILES_API}/files/${encodeFileKey(from)}`;
        const cached = await cache.match(fromUrl, { ignoreVary: true });
        if (!cached) continue;
        await cache.put(`${FILES_API}/files/${encodeFileKey(to)}`, cached);
        await cache.delete(fromUrl, { ignoreVary: true });
    }
}

// --- 14. ЗАКАЗЫ ПЕСЕН ГОСТЯМИ ПО QR-КОДУ (сторона организатора) ---
// Гость сканирует QR → страница ?guest=<id мероприятия> (раздел 15) → документ в
// коллекции requests. Само мероприятие гостям не видно: им открыт только
// public_events/<id> — название и открыт ли приём заказов.
// Одинаковые заказы складываются в один («×3») — заодно это голосование.
const REQUESTS_PER_GUEST = 3; // сколько заказов гость может держать в ожидании

let publicEvent = null;     // public_events/<id> текущего мероприятия или null
let requests = [];          // заказы текущего мероприятия
let requestsUnsub = null;   // отписка от живого списка
let requestsEventId = null;
let requestTargetBlockId = null; // куда добавлять принятые заказы

// Панель заказов живёт дольше одной отрисовки сценария — её узел переиспользуем
const requestsPanel = el('section', { class: 'requests-panel' });

function guestUrl(eventId) {
    return `${location.origin}/?guest=${encodeURIComponent(eventId)}`;
}

// QR как SVG; библиотека генерирует разметку сама, пользовательских данных в ней нет
function qrNode(url, className = 'qr') {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    const box = el('div', { class: className });
    box.innerHTML = qr.createSvgTag(4, 2);
    return box;
}

function stopRequests() {
    if (requestsUnsub) requestsUnsub();
    requestsUnsub = null;
    requestsEventId = null;
    requests = [];
    publicEvent = null;
    updateShowRequestsBadge();
}

async function startRequests(ev) {
    if (requestsEventId === ev.id) return;
    stopRequests();
    requestsEventId = ev.id;
    renderRequestsPanel();
    if (eventsOffline) return;
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const snap = await fb.getDoc(fb.doc(fb.db, "public_events", ev.id));
        if (requestsEventId !== ev.id) return;
        publicEvent = snap.exists() ? snap.data() : null;
        const q = fb.query(fb.collection(fb.db, "requests"),
            fb.where("ownerUid", "==", fb.getCurrentUser().uid), fb.where("eventId", "==", ev.id));
        requestsUnsub = fb.onSnapshot(q, (snapshot) => {
            requests = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            renderRequestsPanel();
            renderShowRequests();
            updateShowRequestsBadge();
        }, (error) => console.error("Ошибка списка заказов:", error));
        renderRequestsPanel();
    } catch (error) {
        console.error("Не удалось загрузить заказы:", error);
    }
}

// Новые заказы, сгруппированные по песне: популярные сверху
function groupedNewRequests() {
    const groups = new Map();
    for (const r of requests.filter(r => r.status === 'new')) {
        const key = r.videoId || r.name.trim().toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    return [...groups.values()]
        .map(items => items.sort((a, b) => a.createdAt - b.createdAt))
        .sort((a, b) => b.length - a.length || a[0].createdAt - b[0].createdAt);
}

async function setRequestsOpen(open) {
    const ev = currentEvent;
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const data = { ownerUid: fb.getCurrentUser().uid, title: ev.title, requestsOpen: open, updatedAt: Date.now() };
        // Не стираем опубликованные карточки бинго. Берём их из базы, а не из publicEvent:
        // он мог ещё не загрузиться, и тогда setDoc молча удалил бы бинго у гостей
        const current = await readPublicEvent(fb, ev.id);
        if (current && current.bingo) data.bingo = current.bingo;
        await fb.setDoc(fb.doc(fb.db, "public_events", ev.id), data);
        if (currentEvent === ev) publicEvent = data;
    } catch (error) {
        console.error("Не удалось изменить приём заказов:", error);
        alert("Не удалось изменить приём заказов.");
    }
    renderRequestsPanel();
}

// Свежая публичная карточка мероприятия из базы (или то, что уже загружено, если не вышло)
async function readPublicEvent(fb, eventId) {
    try {
        const snap = await fb.getDoc(fb.doc(fb.db, "public_events", eventId));
        return snap.exists() ? snap.data() : null;
    } catch (error) {
        console.warn("Не удалось прочитать публичную карточку:", error);
        return requestsEventId === eventId ? publicEvent : null;
    }
}

// Название меняли — гостям тоже показываем новое
async function syncPublicTitle(ev) {
    if (!publicEvent || publicEvent.title === ev.title) return;
    try {
        const fb = await loadFirebase();
        await fb.updateDoc(fb.doc(fb.db, "public_events", ev.id), { title: ev.title, updatedAt: Date.now() });
        publicEvent.title = ev.title;
    } catch (error) {
        console.warn("Не удалось обновить название для гостей:", error);
    }
}

function defaultTargetBlock() {
    const blocks = currentEvent.blocks;
    const current = currentBlockIndex();
    if (requestTargetBlockId && blocks.some(b => b.id === requestTargetBlockId)) return requestTargetBlockId;
    if (current >= 0 && blocks[current].loop) return blocks[current].id;
    const dance = [...blocks].reverse().find(b => b.loop);
    return (dance || blocks[0] || {}).id || null;
}

async function setRequestsStatus(items, status) {
    try {
        const fb = await loadFirebase();
        await Promise.all(items.map(r => fb.updateDoc(fb.doc(fb.db, "requests", r.id), { status })));
    } catch (error) {
        console.error("Не удалось обновить заказ:", error);
        alert("Не удалось обновить заказ.");
    }
}

async function acceptRequestGroup(items) {
    const first = items[0];
    const block = currentEvent.blocks.find(b => b.id === defaultTargetBlock());
    if (!block) {
        alert('В сценарии нет блоков — добавьте блок, чтобы принимать заказы.');
        renderRequestsPanel(); // вернуть нажатой кнопке «✓» доступность
        renderShowRequests();
        return;
    }

    if (!first.videoId) {
        // Гость написал название без поиска — ищем сами и добавляем кнопкой ＋
        await setRequestsStatus(items, 'accepted');
        if (showMode.classList.contains('open')) closeShowMode();
        pickTarget = { blockId: block.id };
        navSearch.click();
        searchInput.value = first.name;
        searchMusic(first.name);
        return;
    }

    const track = { id: first.videoId, name: first.name, artist_name: first.artist_name || '', audio: first.videoId };
    block.tracks.push(track);
    // Блок уже звучит — песня встаёт в его очередь сразу
    if (playingBlock && playingBlock.blockId === block.id && activeQueue) activeQueue.push({ ...track });
    saveEvent();
    await setRequestsStatus(items, 'accepted');
    if (!eventsView.classList.contains('hidden')) renderEventDetail();
}

// Список новых заказов — общий для экрана мероприятия и режима ведущего
function requestsListNode() {
    const groups = groupedNewRequests();
    if (groups.length === 0) return el('p', { class: 'requests-empty' }, 'Новых заказов нет');

    const targetSelect = el('select', { class: 'requests-target', dataset: { requestsField: 'target' } },
        ...currentEvent.blocks.map(b => el('option', { value: b.id, selected: b.id === defaultTargetBlock() }, `в блок «${b.title}»`)));

    return el('div', {},
        el('div', { class: 'requests-target-row' }, el('span', {}, 'Принятые —'), targetSelect),
        el('ol', { class: 'requests-list' }, ...groups.map((items, i) => {
            const first = items[0];
            const names = [...new Set(items.map(r => r.guestName).filter(Boolean))].join(', ');
            return el('li', {},
                el('span', { class: 'request-info' },
                    el('strong', {}, first.name, items.length > 1 ? el('span', { class: 'request-count' }, ` ×${items.length}`) : null),
                    el('span', {}, [first.videoId ? (first.artist_name || 'YouTube') : 'название без поиска', names && `от: ${names}`].filter(Boolean).join(' · '))),
                el('button', { class: 'mini-btn accept', dataset: { requestAction: 'accept', group: i }, 'aria-label': 'Принять' }, ico('check')),
                el('button', { class: 'mini-btn', dataset: { requestAction: 'reject', group: i }, 'aria-label': 'Отклонить' }, ico('close')));
        })));
}

function renderRequestsPanel() {
    if (!currentEvent) return;
    const open = !!(publicEvent && publicEvent.requestsOpen);
    const accepted = requests.filter(r => r.status === 'accepted').length;
    const url = guestUrl(currentEvent.id);

    const children = [
        el('div', { class: 'requests-head' },
            el('h3', {}, ico('phone'), 'Заказы гостей'),
            el('label', { class: 'switch' },
                el('input', { type: 'checkbox', checked: open, disabled: eventsOffline, dataset: { requestsField: 'open' } }),
                el('span', {}, open ? 'Принимаем' : 'Закрыто')))
    ];
    if (eventsOffline) {
        children.push(el('p', { class: 'requests-empty' }, 'Без сети заказы недоступны'));
    } else if (open) {
        children.push(
            el('div', { class: 'requests-share' },
                qrNode(url),
                el('div', { class: 'requests-share-actions' },
                    el('p', { class: 'requests-hint' }, 'Гости сканируют код камерой телефона — без установки и регистрации.'),
                    el('button', { class: 'ghost-btn', dataset: { requestAction: 'share' } }, navigator.share ? 'Поделиться ссылкой' : 'Скопировать ссылку'),
                    el('button', { class: 'ghost-btn', dataset: { requestAction: 'qr-full' } }, 'QR на весь экран'))),
            requestsListNode(),
            accepted ? el('p', { class: 'requests-hint' }, `Принято за вечер: ${accepted}`) : null);
    } else {
        children.push(el('p', { class: 'requests-hint' }, 'Включите, чтобы показать гостям QR-код: они смогут заказывать песни со своих телефонов.'));
    }
    requestsPanel.replaceChildren(...children.filter(Boolean));
}

// Действия с заказами — и на экране мероприятия, и в режиме ведущего
async function handleRequestsClick(e) {
    const btn = e.target.closest('[data-request-action]');
    if (!btn || !currentEvent) return;
    const groups = groupedNewRequests();
    const action = btn.dataset.requestAction;
    if (action === 'accept' || action === 'reject') {
        const items = groups[Number(btn.dataset.group)];
        if (!items) return;
        btn.disabled = true;
        if (action === 'accept') await acceptRequestGroup(items);
        else await setRequestsStatus(items, 'rejected');
    } else if (action === 'share') {
        const url = guestUrl(currentEvent.id);
        if (navigator.share) {
            navigator.share({ title: currentEvent.title, text: 'Закажите песню', url }).catch(() => {});
        } else {
            try {
                await navigator.clipboard.writeText(url);
                setIconLabel(btn, 'check', 'Ссылка скопирована');
            } catch {
                prompt('Ссылка для гостей:', url);
            }
        }
    } else if (action === 'qr-full') {
        openQrFullscreen(guestUrl(currentEvent.id));
    }
}

function handleRequestsChange(e) {
    const field = e.target.dataset.requestsField;
    if (field === 'open') setRequestsOpen(e.target.checked);
    else if (field === 'target') {
        requestTargetBlockId = e.target.value;
        renderRequestsPanel();
        renderShowRequests();
    }
}

requestsPanel.addEventListener('click', handleRequestsClick);
requestsPanel.addEventListener('change', handleRequestsChange);

// --- 14.1 Заказы в режиме ведущего: счётчик, список и QR на весь экран ---
const showRequestsBtn = document.getElementById('show-requests');
const showRequestsPanel = document.getElementById('show-requests-panel');
const qrFullscreen = document.getElementById('qr-fullscreen');

function updateShowRequestsBadge() {
    const count = groupedNewRequests().length;
    const open = !!(publicEvent && publicEvent.requestsOpen);
    showRequestsBtn.classList.toggle('hidden', !open && count === 0);
    showRequestsBtn.replaceChildren(ico('phone'), ...(count ? [document.createTextNode(String(count))] : []));
    showRequestsBtn.classList.toggle('has-new', count > 0);
}

function renderShowRequests() {
    if (showRequestsPanel.classList.contains('hidden') || !currentEvent) return;
    showRequestsPanel.replaceChildren(
        el('div', { class: 'show-requests-head' },
            el('strong', {}, 'Заказы гостей'),
            el('button', { class: 'ghost-btn', dataset: { requestAction: 'qr-full' } }, ico('qr'), 'QR для гостей'),
            el('button', { class: 'sheet-close', dataset: { requestAction: 'close-panel' }, 'aria-label': 'Закрыть' }, ico('close'))),
        requestsListNode());
}

showRequestsBtn.addEventListener('click', () => {
    showRequestsPanel.classList.toggle('hidden');
    renderShowRequests();
});
showRequestsPanel.addEventListener('click', (e) => {
    if (e.target.closest('[data-request-action="close-panel"]')) {
        showRequestsPanel.classList.add('hidden');
        return;
    }
    handleRequestsClick(e);
});
showRequestsPanel.addEventListener('change', handleRequestsChange);

function openQrFullscreen(url = currentEvent && guestUrl(currentEvent.id), heading = 'Закажите песню') {
    if (!currentEvent) return;
    qrFullscreen.replaceChildren(
        el('p', { class: 'qr-title' }, heading),
        qrNode(url, 'qr qr-big'),
        el('p', { class: 'qr-event' }, currentEvent.title),
        el('p', { class: 'qr-url' }, url.replace(/^https?:\/\//, '')),
        el('button', { class: 'ghost-btn', dataset: { action: 'close-qr' } }, 'Закрыть'));
    qrFullscreen.classList.remove('hidden');
}

qrFullscreen.addEventListener('click', (e) => {
    if (e.target === qrFullscreen || e.target.closest('[data-action="close-qr"]')) qrFullscreen.classList.add('hidden');
});

// --- 15. СТРАНИЦА ГОСТЯ: ЗАКАЗ ПЕСНИ ---
const guestView = document.getElementById('guest-view');

async function startGuestPage(eventId) {
    document.body.classList.add('guest-mode');
    guestView.classList.remove('hidden');
    document.title = 'Заказ песни';
    guestView.replaceChildren(el('p', { class: 'status' }, 'Загрузка…'));

    let fb;
    try {
        fb = await loadFirebase();
        await fb.authReady; // гость входит анонимно — только чтобы подписать свои заказы
    } catch (error) {
        guestView.replaceChildren(el('p', { class: 'status' }, 'Нет связи. Проверьте интернет и обновите страницу.'));
        return;
    }
    const guestUid = fb.getCurrentUser().uid;
    let pub = null;
    let mine = [];

    const nameInput = el('input', { type: 'text', maxLength: 40, placeholder: 'Ваше имя (необязательно)', value: localStorage.getItem('guestName') || '' });
    nameInput.addEventListener('change', () => {
        try { localStorage.setItem('guestName', nameInput.value.trim()); } catch { /* приватный режим */ }
    });
    const searchBox = el('input', { type: 'search', placeholder: 'Найдите песню или исполнителя', enterKeyHint: 'search' });
    const results = el('div', { class: 'guest-results' });
    const textBox = el('input', { type: 'text', maxLength: 150, placeholder: 'Или напишите название сами' });
    const status = el('p', { class: 'guest-status' });
    const mineList = el('ol', { class: 'guest-mine' });
    const title = el('h1', {}, '…');
    const closedNote = el('p', { class: 'guest-closed hidden' }, 'Организатор сейчас не принимает заказы. Загляните позже!');
    // Форма скрыта, пока не узнали, открыт ли приём, — иначе быстрый заказ отклонялся бы
    const form = el('div', { class: 'guest-form hidden' },
        nameInput,
        el('form', { class: 'guest-search' }, searchBox, el('button', { type: 'submit', class: 'primary-btn' }, 'Найти')),
        results,
        el('form', { class: 'guest-text' }, textBox, el('button', { type: 'submit', class: 'ghost-btn' }, 'Заказать')),
        status);

    guestView.replaceChildren(
        el('p', { class: 'guest-label' }, ico('note'), 'Заказ песни'),
        title, closedNote, form,
        el('h2', {}, 'Ваши заказы'), mineList);

    const setStatus = (text, isError = false) => {
        status.textContent = text;
        status.classList.toggle('error', isError);
    };

    function renderMine() {
        const labels = { new: ['clock', 'ждёт'], accepted: ['check', 'принят'], rejected: ['close', 'не в этот раз'] };
        mineList.replaceChildren(...(mine.length
            ? mine.sort((a, b) => b.createdAt - a.createdAt).map(r =>
                el('li', { class: `guest-req ${r.status}` }, el('span', {}, r.name), el('span', { class: 'guest-req-status' }, ...(labels[r.status] ? [ico(labels[r.status][0]), labels[r.status][1]] : [r.status]))))
            : [el('li', { class: 'requests-empty' }, 'Пока нет — закажите что-нибудь!')]));
    }

    async function submit(track) {
        if (!pub || !pub.requestsOpen) return setStatus('Приём заказов закрыт', true);
        if (mine.filter(r => r.status === 'new').length >= REQUESTS_PER_GUEST) {
            return setStatus(`Не больше ${REQUESTS_PER_GUEST} заказов в ожидании — дождитесь, пока организатор их рассмотрит`, true);
        }
        try {
            await fb.addDoc(fb.collection(fb.db, "requests"), {
                eventId, ownerUid: pub.ownerUid, guestUid,
                guestName: nameInput.value.trim().slice(0, 40),
                name: track.name.slice(0, 200),
                artist_name: (track.artist_name || '').slice(0, 100),
                videoId: track.videoId || '',
                createdAt: Date.now(),
                status: 'new'
            });
            setStatus(`✓ Заказ «${track.name}» отправлен`);
            return true;
        } catch (error) {
            console.error("Не удалось отправить заказ:", error);
            setStatus('Не получилось отправить — возможно, приём заказов закрыт', true);
            return false;
        }
    }

    form.querySelector('.guest-search').addEventListener('submit', async (e) => {
        e.preventDefault();
        const q = searchBox.value.trim();
        if (!q) return;
        results.replaceChildren(el('p', { class: 'requests-empty' }, 'Ищем…'));
        try {
            const data = await (await fetch(youtubeSearchUrl(q))).json();
            if (data.error) throw new Error(data.error.message);
            const tracks = youtubeItemsToTracks(data.items);
            results.replaceChildren(...(tracks.length ? tracks.map(t =>
                el('div', { class: 'guest-result' },
                    el('span', { class: 'request-info' }, el('strong', {}, t.name), el('span', {}, t.artist_name)),
                    el('button', { class: 'primary-btn', dataset: { videoId: t.id } }, 'Заказать')))
                : [el('p', { class: 'requests-empty' }, 'Ничего не нашлось — напишите название ниже')]));
            results._tracks = tracks;
        } catch (error) {
            console.error("Поиск гостя:", error);
            results.replaceChildren(el('p', { class: 'requests-empty' }, 'Поиск сейчас не работает — напишите название ниже'));
        }
    });

    results.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-video-id]');
        if (!btn) return;
        const track = (results._tracks || []).find(t => t.id === btn.dataset.videoId);
        btn.disabled = true;
        if (await submit({ name: track.name, artist_name: track.artist_name, videoId: track.id })) btn.innerHTML = ICONS.check;
        else btn.disabled = false;
    });

    form.querySelector('.guest-text').addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = textBox.value.trim();
        if (!name) return;
        if (await submit({ name })) textBox.value = '';
    });

    // Открыт ли приём и название — живьём: организатор может закрыть приём в любой момент
    fb.onSnapshot(fb.doc(fb.db, "public_events", eventId), (snap) => {
        if (!snap.exists()) {
            guestView.replaceChildren(el('p', { class: 'status' }, 'Ссылка недействительна или мероприятие удалено.'));
            return;
        }
        pub = snap.data();
        title.textContent = pub.title;
        closedNote.classList.toggle('hidden', pub.requestsOpen);
        form.classList.toggle('hidden', !pub.requestsOpen);
    }, () => guestView.replaceChildren(el('p', { class: 'status' }, 'Ссылка недействительна.')));

    fb.onSnapshot(fb.query(fb.collection(fb.db, "requests"),
        fb.where("guestUid", "==", guestUid), fb.where("eventId", "==", eventId)), (snap) => {
        mine = snap.docs.map(d => d.data());
        renderMine();
    });
    renderMine();
}

if (GUEST_EVENT_ID) startGuestPage(GUEST_EVENT_ID);

// --- 16. ИГРЫ: «ЗАМРИ», «УГАДАЙ МЕЛОДИЮ», МУЗЫКАЛЬНОЕ БИНГО ---
// Игра — режим блока сценария (block.game). Блок с игрой запускается на пульте
// ведущего, а игра перехватывает события плеера: ставит паузы, режет треки на
// отрывки и решает, что играть дальше.
const GAMES = {
    '': { icon: 'note', label: 'Без игры', hint: '' },
    freeze: { icon: 'freeze', label: 'Игра «Замри»', hint: 'Музыка остановится в случайный момент — кто пошевелился, выбывает. Продолжить — кнопкой «Музыка!».' },
    quiz: { icon: 'quiz', label: 'Угадай мелодию', hint: 'Треки в случайном порядке по 15 секунд, название и видео скрыты до ответа. На пульте — очки команд.' },
    bingo: { icon: 'bingo', label: 'Музыкальное бинго', hint: 'Песни в случайном порядке по 30 секунд. Гости отмечают их на карточках — на телефоне по QR или распечатанных. Нужно от 9 песен.' }
};
const FREEZE_MIN_SEC = 8;
const FREEZE_MAX_SEC = 25;
const QUIZ_CLIP_SEC = 15;
const BINGO_CLIP_SEC = 30;

let activeGame = null; // { type, eventId, blockId, ... } — идущая игра
let gameTimer = null;

const showGame = document.getElementById('show-game');
const freezeOverlay = document.getElementById('freeze-overlay');
const showVideo = document.getElementById('show-video');

function shuffled(list) {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function clearGameTimer() {
    clearTimeout(gameTimer);
    gameTimer = null;
}

function stopGame() {
    clearGameTimer();
    activeGame = null;
    freezeOverlay.classList.add('hidden');
    showVideo.classList.remove('masked');
    showGame.replaceChildren();
}

function startGame(ev, block, trackIndex = 0) {
    const base = { eventId: ev.id, blockId: block.id };
    const copies = block.tracks.map(t => ({ ...t }));
    const blockRef = { eventId: ev.id, blockId: block.id };

    if (block.game === 'freeze') {
        startList(trackIndex, copies, false, { loop: true, block: blockRef });
        activeGame = { ...base, type: 'freeze', frozen: false };
    } else if (block.game === 'quiz') {
        startList(0, shuffled(copies), false, { loop: false, block: blockRef });
        activeGame = { ...base, type: 'quiz', revealed: false, clipDone: false, extended: false, teams: loadTeams(ev.id) };
    } else if (block.game === 'bingo') {
        startList(0, shuffled(copies), false, { loop: false, block: blockRef });
        activeGame = { ...base, type: 'bingo', played: [], finished: false };
        publishBingo(ev, block);
    }
    renderShowNow();
}

// --- Хуки плеера ---
function gameOnPlaying() {
    if (!activeGame || gameTimer) return;
    // Музыку после «Замри» включили не кнопкой «Музыка!» (с наушников, экрана
    // блокировки) — снимаем заставку и заводим следующую паузу, иначе игра встанет
    if (activeGame.type === 'freeze' && activeGame.frozen) {
        activeGame.frozen = false;
        freezeOverlay.classList.add('hidden');
    }
    if (activeGame.type === 'freeze' && !activeGame.frozen) {
        const sec = FREEZE_MIN_SEC + Math.random() * (FREEZE_MAX_SEC - FREEZE_MIN_SEC);
        gameTimer = setTimeout(freezeNow, sec * 1000);
    } else if (activeGame.type === 'quiz' && !activeGame.clipDone && !activeGame.extended) {
        gameTimer = setTimeout(quizClipEnd, QUIZ_CLIP_SEC * 1000);
    } else if (activeGame.type === 'bingo') {
        const track = activeQueue[activeQueueIndex];
        if (track && !activeGame.played.includes(track)) activeGame.played.push(track);
        gameTimer = setTimeout(bingoNext, BINGO_CLIP_SEC * 1000);
        renderGame();
    }
}

// Пауза ведущим (или самой игрой) — таймер отрезка заводится заново при продолжении
function gameOnPaused() {
    clearGameTimer();
}

// true — игра сама решила, что делать после конца трека
function gameOnEnded() {
    if (!activeGame) return false;
    if (activeGame.type === 'quiz') {
        clearGameTimer();
        activeGame.clipDone = true;
        renderGame();
        return true;
    }
    if (activeGame.type === 'bingo') {
        bingoNext();
        return true;
    }
    return false; // «Замри» играет блок по кругу как обычно
}

// --- «Замри» ---
function freezeNow() {
    clearGameTimer();
    if (!activeGame || activeGame.type !== 'freeze') return;
    activeGame.frozen = true;
    playerPause();
    freezeOverlay.classList.remove('hidden');
}

function freezeResume() {
    if (!activeGame || activeGame.type !== 'freeze') return;
    activeGame.frozen = false;
    freezeOverlay.classList.add('hidden');
    playerPlay(); // событие «играет» заведёт следующую случайную паузу
}

freezeOverlay.addEventListener('click', (e) => {
    if (e.target.closest('[data-game="resume"]')) freezeResume();
});

// --- «Угадай мелодию» ---
function loadTeams(eventId) {
    try {
        const saved = JSON.parse(localStorage.getItem(`quiz-teams:${eventId}`));
        if (Array.isArray(saved) && saved.length) return saved;
    } catch { /* нет сохранённых */ }
    return [{ name: 'Команда 1', score: 0 }, { name: 'Команда 2', score: 0 }];
}

function saveTeams() {
    if (!activeGame || !activeGame.teams) return;
    try { localStorage.setItem(`quiz-teams:${activeGame.eventId}`, JSON.stringify(activeGame.teams)); } catch { /* не критично */ }
}

function quizClipEnd() {
    clearGameTimer();
    if (!activeGame || activeGame.type !== 'quiz') return;
    activeGame.clipDone = true;
    fadeOutThen(() => playerPause(), 600);
    renderGame();
}

function quizNext() {
    if (!activeGame || activeGame.type !== 'quiz') return;
    const next = activeQueueIndex + 1;
    if (next >= activeQueue.length) {
        playerPause();
        activeGame.finished = true;
        activeGame.revealed = true;
        renderShowNow('Раунд окончен');
        return;
    }
    Object.assign(activeGame, { revealed: false, clipDone: false, extended: false });
    clearGameTimer();
    fadeOutThen(() => playFromList(next, activeQueue, false), 400);
}

// --- Музыкальное бинго ---
// Название песни для карточки: без «(Official Video)», «[HD]», «ft. …» и т. п.
function cleanTitle(name) {
    return name
        .replace(/[(\[][^)\]]*[)\]]/g, '')
        // Границы слова — через классы букв Unicode: \b в JS понимает только латиницу,
        // и «клип»/«премьера» с ним никогда не совпадали
        .replace(/(^|[^\p{L}\p{N}])(official|video|audio|lyrics?|hd|4k|remaster(ed)?|клип|премьера)(?=$|[^\p{L}\p{N}]).*$/iu, '$1')
        .replace(/\s+(ft\.?|feat\.?)\s.*$/i, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/[\s\-–—|:]+$/, '')
        .trim() || name;
}

function bingoUrl(eventId) {
    return `${location.origin}/?bingo=${encodeURIComponent(eventId)}`;
}

function bingoTitles(block) {
    return [...new Set(block.tracks.map(t => cleanTitle(t.name)))];
}

// Карточка: 4×4 при 16+ песнях, иначе 3×3
function bingoSize(count) {
    return count >= 16 ? 4 : 3;
}

function makeBingoCard(titles, size) {
    return shuffled(titles).slice(0, size * size);
}

// Публикуем названия песен в public_events — по ним телефоны гостей собирают карточки
async function publishBingo(ev, block) {
    const titles = bingoTitles(block);
    if (titles.length < 9) {
        alert(`Для бинго нужно минимум 9 разных песен в блоке, сейчас ${titles.length}.`);
        return false;
    }
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const bingo = { titles: titles.slice(0, 100), size: bingoSize(titles.length), round: Date.now(), blockTitle: block.title };
        // Приём заказов берём из базы: publicEvent мог ещё не загрузиться, и запуск
        // бинго тогда молча закрыл бы гостям заказ песен
        const current = await readPublicEvent(fb, ev.id);
        const data = {
            ownerUid: fb.getCurrentUser().uid,
            title: ev.title,
            requestsOpen: !!(current && current.requestsOpen),
            updatedAt: Date.now(),
            bingo
        };
        await fb.setDoc(fb.doc(fb.db, "public_events", ev.id), data);
        if (currentEvent === ev) publicEvent = data;
        return true;
    } catch (error) {
        console.error("Не удалось опубликовать бинго:", error);
        alert("Не удалось подготовить карточки для телефонов (нужна сеть).");
        return false;
    }
}

function bingoNext() {
    clearGameTimer();
    if (!activeGame || activeGame.type !== 'bingo') return;
    const next = activeQueueIndex + 1;
    if (next >= activeQueue.length) {
        activeGame.finished = true;
        fadeOutThen(() => playerPause());
        renderShowNow('Все песни сыграны');
        return;
    }
    fadeOutThen(() => playFromList(next, activeQueue, false), 800);
}

// Печать карточек: отдельная область, видимая только при печати
function printBingoCards(block) {
    const titles = bingoTitles(block);
    if (titles.length < 9) {
        alert(`Для бинго нужно минимум 9 разных песен в блоке, сейчас ${titles.length}.`);
        return;
    }
    const countText = prompt('Сколько карточек напечатать?', '20');
    const count = Math.min(200, Math.max(1, parseInt(countText, 10) || 0));
    if (!countText || !count) return;
    const size = bingoSize(titles.length);
    const printArea = document.getElementById('print-area');
    printArea.replaceChildren(...Array.from({ length: count }, (_, n) =>
        el('div', { class: 'bingo-print-card' },
            el('div', { class: 'bingo-print-head' },
                el('strong', {}, `Музыкальное бинго · ${currentEvent.title}`),
                el('span', {}, `№ ${n + 1}`)),
            el('div', { class: `bingo-grid size-${size}` },
                ...makeBingoCard(titles, size).map(t => el('div', { class: 'bingo-cell' }, t))))));
    window.print();
}

// --- Панель игры на пульте ---
function renderGame() {
    if (!activeGame || !showMode.classList.contains('open')) {
        showGame.replaceChildren();
        showVideo.classList.remove('masked');
        return;
    }
    // Не мешаем вводу названия команды
    if (showGame.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
    const g = activeGame;
    const total = activeQueue ? activeQueue.length : 0;
    showVideo.classList.toggle('masked', g.type === 'quiz' && !g.revealed);

    if (g.type === 'freeze') {
        showGame.replaceChildren(
            el('p', { class: 'game-hint' }, `«Замри»: музыка встанет через ${FREEZE_MIN_SEC}–${FREEZE_MAX_SEC} секунд`),
            el('button', { class: 'game-btn', dataset: { game: 'freeze-now' } }, ico('freeze'), 'Замри сейчас'));
    } else if (g.type === 'quiz') {
        const track = activeQueue[activeQueueIndex];
        showGame.replaceChildren(
            el('div', { class: 'game-row' },
                el('span', { class: 'game-hint' }, g.finished ? 'Раунд окончен' : `Трек ${activeQueueIndex + 1} из ${total}` + (g.clipDone ? ' · отрывок закончился' : '')),
                g.revealed && track ? el('strong', { class: 'quiz-answer' }, `${track.name}`) : null),
            el('div', { class: 'game-row' },
                el('button', { class: 'game-btn', dataset: { game: 'quiz-more' }, disabled: g.finished }, ico('play'), 'Дольше'),
                el('button', { class: 'game-btn', dataset: { game: 'quiz-reveal' }, disabled: g.revealed }, ico('eye'), 'Ответ'),
                el('button', { class: 'game-btn primary', dataset: { game: 'quiz-next' }, disabled: g.finished }, 'Следующий', ico('skip'))),
            el('div', { class: 'quiz-teams' },
                ...g.teams.map((team, i) => el('div', { class: 'quiz-team' },
                    el('input', { value: team.name, dataset: { team: i }, 'aria-label': 'Название команды' }),
                    el('button', { class: 'game-btn small', dataset: { game: 'score-minus', team: i } }, '−'),
                    el('strong', { class: 'quiz-score' }, String(team.score)),
                    el('button', { class: 'game-btn small primary', dataset: { game: 'score-plus', team: i } }, '+1'))),
                el('button', { class: 'game-btn small', dataset: { game: 'team-add' } }, ico('plus'), 'Команда')));
    } else if (g.type === 'bingo') {
        showGame.replaceChildren(
            el('div', { class: 'game-row' },
                el('span', { class: 'game-hint' }, g.finished ? 'Все песни сыграны' : `Сыграно ${g.played.length} из ${total}`),
                el('button', { class: 'game-btn', dataset: { game: 'bingo-qr' } }, ico('qr'), 'QR карточек'),
                el('button', { class: 'game-btn primary', dataset: { game: 'bingo-next' }, disabled: g.finished }, 'Дальше', ico('skip'))),
            el('ol', { class: 'bingo-played', reversed: true },
                ...[...g.played].reverse().map(t => el('li', {}, cleanTitle(t.name)))));
    }
}

showGame.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-game]');
    if (!btn || !activeGame) return;
    const g = activeGame;
    const team = g.teams && g.teams[Number(btn.dataset.team)];
    switch (btn.dataset.game) {
        case 'freeze-now': freezeNow(); break;
        case 'quiz-more':
            g.extended = true;
            clearGameTimer();
            cancelFade(); // отрывок как раз затухал — не даём ему встать на паузу
            playerPlay();
            break;
        case 'quiz-reveal':
            g.revealed = true;
            renderShowNow();
            break;
        case 'quiz-next': quizNext(); break;
        case 'score-plus': team.score++; saveTeams(); renderGame(); break;
        case 'score-minus': team.score = Math.max(0, team.score - 1); saveTeams(); renderGame(); break;
        case 'team-add':
            g.teams.push({ name: `Команда ${g.teams.length + 1}`, score: 0 });
            saveTeams();
            renderGame();
            break;
        case 'bingo-qr': openQrFullscreen(bingoUrl(g.eventId), 'Карточка бинго'); break;
        case 'bingo-next': bingoNext(); break;
    }
});

showGame.addEventListener('change', (e) => {
    const i = e.target.dataset.team;
    if (i === undefined || !activeGame || !activeGame.teams) return;
    activeGame.teams[Number(i)].name = e.target.value.trim() || `Команда ${Number(i) + 1}`;
    saveTeams();
});

// --- Копия мероприятия: повторить удачный сценарий вместе с треками ---
async function duplicateEvent() {
    const src = currentEvent;
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const blocks = src.blocks.map(b => ({ ...b, id: newBlockId(), tracks: b.tracks.map(t => ({ ...t })) }));
        const data = { uid: fb.getCurrentUser().uid, title: `${src.title} (копия)`, type: src.type, date: '', blocks, createdAt: Date.now() };
        const ref = await fb.addDoc(fb.collection(fb.db, "events"), data);
        const ev = { id: ref.id, ...data };
        events.push(ev);
        openEvent(ev);
    } catch (error) {
        console.error("Не удалось сделать копию:", error);
        alert("Не удалось сделать копию мероприятия.");
    }
}

// --- Карточка бинго на телефоне гостя (?bingo=<id>) ---
async function startBingoPage(eventId) {
    document.body.classList.add('guest-mode');
    guestView.classList.remove('hidden');
    document.title = 'Музыкальное бинго';
    guestView.replaceChildren(el('p', { class: 'status' }, 'Загрузка…'));

    let fb;
    try {
        fb = await loadFirebase();
        await fb.authReady;
    } catch {
        guestView.replaceChildren(el('p', { class: 'status' }, 'Нет связи. Проверьте интернет и обновите страницу.'));
        return;
    }

    fb.onSnapshot(fb.doc(fb.db, "public_events", eventId), (snap) => {
        const pub = snap.exists() ? snap.data() : null;
        if (!pub || !pub.bingo) {
            guestView.replaceChildren(
                el('p', { class: 'guest-label' }, ico('bingo'), 'Музыкальное бинго'),
                el('p', { class: 'guest-closed' }, 'Бинго ещё не началось — откройте ссылку, когда ведущий объявит игру.'));
            return;
        }
        renderBingoCard(eventId, pub);
    }, () => guestView.replaceChildren(el('p', { class: 'status' }, 'Ссылка недействительна.')));
}

function renderBingoCard(eventId, pub) {
    const { titles, size, round } = pub.bingo;
    // Карточка и отметки живут на телефоне гостя; новый раунд — новая карточка
    const storeKey = `bingo:${eventId}:${round}`;
    let state;
    try { state = JSON.parse(localStorage.getItem(storeKey)); } catch { state = null; }
    if (!state || !Array.isArray(state.cells) || state.cells.length !== size * size) {
        state = { cells: makeBingoCard(titles, size), marked: [] };
    }
    const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch { /* приватный режим */ } };
    save();

    const hasLine = () => {
        const m = new Set(state.marked);
        const lines = [];
        for (let i = 0; i < size; i++) {
            lines.push([...Array(size)].map((_, j) => i * size + j));      // строка
            lines.push([...Array(size)].map((_, j) => j * size + i));      // столбец
        }
        lines.push([...Array(size)].map((_, j) => j * size + j));          // диагонали
        lines.push([...Array(size)].map((_, j) => j * size + (size - 1 - j)));
        return lines.some(line => line.every(c => m.has(c)));
    };

    const banner = el('p', { class: 'bingo-banner hidden' }, ico('star'), 'Бинго! Поднимите руку и покажите карточку ведущему');
    const grid = el('div', { class: `bingo-grid size-${size}` },
        ...state.cells.map((t, i) => el('button', { class: state.marked.includes(i) ? 'bingo-cell marked' : 'bingo-cell', dataset: { cell: i } }, t)));
    banner.classList.toggle('hidden', !hasLine());

    grid.addEventListener('click', (e) => {
        const cell = e.target.closest('[data-cell]');
        if (!cell) return;
        const i = Number(cell.dataset.cell);
        state.marked = state.marked.includes(i) ? state.marked.filter(x => x !== i) : [...state.marked, i];
        cell.classList.toggle('marked');
        save();
        banner.classList.toggle('hidden', !hasLine());
    });

    guestView.replaceChildren(
        el('p', { class: 'guest-label' }, ico('bingo'), 'Музыкальное бинго'),
        el('h1', {}, pub.title),
        el('p', { class: 'requests-hint' }, 'Отмечайте песни, которые прозвучали. Собрали линию — по горизонтали, вертикали или диагонали — кричите «Бинго!».'),
        grid, banner);
}

if (BINGO_EVENT_ID) startBingoPage(BINGO_EVENT_ID);
