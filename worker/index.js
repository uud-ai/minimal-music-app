// Прокси для SoundCloud API: сам SoundCloud не отдаёт CORS-заголовки
// сторонним доменам, поэтому браузер приложения не может дёргать его
// напрямую — воркер делает это за нас (server-to-server CORS не мешает)
// и уже сам добавляет Access-Control-Allow-Origin в ответ.

const CLIENT_ID = "pmagYZKQF6mRtNmtRzPkXSQJ76jYHLN8";

function withCors(response) {
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    return new Response(response.body, { status: response.status, headers });
}

function jsonError(message, status) {
    return withCors(new Response(JSON.stringify({ error: message }), {
        status,
        headers: { "Content-Type": "application/json" }
    }));
}

async function handleSearch(url) {
    const q = url.searchParams.get("q");
    const next = url.searchParams.get("next");

    let target;
    if (next) {
        // "next" — это next_href из предыдущего ответа SoundCloud (без client_id)
        const nextUrl = new URL(next);
        if (!nextUrl.hostname.endsWith("soundcloud.com")) {
            return jsonError("invalid next url", 400);
        }
        nextUrl.searchParams.set("client_id", CLIENT_ID);
        target = nextUrl.toString();
    } else if (q) {
        target = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&limit=10&linked_partitioning=1&client_id=${CLIENT_ID}`;
    } else {
        return jsonError("missing q or next", 400);
    }

    const resp = await fetch(target);
    return withCors(resp);
}

async function handleStream(url) {
    const streamUrl = url.searchParams.get("url");
    if (!streamUrl) return jsonError("missing url", 400);

    let target;
    try {
        target = new URL(streamUrl);
    } catch {
        return jsonError("invalid url", 400);
    }

    // Не даём превратить воркер в открытый прокси на произвольные хосты
    if (!target.hostname.endsWith("soundcloud.com")) {
        return jsonError("invalid host", 400);
    }

    target.searchParams.set("client_id", CLIENT_ID);
    const resp = await fetch(target.toString());
    return withCors(resp);
}

export default {
    async fetch(request) {
        const url = new URL(request.url);

        if (request.method === "OPTIONS") {
            return withCors(new Response(null, { status: 204 }));
        }

        if (url.pathname === "/api/search") {
            return handleSearch(url);
        }

        if (url.pathname === "/api/stream") {
            return handleStream(url);
        }

        return jsonError("not found", 404);
    }
};
