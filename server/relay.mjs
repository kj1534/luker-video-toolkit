import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { createVideoAttachment } from '../media.js';

export function validateVideo(video, config) {
    const normalized = createVideoAttachment(video?.url, video?.duration_seconds);
    if (normalized.url.startsWith('gs://')) {
        if (!normalized.url.startsWith(`gs://${config.bucket}/`)) throw new Error('视频必须位于配置的 GCS Bucket。');
    } else {
        if (!(config.direct_media_origins || []).includes(new URL(normalized.url).origin)) throw new Error('此直链来源尚未配置，请先云端导入。');
        if (video.size != null && (!Number.isSafeInteger(video.size) || video.size <= 0 || video.size > config.https_max_bytes)) throw new Error('直链视频超过配置限制，请使用 GCS。');
    }
    return normalized;
}

/** Replace only a freshly issued marker; preserve tools, signatures, system and generation settings. */
export function injectVideo(body, marker, video) {
    const copy = structuredClone(body);
    let matches = 0;
    if (!Array.isArray(copy.contents)) throw new Error('Gemini contents is missing');
    for (const content of copy.contents) {
        if (!Array.isArray(content.parts)) continue;
        content.parts = content.parts.flatMap(part => {
            if (typeof part.text !== 'string' || !part.text.includes(marker)) return [part];
            if (content.role !== 'user') throw new Error('Video marker must belong to a user message');
            const pieces = part.text.split(marker);
            matches += pieces.length - 1;
            const output = [];
            pieces.forEach((text, index) => {
                if (index) output.push({ fileData: { mimeType: video.mime_type, fileUri: video.url } });
                if (text) output.push({ ...part, text });
            });
            return output;
        });
    }
    if (matches !== 1) throw new Error('Expected exactly one video attachment marker');
    return copy;
}

function equalSecret(left, right) {
    const a = Buffer.from(left || '');
    const b = Buffer.from(right || '');
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createRelay(config, fetchImpl) {
    const jobs = new Map();
    const controllers = new Set();
    const clean = () => {
        for (const [id, job] of jobs) if (job.expires <= Date.now()) jobs.delete(id);
    };
    const timer = setInterval(clean, 30000);
    timer.unref();
    const server = http.createServer(async (request, response) => {
        let controller;
        try {
            const url = new URL(request.url, 'http://127.0.0.1');
            const match = url.pathname.match(/^\/relay\/([a-f0-9]{48})\/(v1beta|v1)\/models\/([^/:]+):(generateContent|streamGenerateContent)$/);
            const job = match && jobs.get(match[1]);
            if (request.method !== 'POST' || !job || job.expires <= Date.now()
                || !equalSecret(url.searchParams.get('key'), job.nonce) || match[3] !== config.model) {
                response.writeHead(403, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'Invalid or expired GCS video request. Reattach and retry.' } }));
                return;
            }
            jobs.delete(match[1]); // A prepared request can be consumed only once.
            let size = 0;
            const chunks = [];
            for await (const chunk of request) {
                size += chunk.length;
                if (size > 32 * 1024 * 1024) throw new Error('Request is too large');
                chunks.push(chunk);
            }
            const body = injectVideo(JSON.parse(Buffer.concat(chunks).toString()), job.marker, job.video);
            controller = new AbortController();
            controllers.add(controller);
            const timeout = setTimeout(() => controller.abort(), config.request_timeout_ms);
            timeout.unref();
            response.once('close', () => { clearTimeout(timeout); controller.abort(); });
            const target = new URL(`${config.upstream}/${match[2]}/models/${config.model}:${match[4]}`);
            if (match[4] === 'streamGenerateContent') target.searchParams.set('alt', 'sse');
            const upstream = await fetchImpl(target.href, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': job.apiKey },
                body: JSON.stringify(body), signal: controller.signal,
            });
            response.writeHead(upstream.status, {
                'Content-Type': upstream.headers.get('content-type') || 'application/json',
                'Cache-Control': 'no-store',
            });
            await pipeline(upstream.body, response);
        } catch (error) {
            // Do not log upstream URLs, credentials, prompts or video references.
            if (!response.headersSent) {
                response.writeHead(502, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify({ error: { message: 'GCS video relay failed. Check the file, connection and plugin status.' } }));
            } else response.destroy();
        } finally {
            if (controller) controllers.delete(controller);
        }
    });
    return {
        server,
        prepare(video, apiKey, user) {
            clean();
            if (!apiKey) throw new Error('现有 CPA 连接没有可用密钥。');
            if (jobs.size >= 128 || [...jobs.values()].filter(job => job.user === user).length >= 16) throw new Error('待发送的视频请求过多，请稍后重试。');
            const nonce = randomBytes(24).toString('hex');
            const marker = `[LUKER_GCS_VIDEO_${nonce}]`;
            jobs.set(nonce, { nonce, marker, apiKey, user, video: validateVideo(video, config), expires: Date.now() + config.prepare_ttl_ms });
            return { marker, reverse_proxy: `http://127.0.0.1:${server.address().port}/relay/${nonce}`, proxy_password: nonce };
        },
        async close() {
            clearInterval(timer);
            jobs.clear();
            for (const controller of controllers) controller.abort();
            server.closeAllConnections();
            if (server.listening) await new Promise(resolve => server.close(resolve));
        },
    };
}
