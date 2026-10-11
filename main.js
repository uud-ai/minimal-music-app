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

// --- 2. КОНФИГУРАЦИЯ FIREBASE И SOUNDCLOUD ---
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

// SoundCloud напрямую из браузера недоступен (не отдаёт CORS сторонним доменам),
// поэтому поиск и резолв ссылок на аудио идут через свой прокси-воркер на Cloudflare.
const SOUNDCLOUD_PROXY = "https://minimal-music-soundcloud-proxy.uudnik.workers.dev";

const searchInput = document.getElementById('search-input');
const trackList = document.getElementById('track-list');
const navSearch = document.getElementById('nav-search');
const navLibrary = document.getElementById('nav-library');

const loadMoreBtn = document.getElementById('load-more-btn');

const audioWrapper = document.getElementById('audio-wrapper');
const audioPlayer = document.getElementById('audio-player');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npPlayPause = document.getElementById('np-playpause');
const npLike = document.getElementById('np-like');
const npSeek = document.getElementById('np-seek');
const npCurrent = document.getElementById('np-current');
const npDuration = document.getElementById('np-duration');

let isSeeking = false;

// Очередь нон-стоп воспроизведения (заполняется только при проигрывании из «Моя музыка»)
let currentTracks = [];
let currentIsLibrary = false;
let activeQueue = null;
let activeQueueIndex = -1;
let currentPlayingIsLibrary = false;

// Трек, который сейчас загружен в плеер (нужен для повторного резолва при ошибке)
let currentTrack = null;
let retriedCurrent = false;

// Заранее полученная ссылка на следующий трек очереди. При погашенном экране
// нельзя ждать сеть в момент окончания трека: пока ничего не играет, ОС
// усыпляет страницу, и play() без нажатия пользователя браузер блокирует.
// Поэтому ссылку резолвим за ~30 сек до конца, а на 'ended' лишь подставляем
// готовый src и сразу (синхронно) вызываем play().
let prefetched = null;        // { resolveUrl, url, at }
let prefetchInFlight = null;  // resolveUrl, который сейчас резолвится
const PREFETCH_BEFORE_END = 30;          // сек до конца трека
const PREFETCH_TTL = 4 * 60 * 1000;      // подписанные ссылки короткоживущие
const EARLY_SWITCH_SEC = 0.6;            // переключение без паузы (для iOS)
let earlySwitched = false;               // уже переключились досрочно на этом треке

// Последние результаты поиска — чтобы не терять их при переходе на вкладку «Моя музыка» и обратно
let lastSearchTracks = null;
let lastSearchQuery = '';
let nextPageHref = null;

// --- 3. СОБЫТИЯ АУДИОПЛЕЕРА ---
audioPlayer.addEventListener('play', () => {
    npPlayPause.textContent = '⏸️';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
});

audioPlayer.addEventListener('pause', () => {
    npPlayPause.textContent = '▶️';
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
});

audioPlayer.addEventListener('timeupdate', () => {
    maybePrefetchNext();
    if (isSeeking) return;
    const duration = audioPlayer.duration;
    if (duration > 0) {
        npSeek.value = (audioPlayer.currentTime / duration) * 100;
        npDuration.textContent = formatTime(duration);
    }
    npCurrent.textContent = formatTime(audioPlayer.currentTime);
});

audioPlayer.addEventListener('ended', () => {
    npPlayPause.textContent = '▶️';
    npSeek.value = 0;
    npCurrent.textContent = '0:00';

    // Нон-стоп: если трек играл из очереди «Моя музыка», включаем следующий (по кругу)
    playNext();
});

// Если ссылка протухла (например, заранее полученная) — один раз резолвим заново
audioPlayer.addEventListener('error', async () => {
    if (!currentTrack || retriedCurrent) return;
    retriedCurrent = true;
    try {
        audioPlayer.src = await resolveStreamUrl(currentTrack.audio);
        await audioPlayer.play();
    } catch (error) {
        console.error("Повторная попытка не удалась:", error);
        npPlayPause.textContent = '▶️';
    }
});

function nextQueueIndex() {
    if (!activeQueue || activeQueue.length === 0) return -1;
    return (activeQueueIndex + 1) % activeQueue.length;
}

function playNext() {
    const nextIndex = nextQueueIndex();
    if (nextIndex < 0) return;
    playFromList(nextIndex, activeQueue, true);
}

function playPrevious() {
    if (audioPlayer.currentTime > 3 || !activeQueue || activeQueue.length === 0) {
        audioPlayer.currentTime = 0;
        return;
    }
    const prevIndex = (activeQueueIndex - 1 + activeQueue.length) % activeQueue.length;
    playFromList(prevIndex, activeQueue, true);
}

function maybePrefetchNext() {
    const duration = audioPlayer.duration;
    if (!duration || duration - audioPlayer.currentTime > PREFETCH_BEFORE_END) return;
    const nextIndex = nextQueueIndex();
    if (nextIndex < 0) return;
    const resolveUrl = activeQueue[nextIndex].audio;

    // iOS: если следующая ссылка уже готова, переключаемся чуть раньше конца,
    // чтобы между треками не было тишины — иначе iOS при заблокированном
    // экране может заморозить страницу ещё до события 'ended'
    const remaining = duration - audioPlayer.currentTime;
    if (remaining < EARLY_SWITCH_SEC && !earlySwitched && prefetched && prefetched.resolveUrl === resolveUrl) {
        earlySwitched = true;
        playNext();
        return;
    }

    if (prefetchInFlight === resolveUrl) return;
    if (prefetched && prefetched.resolveUrl === resolveUrl && Date.now() - prefetched.at < PREFETCH_TTL) return;

    prefetchInFlight = resolveUrl;
    resolveStreamUrl(resolveUrl)
        .then(url => { prefetched = { resolveUrl, url, at: Date.now() }; })
        .catch(error => console.warn("Не удалось заранее получить следующий трек:", error))
        .finally(() => { if (prefetchInFlight === resolveUrl) prefetchInFlight = null; });
}

function takePrefetched(resolveUrl) {
    if (prefetched && prefetched.resolveUrl === resolveUrl && Date.now() - prefetched.at < PREFETCH_TTL) {
        const url = prefetched.url;
        prefetched = null;
        return url;
    }
    return null;
}

// --- 3.1 УПРАВЛЕНИЕ С ЭКРАНА БЛОКИРОВКИ / НАУШНИКОВ (Media Session API) ---
function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const safe = (action, handler) => {
        try { ms.setActionHandler(action, handler); } catch { /* действие не поддерживается */ }
    };
    safe('play', () => audioPlayer.play());
    safe('pause', () => audioPlayer.pause());
    safe('seekto', (details) => {
        if (details.seekTime != null) audioPlayer.currentTime = details.seekTime;
    });
}
setupMediaSession();

function updateMediaSession(name, artist, hasQueue) {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    try {
        ms.metadata = new MediaMetadata({
            title: name || '',
            artist: artist || '',
            artwork: [
                { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
            ]
        });
    } catch { /* MediaMetadata недоступен */ }
    // Кнопки «следующий/предыдущий» показываем только для очереди «Моя музыка»
    try {
        ms.setActionHandler('nexttrack', hasQueue ? playNext : null);
        ms.setActionHandler('previoustrack', hasQueue ? playPrevious : null);
    } catch { /* действие не поддерживается */ }
}

// --- 4. УТИЛИТЫ ---
function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// --- 5.1 УПРАВЛЕНИЕ ПЛЕЕРОМ (PAUSE / SEEK) ---
npPlayPause.addEventListener('click', () => {
    if (!audioPlayer.src) return;
    if (audioPlayer.paused) {
        audioPlayer.play();
    } else {
        audioPlayer.pause();
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
    const duration = audioPlayer.duration;
    npCurrent.textContent = formatTime((npSeek.value / 100) * duration);
});

npSeek.addEventListener('change', () => {
    if (!audioPlayer.duration) return;
    audioPlayer.currentTime = (npSeek.value / 100) * audioPlayer.duration;
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

// --- 6. РАБОТА С SOUNDCLOUD (ПОИСК) ---
searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const queryText = searchInput.value;
        if (queryText) searchMusic(queryText);
    }
});

async function searchMusic(queryText) {
    trackList.innerHTML = '<p class="status">Ищем музыку на SoundCloud...</p>';
    loadMoreBtn.classList.add('hidden');
    lastSearchQuery = queryText;
    nextPageHref = null;

    const tracks = await fetchSearchPage(queryText, null);
    if (tracks === null) return; // ошибка уже отображена внутри fetchSearchPage

    lastSearchTracks = tracks;
    renderTracks(tracks, false);
    updateLoadMoreButton();
}

// Догружает следующую страницу результатов поиска и добавляет её к текущему списку
async function loadMoreTracks() {
    if (!nextPageHref || !lastSearchQuery) return;

    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Загрузка...';

    const moreTracks = await fetchSearchPage(lastSearchQuery, nextPageHref);

    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Ещё';

    if (moreTracks === null) return;

    lastSearchTracks = [...(lastSearchTracks || []), ...moreTracks];
    renderTracks(lastSearchTracks, false);
    updateLoadMoreButton();
}

// Запрашивает одну страницу результатов через прокси и обновляет nextPageHref
async function fetchSearchPage(queryText, pageHref) {
    const url = pageHref
        ? `${SOUNDCLOUD_PROXY}/api/search?next=${encodeURIComponent(pageHref)}`
        : `${SOUNDCLOUD_PROXY}/api/search?q=${encodeURIComponent(queryText)}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error || !Array.isArray(data.collection)) {
            console.error("Ошибка SoundCloud API:", data.error);
            trackList.innerHTML = '<p class="status">Ошибка поиска. Попробуйте позже.</p>';
            return null;
        }

        nextPageHref = data.next_href || null;

        // Играть можем только треки с прогрессивным (обычным mp3) потоком —
        // HLS-only/DRM треки плеер без отдельной библиотеки не потянет. У части
        // мейджор-лейбловых треков (policy: SNIP) доступны только 30-секундные
        // превью — не исключаем их из поиска, но честно помечаем в названии
        return data.collection
            .filter(item => item.streamable && getProgressiveTranscoding(item))
            .map(item => {
                const transcoding = getProgressiveTranscoding(item);
                return {
                    id: item.id,
                    name: transcoding.snipped ? `${item.title} · превью 30 сек` : item.title,
                    artist_name: item.user ? item.user.username : 'Неизвестный автор',
                    audio: transcoding.url // ссылка на резолв потока, не сам mp3
                };
            });
    } catch (error) {
        console.error("Ошибка сети:", error);
        trackList.innerHTML = '<p class="status">Ошибка сети. Проверьте подключение.</p>';
        return null;
    }
}

function getProgressiveTranscoding(item) {
    const transcodings = item.media && item.media.transcodings;
    if (!transcodings) return null;
    return transcodings.find(t => t.format && t.format.protocol === 'progressive') || null;
}

function updateLoadMoreButton() {
    loadMoreBtn.classList.toggle('hidden', !nextPageHref);
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
            audioUrl: track.url, // ссылка на резолв потока SoundCloud
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

// --- 10. ВОСПРОИЗВЕДЕНИЕ ЧЕРЕЗ SOUNDCLOUD ---
async function playFromList(index, tracks, isLibrary) {
    const track = tracks[index];
    if (!track) return;

    // Очередь нон-стоп заводим только для «Моя музыка»; из поиска играет один трек
    activeQueue = isLibrary ? tracks : null;
    activeQueueIndex = index;

    updateNowPlayingLikeButton(track, isLibrary);
    await playMusic(track.audio, track.name, track.artist_name, takePrefetched(track.audio));
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

// streamResolveUrl — это адрес SoundCloud, по которому ещё нужно получить
// подписанную ссылку на сам mp3 (она короткоживущая, поэтому резолвим лениво,
// только когда трек реально нажали, а не заранее для всех результатов поиска)
async function resolveStreamUrl(streamResolveUrl) {
    const response = await fetch(`${SOUNDCLOUD_PROXY}/api/stream?url=${encodeURIComponent(streamResolveUrl)}`);
    const data = await response.json();
    if (!data.url) throw new Error('Пустая ссылка на поток');
    return data.url;
}

// readyUrl — заранее полученная ссылка: тогда src и play() выставляются
// синхронно, без ожидания сети (важно для смены трека при погашенном экране)
async function playMusic(streamResolveUrl, name, artist, readyUrl = null) {
    currentTrack = { audio: streamResolveUrl, name, artist };
    retriedCurrent = false;
    earlySwitched = false;

    npTitle.textContent = name || '—';
    npArtist.textContent = artist || '';
    npSeek.value = 0;
    npCurrent.textContent = '0:00';
    npDuration.textContent = '0:00';
    audioWrapper.classList.remove('hidden');
    npPlayPause.textContent = '⏳';
    updateMediaSession(name, artist, !!activeQueue);

    try {
        audioPlayer.src = readyUrl || await resolveStreamUrl(streamResolveUrl);
        await audioPlayer.play();

        console.log("Играет:", name);
    } catch (error) {
        console.error("Ошибка воспроизведения:", error);
        npPlayPause.textContent = '▶️';
    }
}
