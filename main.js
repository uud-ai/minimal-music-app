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
                { getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc, updateDoc },
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
                db, collection, addDoc, getDocs, query, where, deleteDoc, doc, updateDoc,
                auth, signOut, GoogleAuthProvider, linkWithPopup, signInWithPopup, signInWithCredential,
                EmailAuthProvider, linkWithCredential, signInWithEmailAndPassword, sendPasswordResetEmail,
                authReady,
                getCurrentUser: () => auth.currentUser || currentUser,
                onAuthChange: (fn) => authListeners.push(fn)
            };
        })();
    }
    return firebasePromise;
}

// Константы приложения
const YOUTUBE_API_KEY = "AIzaSyBgrlvnKuTsj4HSitEUT3Ae4yJLbNozfd8";
// Свои аудиофайлы лежат в Cloudflare R2, загрузка и отдача — через воркер (worker/index.js)
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

// Асинхронно загружаем скрипт YouTube IFrame API
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

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
// (source: 'file', audio — ссылка на файл в R2). Всё остальное приложение
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
    npPlayPause.textContent = '⏸️';
    startProgressLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updateShowPlayPause();
}

function onPlaybackPaused() {
    npPlayPause.textContent = '▶️';
    stopProgressLoop();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    updateShowPlayPause();
}

function onPlaybackEnded() {
    stopProgressLoop();
    npSeek.value = 0;
    npCurrent.textContent = '0:00';

    // Нон-стоп: сразу включаем следующий трек из того же списка
    if (!playNext()) {
        npPlayPause.textContent = '▶️';
        renderShowNow('Блок завершён');
    }
    updateShowPlayPause();
}

// Помечаем трек недоступным и без паузы переходим к следующему
function onPlaybackError() {
    const track = activeQueue && activeQueue[activeQueueIndex];
    if (track) {
        track.unavailable = true;
        if (activeQueue === currentTracks) {
            const card = trackList.querySelectorAll('.track-card')[activeQueueIndex];
            if (card) card.classList.add('unavailable');
        }
    }
    if (!playNext()) {
        stopProgressLoop();
        npPlayPause.textContent = '▶️';
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
    safe('nexttrack', () => playNext());
    safe('previoustrack', playPrevious);
}
setupMediaSession();

function updateMediaSession(name, artist) {
    if (!('mediaSession' in navigator)) return;
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: name || '',
            artist: artist || '',
            artwork: [
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

function startProgressLoop() {
    stopProgressLoop();
    progressInterval = setInterval(() => {
        if (isSeeking) return;
        const duration = playerDuration();
        const current = playerTime();
        if (duration > 0) {
            npSeek.value = (current / duration) * 100;
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
    if (npLike.textContent.trim() === '🗑️') {
        if (await handleDelete(npLike) === false) return; // отказались удалять файл
        npLike.textContent = '♡';
        currentPlayingIsLibrary = false;
        // Удалённый свой файл повторно «лайкнуть» нельзя — прячем кнопку
        if (npLike.dataset.source === 'file') npLike.classList.add('hidden');
    } else {
        handleLike(npLike);
    }
});

npSeek.addEventListener('input', () => {
    isSeeking = true;
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
        renderTracks(lastSearchTracks, false);
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

async function searchMusic(queryText) {
    trackList.innerHTML = '<p class="status">Ищем музыку на YouTube...</p>';
    loadMoreBtn.classList.add('hidden');
    lastSearchQuery = queryText;
    nextPageToken = null;

    const tracks = await fetchSearchPage(queryText, null);
    if (tracks === null) return; // ошибка уже отображена внутри fetchSearchPage

    lastSearchTracks = tracks;
    renderTracks(tracks, false);
    updateLoadMoreButton();
}

// Догружает следующую страницу результатов поиска и добавляет её к текущему списку
async function loadMoreTracks() {
    if (!nextPageToken || !lastSearchQuery) return;

    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Загрузка...';

    const moreTracks = await fetchSearchPage(lastSearchQuery, nextPageToken);

    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Ещё';

    if (moreTracks === null) return;

    const previousTracks = lastSearchTracks;
    lastSearchTracks = [...(lastSearchTracks || []), ...moreTracks];
    // Если сейчас играет поиск — догруженные треки тоже попадают в очередь нон-стоп
    if (activeQueue && activeQueue === previousTracks) activeQueue = lastSearchTracks;
    renderTracks(lastSearchTracks, false);
    updateLoadMoreButton();
}

// Запрашивает одну страницу результатов у YouTube Data API и обновляет nextPageToken
async function fetchSearchPage(queryText, pageToken) {
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${encodeURIComponent(queryText)}&type=video&videoCategoryId=10&videoEmbeddable=true&videoSyndicated=true&key=${YOUTUBE_API_KEY}`;
    if (pageToken) url += `&pageToken=${pageToken}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("Ошибка YouTube API:", data.error.message);
            trackList.innerHTML = '<p class="status">Ошибка API. Проверьте ключ.</p>';
            return null;
        }

        nextPageToken = data.nextPageToken || null;

        // Преобразуем данные YouTube в наш формат
        return data.items.map(item => ({
            id: item.id.videoId,
            name: item.snippet.title,
            artist_name: item.snippet.channelTitle,
            audio: item.id.videoId // В качестве "аудио" передаем ID видео
        }));
    } catch (error) {
        console.error("Ошибка сети:", error);
        trackList.innerHTML = '<p class="status">Ошибка сети. Проверьте подключение.</p>';
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

        const info = document.createElement('div');
        info.className = 'track-info';
        const nameEl = document.createElement('strong');
        nameEl.textContent = track.name;
        const artistEl = document.createElement('span');
        artistEl.textContent = track.artist_name;
        info.append(nameEl, artistEl);

        const actions = document.createElement('div');
        actions.className = 'actions';

        const playBtn = document.createElement('button');
        playBtn.className = 'play-btn';
        playBtn.textContent = '▶️';
        Object.assign(playBtn.dataset, {
            index: String(index),
            url: track.audio,
            name: track.name,
            artist: track.artist_name
        });

        // Пока выбираем треки для блока сценария — у каждого трека кнопка «＋»
        if (pickTarget) {
            const addBtn = document.createElement('button');
            addBtn.className = 'add-btn';
            addBtn.textContent = '＋';
            addBtn.setAttribute('aria-label', 'Добавить в блок');
            addBtn.dataset.index = String(index);
            actions.append(addBtn);
        }

        const likeBtn = document.createElement('button');
        likeBtn.className = 'like-btn';
        likeBtn.textContent = isLibrary ? '🗑️' : '♡';
        Object.assign(likeBtn.dataset, {
            id: track.id,
            url: track.audio,
            name: track.name,
            artist: track.artist_name,
            docid: track.docId || '',
            source: track.source || '',
            key: track.fileKey || ''
        });

        actions.append(playBtn, likeBtn);
        trackCard.append(info, actions);
        trackList.appendChild(trackCard);
    });
}

// --- 8. ДЕЛЕГИРОВАНИЕ СОБЫТИЙ ---
trackList.addEventListener('click', (e) => {
    const target = e.target;
    
    if (target.classList.contains('play-btn')) {
        startList(Number(target.dataset.index), currentTracks, currentIsLibrary);
    } else if (target.classList.contains('add-btn')) {
        addTrackToPickTarget(currentTracks[Number(target.dataset.index)], target);
    } else if (target.classList.contains('like-btn')) {
        const isLibrary = navLibrary.classList.contains('active');
        if (isLibrary) {
            handleDelete(target);
        } else {
            handleLike(target);
        }
    }
});

// --- 9. СОХРАНЕНИЕ В БИБЛИОТЕКУ (FIREBASE) ---
async function handleLike(btn) {
    const track = btn.dataset;
    btn.innerHTML = '⏳';

    try {
        const fb = await loadFirebase();
        await fb.authReady;
        // Записываем информацию о треке в Firestore, привязывая к текущему пользователю
        await fb.addDoc(fb.collection(fb.db, "liked_tracks"), {
            uid: fb.getCurrentUser().uid,
            trackId: track.id,
            name: track.name,
            artist: track.artist,
            audioUrl: track.url, // ID видео
            timestamp: Date.now()
        });

        btn.innerHTML = '❤️';
    } catch (error) {
        console.error("Ошибка сохранения:", error);
        btn.innerHTML = '❌';
    }
}

// «Моя музыка» = свои загруженные файлы сверху + лайкнутые треки YouTube
async function loadLibrary() {
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
                audio: data.audioUrl
            });
        });

        // Пока грузились, пользователь мог уйти на другую вкладку
        if (!navLibrary.classList.contains('active')) return;
        renderTracks([...files, ...tracks.reverse()], true);
    } catch (error) {
        console.error("Ошибка загрузки библиотеки:", error);
        trackList.innerHTML = '<p class="status">Не удалось загрузить библиотеку.</p>';
    }
}

async function handleDelete(btn) {
    const card = btn.closest('.track-card');
    const docId = btn.dataset.docid;

    // Файл удаляется из облака насовсем — переспрашиваем
    if (btn.dataset.source === 'file') {
        if (!confirm(`Удалить файл «${btn.dataset.name}» из облака? В блоках мероприятий он перестанет играть.`)) return false;
        if (card) card.remove();
        try {
            await filesApi(`/files/${encodeFileKey(btn.dataset.key)}`, { method: 'DELETE' });
            recentlyDeleted.add(btn.dataset.key);
        } catch (error) {
            console.error("Ошибка удаления файла:", error);
            alert("Не удалось удалить файл.");
        }
        return;
    }

    if (card) {
        card.remove();
        if (trackList.children.length === 0) {
            trackList.innerHTML = '<p class="status">Список пуст</p>';
        }
    }

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

// --- 9.1 СВОИ ФАЙЛЫ В ОБЛАКЕ (CLOUDFLARE R2) ---
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
            artist_name: `📁 Мой файл · ${formatSize(file.size)}`,
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
}

// Синхронизирует «сердечко» внизу с треком, который сейчас играет
function updateNowPlayingLikeButton(track, isLibrary) {
    currentPlayingIsLibrary = isLibrary;
    npLike.textContent = isLibrary ? '🗑️' : '♡';
    // Свой файл лайкать некуда — он и так в «Моей музыке»
    npLike.classList.toggle('hidden', track.source === 'file' && !isLibrary);
    Object.assign(npLike.dataset, {
        id: track.id,
        url: track.audio,
        name: track.name,
        artist: track.artist_name,
        docid: track.docId || '',
        source: track.source || '',
        key: track.fileKey || ''
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
    npSeek.value = 0;
    npCurrent.textContent = '0:00';
    npDuration.textContent = '0:00';
    audioWrapper.classList.remove('hidden');
    updateMediaSession(name, artist);
    renderShowNow();

    console.log("Играет:", name);
}

// --- 11. МЕРОПРИЯТИЯ И СЦЕНАРИЙ ---
// Мероприятие — документ в коллекции events: название, тип, дата и блоки сценария.
// Блок — отрезок вечера со своей музыкой: «фон» играет по кругу, «сигнал» — один раз
// (выход, награждение, гимн). Блок без треков — тишина (речи, тосты).
const EVENT_TYPES = {
    corporate: { label: 'Корпоратив', icon: '🥂', blocks: [
        ['Сбор гостей', true], ['Открытие', false], ['Награждение', false],
        ['Банкет', true], ['Танцы', true], ['Финал', false]
    ] },
    kids: { label: 'Детский праздник', icon: '🎈', blocks: [
        ['Встреча гостей', true], ['Выход аниматора', false], ['Игры', true],
        ['Торт и свечи', false], ['Дискотека', true], ['Прощание', false]
    ] },
    official: { label: 'Официальный приём', icon: '🎖️', blocks: [
        ['Сбор гостей', true], ['Гимн', false], ['Выход официальных лиц', false],
        ['Выступления', false], ['Фуршет', true], ['Завершение', false]
    ] },
    wedding: { label: 'Свадьба', icon: '💍', blocks: [
        ['Сбор гостей', true], ['Выход молодых', false], ['Банкет', true],
        ['Первый танец', false], ['Торт', false], ['Танцы', true]
    ] },
    other: { label: 'Другое', icon: '📅', blocks: [['Блок 1', true]] }
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
        button.textContent = `⬇ Скачиваем ${done + failed + 1} из ${files.length}…`;
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
        ...Object.entries(EVENT_TYPES).map(([value, info]) => el('option', { value }, `${info.icon} ${info.label}`)));

    const form = el('form', { class: 'event-create' },
        el('input', { name: 'title', type: 'text', placeholder: 'Название мероприятия', required: true }),
        el('div', { class: 'event-create-row' },
            typeSelect,
            el('input', { name: 'date', type: 'date' })),
        el('button', { type: 'submit', class: 'primary-btn' }, '＋ Создать по шаблону'));
    form.addEventListener('submit', (e) => {
        e.preventDefault();
        createEvent(form.elements.title.value.trim(), form.elements.type.value, form.elements.date.value);
    });

    const list = events.length === 0
        ? el('p', { class: 'status' }, 'Мероприятий пока нет')
        : el('div', {}, ...events.map(ev => {
            const info = eventTypeInfo(ev.type);
            return el('button', { class: 'event-card', dataset: { action: 'open-event', id: ev.id } },
                el('span', { class: 'event-icon' }, info.icon),
                el('span', { class: 'event-card-info' },
                    el('strong', {}, ev.title),
                    el('span', {}, `${formatEventDate(ev.date)} · ${info.label} · блоков: ${(ev.blocks || []).length}`)));
        }));

    eventsView.replaceChildren(form, list);
}

async function createEvent(title, type, date) {
    if (!title) return;
    const blocks = eventTypeInfo(type).blocks.map(([blockTitle, loop]) => ({
        id: newBlockId(), title: blockTitle, time: '', loop, tracks: []
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
    currentEvent = ev;
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
        el('button', { class: 'link-btn', dataset: { action: 'back' } }, '← Все мероприятия'),
        el('input', { class: 'event-title-input', value: ev.title, dataset: { field: 'title' } }),
        el('div', { class: 'event-meta' },
            el('span', {}, `${info.icon} ${info.label}`),
            el('input', { type: 'date', value: ev.date || '', dataset: { field: 'date' } })),
        el('div', { class: 'event-actions' },
            el('button', { class: 'primary-btn', dataset: { action: 'show' } }, '🎬 Режим ведущего'),
            el('button', { class: 'ghost-btn', dataset: { action: 'delete-event' } }, '🗑 Удалить')),
        el('button', { class: 'ghost-btn', dataset: { action: 'download' } }, '⬇ Скачать для офлайна'),
        offlineStatus,
        eventsOffline ? el('p', { class: 'offline-note' }, 'Нет сети — открыта скачанная копия, изменения не сохранятся') : null);
    renderOfflineStatus(ev, offlineStatus);

    const blocks = ev.blocks.map((block, i) => {
        const isPlaying = playingBlock && playingBlock.eventId === ev.id && playingBlock.blockId === block.id;
        const tracks = block.tracks.length === 0
            ? el('p', { class: 'block-empty' }, 'Без музыки — тишина')
            : el('ol', { class: 'block-tracks' }, ...block.tracks.map((track, t) =>
                el('li', {},
                    el('button', { class: 'mini-btn', dataset: { action: 'play-track', block: i, track: t }, 'aria-label': 'Играть' }, '▶'),
                    el('span', { class: 'block-track-name' }, track.source === 'file' ? `📁 ${track.name}` : track.name),
                    el('button', { class: 'mini-btn', dataset: { action: 'remove-track', block: i, track: t }, 'aria-label': 'Убрать' }, '✕'))));

        return el('div', { class: isPlaying ? 'block-card playing' : 'block-card' },
            el('div', { class: 'block-row' },
                el('input', { type: 'time', value: block.time || '', dataset: { field: 'time', block: i } }),
                el('input', { class: 'block-title-input', value: block.title, dataset: { field: 'block-title', block: i } }),
                el('button', { class: 'play-btn', dataset: { action: 'play-block', block: i }, 'aria-label': 'Запустить блок' }, '▶️')),
            el('div', { class: 'block-row block-tools' },
                el('select', { dataset: { field: 'loop', block: i } },
                    el('option', { value: 'loop', selected: block.loop }, '🔁 Фон по кругу'),
                    el('option', { value: 'once', selected: !block.loop }, '🎺 Сигнал, один раз')),
                el('button', { class: 'mini-btn', dataset: { action: 'move-up', block: i }, disabled: i === 0, 'aria-label': 'Выше' }, '↑'),
                el('button', { class: 'mini-btn', dataset: { action: 'move-down', block: i }, disabled: i === ev.blocks.length - 1, 'aria-label': 'Ниже' }, '↓'),
                el('button', { class: 'mini-btn', dataset: { action: 'remove-block', block: i }, 'aria-label': 'Удалить блок' }, '🗑')),
            tracks,
            el('button', { class: 'link-btn', dataset: { action: 'pick', block: i } }, '＋ Добавить трек'));
    });

    eventsView.replaceChildren(header, ...blocks,
        el('button', { class: 'ghost-btn add-block-btn', dataset: { action: 'add-block' } }, '＋ Добавить блок'));
}

eventsView.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const { action } = target.dataset;
    const blockIndex = Number(target.dataset.block);
    const block = currentEvent && currentEvent.blocks[blockIndex];

    switch (action) {
        case 'open-event':
            openEvent(events.find(ev => ev.id === target.dataset.id));
            break;
        case 'back':
            loadEvents();
            break;
        case 'show':
            openShowMode();
            break;
        case 'download':
            downloadEventForOffline(target);
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
    saveEvent();
});

async function deleteEvent() {
    const id = currentEvent.id;
    try {
        const fb = await loadFirebase();
        await fb.deleteDoc(fb.doc(fb.db, "events", id));
        removeOfflineEvent(id);
        if (playingBlock && playingBlock.eventId === id) playingBlock = null;
        loadEvents();
    } catch (error) {
        console.error("Ошибка удаления мероприятия:", error);
        alert("Не удалось удалить мероприятие.");
    }
}

// Плашка «Добавляете в блок …» над поиском/библиотекой, пока выбираем треки
function renderPickBanner(view) {
    const block = pickTarget && currentEvent && currentEvent.blocks.find(b => b.id === pickTarget.blockId);
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
    const block = pickTarget && currentEvent && currentEvent.blocks.find(b => b.id === pickTarget.blockId);
    if (!block || !track) return;
    block.tracks.push({
        id: track.id, name: track.name, artist_name: track.artist_name, audio: track.audio,
        // undefined Firestore не примет — поле source пишем только у своих файлов
        ...(track.source === 'file' ? { source: 'file', fileKey: track.fileKey } : {})
    });
    saveEvent();
    btn.textContent = '✓';
    btn.disabled = true;
    renderPickBanner('search');
}

// Плавно уводит громкость в ноль, затем вызывает callback (смена блока без обрыва звука)
function fadeOutThen(callback, ms = 1200) {
    if (!playerIsPlaying()) {
        callback();
        return;
    }
    const steps = 12;
    const startVolume = playerGetVolume();
    const fadingSource = currentSource;
    let step = 0;
    const timer = setInterval(() => {
        step++;
        playerSetVolume(Math.round(startVolume * (1 - step / steps)));
        if (step >= steps) {
            clearInterval(timer);
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

    fadeOutThen(() => {
        if (block.tracks.length === 0) {
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
    clockTimer = setInterval(updateClock, 1000);
    requestWakeLock();
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
        wakeLock = await navigator.wakeLock.request('screen');
    } catch (error) {
        console.warn("Не удалось запретить гашение экрана:", error);
    }
}

// Wake Lock снимается, когда вкладка уходит в фон — возвращаем его
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && showMode.classList.contains('open')) requestWakeLock();
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
    showTrackTitle.textContent = status || (block && track ? track.name : '');
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
                    block.tracks.length === 0 ? '🤫' : (block.loop ? '🔁' : '🎺'))))));
    const currentEl = showBlocks.querySelector('.current');
    if (currentEl) currentEl.scrollIntoView({ block: 'nearest' });
}

function updateShowPlayPause() {
    showPlayPause.textContent = playerIsPlaying() ? '⏸ Пауза' : '▶ Играть';
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
    const close = el('button', { class: 'sheet-close', 'aria-label': 'Закрыть', dataset: { action: 'close' } }, '✕');
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
            await fb.signOut(fb.auth); // onAuthStateChanged сам создаст новую анонимную сессию
            await new Promise(resolve => fb.onAuthChange(resolve));
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
