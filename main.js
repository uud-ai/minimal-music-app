import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { getFirestore, collection, addDoc, getDocs, query, deleteDoc, doc } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

// Твой конфиг Firebase
const firebaseConfig = {
    apiKey: "AIza***",
    authDomain: "***",
    projectId: "***",
    storageBucket: "***",
    messagingSenderId: "***",
    appId: "***"
};

// Инициализация
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

// Константы
const JAMENDO_CLIENT_ID = "ced92dff";
const CACHE_NAME = 'offline-music-v1';

const searchInput = document.getElementById('search-input');
const trackList = document.getElementById('track-list');
const navSearch = document.getElementById('nav-search');
const navLibrary = document.getElementById('nav-library');

// --- УТИЛИТЫ ---

// Функция для защиты от XSS (очистка текста от потенциально опасного кода)
function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// --- ЛОГИКА НАВИГАЦИИ ---

navSearch.addEventListener('click', () => {
    navSearch.classList.add('active');
    navLibrary.classList.remove('active');
    trackList.innerHTML = '<p class="status">Введите название песни для поиска</p>';
});

navLibrary.addEventListener('click', async () => {
    navLibrary.classList.add('active');
    navSearch.classList.remove('active');
    loadLibrary();
});

// --- РАБОТА С JAMENDO ---

searchInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const queryText = searchInput.value;
        if (queryText) searchMusic(queryText);
    }
});

async function searchMusic(queryText) {
    trackList.innerHTML = '<p class="status">Ищем музыку...</p>';
    const url = `https://api.jamendo.com/v3.0/tracks/?client_id=${JAMENDO_CLIENT_ID}&format=json&limit=10&search=${encodeURIComponent(queryText)}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        renderTracks(data.results, false);
    } catch (error) {
        console.error("Ошибка API:", error);
        trackList.innerHTML = '<p class="status">Ошибка сети. Проверьте подключение.</p>';
    }
}

// --- ОТРИСОВКА ---

function renderTracks(tracks, isLibrary) {
    trackList.innerHTML = '';
    
    if (!tracks || tracks.length === 0) {
        trackList.innerHTML = '<p class="status">Список пуст</p>';
        return;
    }

    tracks.forEach(track => {
        const trackCard = document.createElement('div');
        trackCard.className = 'track-card';
        // Используем escapeHTML для безопасной вставки данных
        trackCard.innerHTML = `
            <div class="track-info">
                <strong>${escapeHTML(track.name)}</strong>
                <span>${escapeHTML(track.artist_name)}</span>
            </div>
            <div class="actions">
                <button class="play-btn" data-url="${track.audio}">▶️</button>
                <button class="like-btn" 
                    data-id="${track.id}" 
                    data-url="${track.audio}" 
                    data-name="${escapeHTML(track.name)}" 
                    data-artist="${escapeHTML(track.artist_name)}"
                    data-docid="${track.docId || ''}">
                    ${isLibrary ? '🗑️' : '♡'}
                </button>
            </div>
        `;
        trackList.appendChild(trackCard);
    });
}

// --- ДЕЛЕГИРОВАНИЕ СОБЫТИЙ (Один обработчик вместо цикла) ---

trackList.addEventListener('click', (e) => {
    const target = e.target;
    
    if (target.classList.contains('play-btn')) {
        playMusic(target.dataset.url);
    } else if (target.classList.contains('like-btn')) {
        const isLibrary = navLibrary.classList.contains('active');
        if (isLibrary) {
            handleDelete(target);
        } else {
            handleLike(target);
        }
    }
});

// --- ОФФЛАЙН И СИНХРОНИЗАЦИЯ ---

async function handleLike(btn) {
    const track = btn.dataset;
    btn.innerHTML = '⏳'; // Показываем загрузку

    try {
        // 1. Сохраняем в кэш браузера (Оффлайн доступ)
        const cache = await caches.open(CACHE_NAME);
        try {
            // mode: 'no-cors' помогает обойти блокировки CORS при кэшировании сторонних медиа
            const response = await fetch(track.url, { mode: 'no-cors' });
            await cache.put(track.url, response);
        } catch (cacheError) {
            console.warn("Не удалось сохранить аудио в кэш:", cacheError);
        }

        // 2. Записываем в Firestore (Синхронизация)
        await addDoc(collection(db, "liked_tracks"), {
            trackId: track.id,
            name: track.name,
            artist: track.artist,
            audioUrl: track.url,
            timestamp: Date.now()
        });

        btn.innerHTML = '❤️';
        console.log("Сохранено оффлайн и в БД:", track.name);
    } catch (error) {
        console.error("Ошибка сохранения:", error);
        btn.innerHTML = '❌';
    }
}

async function loadLibrary() {
    trackList.innerHTML = '<p class="status">Загружаем вашу библиотеку...</p>';
    try {
        const q = query(collection(db, "liked_tracks"));
        const querySnapshot = await getDocs(q);
        const tracks = [];
        
        querySnapshot.forEach((docSnap) => {
            const data = docSnap.data();
            tracks.push({
                docId: docSnap.id, // ID документа для последующего удаления
                id: data.trackId,
                name: data.name,
                artist_name: data.artist,
                audio: data.audioUrl
            });
        });
        
        // Сортируем треки по свежести
        renderTracks(tracks.reverse(), true);
    } catch (error) {
        console.error("Ошибка загрузки библиотеки:", error);
        trackList.innerHTML = '<p class="status">Не удалось загрузить библиотеку.</p>';
    }
}

async function handleDelete(btn) {
    const card = btn.closest('.track-card');
    const docId = btn.dataset.docid;
    const audioUrl = btn.dataset.url;

    // Оптимистичное удаление из UI
    card.remove();

    // Если список стал пустым, показываем сообщение
    if (trackList.children.length === 0) {
        trackList.innerHTML = '<p class="status">Список пуст</p>';
    }

    try {
        // 1. Удаление из Firestore
        if (docId) {
            await deleteDoc(doc(db, "liked_tracks", docId));
        }

        // 2. Удаление из кэша браузера
        const cache = await caches.open(CACHE_NAME);
        await cache.delete(audioUrl);

        console.log("Трек успешно удален");
    } catch (error) {
        console.error("Ошибка при удалении:", error);
        alert("Произошла ошибка при удалении трека из базы.");
    }
}

// --- ПЛЕЕР ---

// Обновленная функция плеера, которая работает с HTML-элементом
function playMusic(url) {
    const audio = document.getElementById('main-player');
    
    if (audio) {
        audio.src = url;
        audio.style.display = 'block'; // Показываем плеер при запуске первого трека
        audio.play().catch(e => console.error("Ошибка воспроизведения:", e));
    } else {
        console.error("Элемент аудиоплеера не найден в HTML!");
    }
}