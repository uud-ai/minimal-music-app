// Хранилище своих аудиофайлов в Cloudflare Workers KV (бесплатный тариф, без
// привязки карты — R2 требует карту, а российские Cloudflare не принимает).
// Ограничения KV Free: значение до 25 МБ, всего 1 ГБ, 1000 записей в сутки.
//
// GET    /files/<key>        — отдаёт файл (с поддержкой Range: перемотка в <audio>)
// GET    /list               — файлы текущего пользователя
// PUT    /upload?name=<имя>  — загрузка, тело запроса — сам файл
// DELETE /files/<key>        — удаление своего файла
//
// Загрузка, список и удаление требуют Firebase ID-токен (тот же анонимный вход,
// что и у «Моей музыки»): каждый пользователь видит и удаляет только файлы под
// своим префиксом <uid>/. Отдача файлов открыта — ключ содержит случайную часть,
// а <audio> не умеет слать заголовок Authorization.

const FIREBASE_PROJECT_ID = "minimal-music-app-e3bd3";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // предел размера значения в KV
const ALLOWED_ORIGINS = [
    "https://minimal-music-app.vercel.app",
    "http://localhost:5173"
];
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

function corsHeaders(request) {
    const origin = request.headers.get("Origin");
    const headers = {
        "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Range",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin"
    };
    if (origin && ALLOWED_ORIGINS.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
    return headers;
}

function json(request, data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(request) }
    });
}

// --- Проверка Firebase ID-токена (RS256, ключи Google в формате JWK) ---
let jwksCache = null; // { keys, expires }

async function getJwks() {
    if (jwksCache && jwksCache.expires > Date.now()) return jwksCache.keys;
    const response = await fetch(JWKS_URL);
    const { keys } = await response.json();
    const maxAge = Number((response.headers.get("Cache-Control") || "").match(/max-age=(\d+)/)?.[1] || 3600);
    jwksCache = { keys, expires: Date.now() + maxAge * 1000 };
    return keys;
}

function base64UrlDecode(str) {
    const base64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

// Возвращает uid пользователя или null, если токен невалиден
async function verifyFirebaseToken(request) {
    const auth = request.headers.get("Authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    try {
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])));
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])));
        if (header.alg !== "RS256") return null;

        const jwk = (await getJwks()).find(k => k.kid === header.kid);
        if (!jwk) return null;
        const key = await crypto.subtle.importKey(
            "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        const valid = await crypto.subtle.verify(
            "RSASSA-PKCS1-v1_5", key, base64UrlDecode(parts[2]),
            new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
        if (!valid) return null;

        const now = Math.floor(Date.now() / 1000);
        if (payload.aud !== FIREBASE_PROJECT_ID) return null;
        if (payload.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
        if (!(payload.exp > now) || !(payload.iat <= now + 60)) return null;
        if (typeof payload.sub !== "string" || !payload.sub) return null;
        return payload.sub;
    } catch {
        return null;
    }
}

// Имя файла для ключа: без слэшей и управляющих символов, с разумной длиной
function safeFileName(name) {
    return (name || "track").replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 120) || "track";
}

// Разбирает «Range: bytes=start-end» (а также «start-» и «-suffix»); null — без Range
function parseRange(header, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header || "");
    if (!match || (match[1] === "" && match[2] === "")) return null;
    let start, end;
    if (match[1] === "") {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
    } else {
        start = Number(match[1]);
        end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    return start <= end && start < size ? { start, end } : "invalid";
}

async function handleGetFile(request, env, key) {
    const etag = `"${key.split("/")[1] || key}"`;
    const headers = new Headers(corsHeaders(request));
    headers.set("ETag", etag);
    headers.set("Accept-Ranges", "bytes");
    // Ключи не переиспользуются — файл по ключу никогда не меняется
    headers.set("Cache-Control", "public, max-age=31536000, immutable");

    if (request.headers.get("If-None-Match") === etag) return new Response(null, { status: 304, headers });

    const rangeHeader = request.headers.get("Range");
    // Без Range отдаём потоком; с Range (Safari шлёт его всегда) — режем буфер
    const { value, metadata } = await env.FILES.getWithMetadata(key, { type: rangeHeader ? "arrayBuffer" : "stream" });
    if (value === null) return new Response("Not found", { status: 404, headers: corsHeaders(request) });

    headers.set("Content-Type", metadata?.contentType || "audio/mpeg");
    const size = rangeHeader ? value.byteLength : metadata?.size;

    if (rangeHeader) {
        const range = parseRange(rangeHeader, size);
        if (range === "invalid") {
            headers.set("Content-Range", `bytes */${size}`);
            return new Response(null, { status: 416, headers });
        }
        if (range) {
            headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
            headers.set("Content-Length", String(range.end - range.start + 1));
            return new Response(value.slice(range.start, range.end + 1), { status: 206, headers });
        }
    }
    if (size) headers.set("Content-Length", String(size));
    return new Response(value, { headers });
}

async function handleUpload(request, env, url, uid) {
    const size = Number(request.headers.get("Content-Length") || 0);
    if (!size) return json(request, { error: "Пустой файл" }, 400);
    if (size > MAX_UPLOAD_BYTES) return json(request, { error: "Файл больше 25 МБ" }, 413);

    const contentType = request.headers.get("Content-Type") || "";
    if (!contentType.startsWith("audio/")) return json(request, { error: "Нужен аудиофайл" }, 415);

    const name = safeFileName(url.searchParams.get("name"));
    const key = `${uid}/${crypto.randomUUID()}/${name}`;
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_UPLOAD_BYTES) return json(request, { error: "Файл больше 25 МБ" }, 413);
    // Метаданные KV ограничены 1 КБ — имя уже обрезано до 120 символов
    await env.FILES.put(key, body, {
        metadata: { name, size: body.byteLength, contentType, uploadedAt: Date.now() }
    });
    return json(request, { key, name, size: body.byteLength });
}

async function handleList(request, env, uid) {
    const files = [];
    let cursor;
    do {
        const page = await env.FILES.list({ prefix: `${uid}/`, cursor });
        for (const item of page.keys) {
            files.push({
                key: item.name,
                name: item.metadata?.name || item.name.split("/").pop(),
                size: item.metadata?.size || 0,
                uploadedAt: item.metadata?.uploadedAt || 0
            });
        }
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    files.sort((a, b) => b.uploadedAt - a.uploadedAt);
    return json(request, { files });
}

export default {
    async fetch(request, env) {
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        const url = new URL(request.url);
        const fileMatch = url.pathname.match(/^\/files\/(.+)$/);
        const key = fileMatch ? decodeURIComponent(fileMatch[1]) : null;

        if (request.method === "GET" && key) return handleGetFile(request, env, key);

        const uid = await verifyFirebaseToken(request);
        if (!uid) return json(request, { error: "Нужна авторизация" }, 401);

        if (request.method === "PUT" && url.pathname === "/upload") return handleUpload(request, env, url, uid);
        if (request.method === "GET" && url.pathname === "/list") return handleList(request, env, uid);
        if (request.method === "DELETE" && key) {
            if (!key.startsWith(`${uid}/`)) return json(request, { error: "Чужой файл" }, 403);
            await env.FILES.delete(key);
            return json(request, { ok: true });
        }
        return json(request, { error: "Not found" }, 404);
    }
};
