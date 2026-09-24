import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, query, where, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

// --- 1. РЕГИСТРАЦИЯ SERVICE WORKER (ДЛЯ PWA) ---
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service Worker зарегистрирован!', reg))
            .catch(err => console.log('Ошибка SW:', err));
    });
}

// --- 2. КОНФИГУРАЦИЯ FIREBASE И YOUTUBE ---
const firebaseConfig = {
    apiKey: "AIzaSyDCYcwNHXw0Vv3OJEAPl1qgi03H-Y_qfBU",
    authDomain: "minimal-music-app-e3bd3.firebaseapp.com",
    projectId: "minimal-music-app-e3bd3",
    storageBucket: "minimal-music-app-e3bd3.firebasestorage.app",
    messagingSenderId: "1081743657641",
    appId: "1:1081743657641:web:a5ebfcc79fc50f8b2177b8"
};

// Инициализация Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);

// --- 2.1 АНОНИМНАЯ АВТОРИЗАЦИЯ ---
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

// Константы приложения
const YOUTUBE_API_KEY = "AIzaSyBgrlvnKuTsj4HSitEUT3Ae4yJLbNozfd8";
const CACHE_NAME = 'offline-music-v1';

const searchInput = document.getElementById('search-input');
const trackList = document.getElementById('track-list');
const navSearch = document.getElementById('nav-search');
const navLibrary = document.getElementById('nav-library');

const audioWrapper = document.getElementById('audio-wrapper');
const npTitle = document.getElementById('np-title');
const npArtist = document.getElementById('np-artist');
const npPlayPause = document.getElementById('np-playpause');
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

// Последние результаты поиска — чтобы не терять их при переходе на вкладку «Моя музыка» и обратно
let lastSearchTracks = null;

// Асинхронно загружаем скрипт YouTube IFrame API
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0];
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

// Эта функция автоматически вызовется, когда скрипт YouTube загрузится
window.onYouTubeIframeAPIReady = function() {
    ytPlayer = new YT.Player('yt-player', {
        height: '0',
        width: '0',
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
    } else {
        trackList.innerHTML = '<p class="status">Введите название песни для поиска</p>';
    }
});

navLibrary.addEventListener('click', async () => {
    navLibrary.classList.add('active');
    navSearch.classList.remove('active');
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
    
    // Запрос к YouTube Data API (ищем видео в категории Музыка)
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${encodeURIComponent(queryText)}&type=video&videoCategoryId=10&key=${YOUTUBE_API_KEY}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.error) {
            console.error("Ошибка YouTube API:", data.error.message);
            trackList.innerHTML = '<p class="status">Ошибка API. Проверьте ключ.</p>';
            return;
        }

        // Преобразуем данные YouTube в наш формат
        const tracks = data.items.map(item => ({
            id: item.id.videoId, 
            name: item.snippet.title, 
            artist_name: item.snippet.channelTitle, 
            audio: item.id.videoId // В качестве "аудио" передаем ID видео
        }));

        lastSearchTracks = tracks;
        renderTracks(tracks, false);
    } catch (error) {
        console.error("Ошибка сети:", error);
        trackList.innerHTML = '<p class="status">Ошибка сети. Проверьте подключение.</p>';
    }
}

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
        await authReady;
        // Записываем информацию о треке в Firestore, привязывая к текущему пользователю
        await addDoc(collection(db, "liked_tracks"), {
            uid: currentUser.uid,
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
        await authReady;
        const q = query(collection(db, "liked_tracks"), where("uid", "==", currentUser.uid));
        const querySnapshot = await getDocs(q);
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

    card.remove();

    if (trackList.children.length === 0) {
        trackList.innerHTML = '<p class="status">Список пуст</p>';
    }

    try {
        if (docId) {
            await deleteDoc(doc(db, "liked_tracks", docId));
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

    playMusic(track.audio, track.name, track.artist_name);
}

function playMusic(videoId, name, artist) {
    if (ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(videoId);
        ytPlayer.playVideo();

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