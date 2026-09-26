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
                { getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc },
                { getAuth, signInAnonymously, onAuthStateChanged }
            ] = await Promise.all([
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js"),
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js"),
                import("https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js")
            ]);

            const app = initializeApp(firebaseConfig);
            const db = getFirestore(app);
            const auth = getAuth(app);

            // Библиотека привязывается к uid устройства, чтобы каждый пользователь видел только свои треки
            let currentUser = null;
            const authReady = new Promise((resolve) => {
                onAuthStateChanged(auth, (user) => {
                    if (user) {
                        currentUser = user;
                        resolve(user);
                    }
                });
                signInAnonymously(auth).catch((error) => {
                    console.error("Ошибка анонимного входа:", error);
                });
            });

            return {
                db, collection, addDoc, getDocs, query, where, deleteDoc, doc,
                authReady,
                getCurrentUser: () => currentUser
            };
        })();
    }
    return firebasePromise;
}

// Константы приложения
const YOUTUBE_API_KEY = "AIzaSyBgrlvnKuTsj4HSitEUT3Ae4yJLbNozfd8";

const searchInput = document.getElementById('search-input');
const trackList = document.getElementById('track-list');
const navSearch = document.getElementById('nav-search');
const navLibrary = document.getElementById('nav-library');

const loadMoreBtn = document.getElementById('load-more-btn');

const audioWrapper = document.getElementById('audio-wrapper');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npPlayPause = document.getElementById('np-playpause');
const npLike = document.getElementById('np-like');
const npSeek = document.getElementById('np-seek');
const npCurrent = document.getElementById('np-current');
const npDuration = document.getElementById('np-duration');

// --- 3. ЗАГРУЗКА YOUTUBE ПЛЕЕРА ---
let ytPlayer;
let progressInterval = null;
let isSeeking = false;

// Очередь нон-стоп воспроизведения (заполняется только при проигрывании из «Моя музыка»)
let currentTracks = [];
let currentIsLibrary = false;
let activeQueue = null;
let activeQueueIndex = -1;
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
        // 1x1, а не 0x0 — начиная с 2020-х YouTube считает нулевой по размеру
        // плеер невидимым и отказывается автозапускать в нём видео
        height: '1',
        width: '1',
        videoId: '',
        playerVars: {
            'autoplay': 0,
            'controls': 0,
            'playsinline': 1 // Важно для работы на смартфонах
        },
        events: {
            'onStateChange': onPlayerStateChange
        }
    });
};

function onPlayerStateChange(event) {
    if (event.data === YT.PlayerState.PLAYING) {
        // Плеер запускался приглушённым, чтобы обойти блокировку автовоспроизведения
        // со звуком в браузере — как только видео реально заиграло, возвращаем звук
        if (ytPlayer.isMuted && ytPlayer.isMuted()) {
            ytPlayer.unMute();
        }
        npPlayPause.textContent = '⏸️';
        startProgressLoop();
    } else if (event.data === YT.PlayerState.PAUSED) {
        npPlayPause.textContent = '▶️';
        stopProgressLoop();
    } else if (event.data === YT.PlayerState.ENDED) {
        npPlayPause.textContent = '▶️';
        stopProgressLoop();
        npSeek.value = 0;
        npCurrent.textContent = '0:00';

        // Нон-стоп: если трек играл из очереди «Моя музыка», включаем следующий (по кругу)
        if (activeQueue && activeQueue.length > 0) {
            const nextIndex = (activeQueueIndex + 1) % activeQueue.length;
            playFromList(nextIndex, activeQueue, true);
        }
    }
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
        if (!ytPlayer || isSeeking) return;
        const duration = ytPlayer.getDuration();
        const current = ytPlayer.getCurrentTime();
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
    if (!ytPlayer || !ytPlayer.getPlayerState) return;
    if (ytPlayer.getPlayerState() === YT.PlayerState.PLAYING) {
        ytPlayer.pauseVideo();
    } else {
        ytPlayer.playVideo();
    }
});

// «Сердечко» рядом с play/pause — лайк/удаление текущего играющего трека
npLike.addEventListener('click', () => {
    if (npLike.textContent.trim() === '🗑️') {
        handleDelete(npLike);
        npLike.textContent = '♡';
        currentPlayingIsLibrary = false;
    } else {
        handleLike(npLike);
    }
});

npSeek.addEventListener('input', () => {
    isSeeking = true;
    const duration = ytPlayer.getDuration();
    npCurrent.textContent = formatTime((npSeek.value / 100) * duration);
});

npSeek.addEventListener('change', () => {
    if (!ytPlayer) return;
    const duration = ytPlayer.getDuration();
    ytPlayer.seekTo((npSeek.value / 100) * duration, true);
    isSeeking = false;
});

// --- 5. ЛОГИКА НАВИГАЦИИ ---
navSearch.addEventListener('click', () => {
    navSearch.classList.add('active');
    navLibrary.classList.remove('active');
    if (lastSearchTracks) {
        renderTracks(lastSearchTracks, false);
        updateLoadMoreButton();
    } else {
        trackList.innerHTML = '<p class="status">Введите название песни для поиска</p>';
    }
});

navLibrary.addEventListener('click', async () => {
    navLibrary.classList.add('active');
    navSearch.classList.remove('active');
    loadMoreBtn.classList.add('hidden');
    loadLibrary();
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

    lastSearchTracks = [...(lastSearchTracks || []), ...moreTracks];
    renderTracks(lastSearchTracks, false);
    updateLoadMoreButton();
}

// Запрашивает одну страницу результатов у YouTube Data API и обновляет nextPageToken
async function fetchSearchPage(queryText, pageToken) {
    let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${encodeURIComponent(queryText)}&type=video&videoCategoryId=10&key=${YOUTUBE_API_KEY}`;
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
        trackCard.className = 'track-card';

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

        const likeBtn = document.createElement('button');
        likeBtn.className = 'like-btn';
        likeBtn.textContent = isLibrary ? '🗑️' : '♡';
        Object.assign(likeBtn.dataset, {
            id: track.id,
            url: track.audio,
            name: track.name,
            artist: track.artist_name,
            docid: track.docId || ''
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
        playFromList(Number(target.dataset.index), currentTracks, currentIsLibrary);
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

async function loadLibrary() {
    trackList.innerHTML = '<p class="status">Загружаем вашу библиотеку...</p>';
    try {
        const fb = await loadFirebase();
        await fb.authReady;
        const q = fb.query(fb.collection(fb.db, "liked_tracks"), fb.where("uid", "==", fb.getCurrentUser().uid));
        const querySnapshot = await fb.getDocs(q);
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

        renderTracks(tracks.reverse(), true);
    } catch (error) {
        console.error("Ошибка загрузки библиотеки:", error);
        trackList.innerHTML = '<p class="status">Не удалось загрузить библиотеку.</p>';
    }
}

async function handleDelete(btn) {
    const card = btn.closest('.track-card');
    const docId = btn.dataset.docid;

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

// --- 10. ВОСПРОИЗВЕДЕНИЕ ЧЕРЕЗ YOUTUBE ПЛЕЕР ---
function playFromList(index, tracks, isLibrary) {
    const track = tracks[index];
    if (!track) return;

    // Очередь нон-стоп заводим только для «Моя музыка»; из поиска играет один трек
    activeQueue = isLibrary ? tracks : null;
    activeQueueIndex = index;

    updateNowPlayingLikeButton(track, isLibrary);
    playMusic(track.audio, track.name, track.artist_name);
}

// Синхронизирует «сердечко» внизу с треком, который сейчас играет
function updateNowPlayingLikeButton(track, isLibrary) {
    currentPlayingIsLibrary = isLibrary;
    npLike.textContent = isLibrary ? '🗑️' : '♡';
    Object.assign(npLike.dataset, {
        id: track.id,
        url: track.audio,
        name: track.name,
        artist: track.artist_name,
        docid: track.docId || ''
    });
}

function playMusic(videoId, name, artist) {
    if (ytPlayer && ytPlayer.loadVideoById) {
        // Запускаем приглушённым: браузеры блокируют автовоспроизведение со звуком,
        // если клик пришёл не напрямую в iframe плеера, а приглушённое всегда разрешено.
        // Звук возвращаем в onPlayerStateChange, как только видео реально заиграло.
        ytPlayer.mute();
        ytPlayer.loadVideoById(videoId);

        npTitle.textContent = name || '—';
        npArtist.textContent = artist || '';
        npSeek.value = 0;
        npCurrent.textContent = '0:00';
        npDuration.textContent = '0:00';
        audioWrapper.classList.remove('hidden');

        console.log("Играет трек ID:", videoId);
    } else {
        console.warn("Плеер YouTube еще не загрузился.");
    }
}