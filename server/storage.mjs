import fs from 'node:fs';
import { createSign, randomUUID } from 'node:crypto';
import { fileInfo } from '../media.js';
import { signDownload } from './gcs-signing.mjs';

export function userPrefix(handle) {
    if (typeof handle !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(handle)) throw new Error('Invalid user');
    return `videos/${handle}/`;
}

export function uploadMetadata(input, handle, config) {
    const filename = String(input.filename ?? '').replace(/[\\/?#\x00-\x1f]/g, '_').slice(0, 180);
    const size = Number(input.size);
    if (!filename || !Number.isSafeInteger(size) || size <= 0 || size > config.max_upload_bytes) throw new Error('文件大小无效或超过 2 GiB 上传上限。');
    const name = `${userPrefix(handle)}${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${filename}`;
    const duration = input.duration_seconds == null ? null : Number(input.duration_seconds);
    if (duration !== null && (!Number.isFinite(duration) || duration <= 0)) throw new Error('时长无效。');
    const video = { url: `gs://${config.bucket}/${name}`, title: filename, ...fileInfo(filename), duration_seconds: duration, send_scope: 'turn', size, storage: 'gcs' };
    return { size, video, object: { name, contentType: video.mime_type, metadata: { original_name: filename, ...(video.duration_seconds ? { duration_seconds: String(video.duration_seconds) } : {}) } } };
}

export function createStorage(config, fetchImpl) {
    // This file belongs to a dedicated bucket-scoped uploader, never the deployment Owner.
    const credential = JSON.parse(fs.readFileSync(config.credential_file, 'utf8'));
    let cachedToken;
    let refreshPromise;
    async function accessToken() {
        if (cachedToken?.expires > Date.now() + 60000) return cachedToken.token;
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async () => {
            const now = Math.floor(Date.now() / 1000);
            const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
            const claims = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: credential.client_email, scope: 'https://www.googleapis.com/auth/devstorage.read_write', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
            const signature = createSign('RSA-SHA256').update(claims).sign(credential.private_key, 'base64url');
            const response = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${claims}.${signature}` }), signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('上传账号认证失败。');
            const data = await response.json();
            cachedToken = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
            return cachedToken.token;
        })();
        try { return await refreshPromise; } finally { refreshPromise = null; }
    }
    async function authorized(url, options = {}) {
        return fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(30000) });
    }
    function ownedName(uri, handle) {
        const prefix = `gs://${config.bucket}/${userPrefix(handle)}`;
        if (typeof uri !== 'string' || !uri.startsWith(prefix)) throw new Error('只能管理自己上传的 GCS 文件。');
        return uri.slice(`gs://${config.bucket}/`.length);
    }
    function entry(object) {
        return { url: `gs://${config.bucket}/${object.name}`, title: object.metadata?.original_name || object.name.split('/').pop(),
            ...fileInfo(object.name), duration_seconds: Number(object.metadata?.duration_seconds) || null,
            size: Number(object.size), created: object.timeCreated, generation: object.generation, storage: 'gcs' };
    }
    async function stat(uri, handle) {
        const name = ownedName(uri, handle);
        const response = await authorized(`https://storage.googleapis.com/storage/v1/b/${config.bucket}/o/${encodeURIComponent(name)}`);
        if (!response.ok) throw new Error('GCS 文件不存在或无读取权限。');
        return entry(await response.json());
    }
    return {
        stat,
        async access(uri, handle, download = false) {
            const item = await stat(uri, handle);
            return { ...signDownload(credential, config.bucket, ownedName(uri, handle), { download, title: item.title, mime: item.mime_type, generation: item.generation }), file: item };
        },
        async remove(uri, handle, generation) {
            const item = await stat(uri, handle);
            if (!generation || String(generation) !== item.generation) throw new Error('文件已变化，请刷新后重试。');
            const url = new URL(`https://storage.googleapis.com/storage/v1/b/${config.bucket}/o/${encodeURIComponent(ownedName(uri, handle))}`);
            url.searchParams.set('ifGenerationMatch', item.generation);
            const response = await authorized(url.href, { method: 'DELETE' });
            if (!response.ok) throw new Error('删除失败，请检查对象删除权限或刷新列表。');
            return { ok: true };
        },
        async startUpload(input, handle, origin) {
            const data = uploadMetadata(input, handle, config);
            const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${config.bucket}/o`);
            url.searchParams.set('uploadType', 'resumable');
            url.searchParams.set('ifGenerationMatch', '0');
            const headers = { 'Content-Type': 'application/json', 'X-Upload-Content-Type': data.video.mime_type, 'X-Upload-Content-Length': String(data.size) };
            if (origin) headers.Origin = origin;
            const response = await authorized(url.href, { method: 'POST', headers, body: JSON.stringify(data.object) });
            if (!response.ok) throw new Error('无法创建 GCS 续传会话，请检查上传账号权限。');
            const session = response.headers.get('location');
            const parsed = new URL(session);
            if (parsed.protocol !== 'https:' || parsed.hostname !== 'storage.googleapis.com') throw new Error('Invalid upload session');
            return { session, video: data.video, size: data.size };
        },
        async metadata(uri, handle) {
            const prefix = `gs://${config.bucket}/`;
            if (!uri.startsWith(prefix)) throw new Error('Wrong bucket');
            const name = uri.slice(prefix.length);
            if (!name.startsWith(userPrefix(handle))) return { duration_seconds: null };
            const url = new URL(`https://storage.googleapis.com/storage/v1/b/${config.bucket}/o/${encodeURIComponent(name)}`);
            url.searchParams.set('fields', 'metadata,size');
            const response = await authorized(url.href);
            if (!response.ok) return { duration_seconds: null };
            const data = await response.json();
            return { duration_seconds: Number(data.metadata?.duration_seconds) || null, size: Number(data.size) };
        },
        async list(handle, pageToken = '') {
            const url = new URL(`https://storage.googleapis.com/storage/v1/b/${config.bucket}/o`);
            url.searchParams.set('prefix', userPrefix(handle));
            url.searchParams.set('maxResults', '100');
            if (pageToken) url.searchParams.set('pageToken', pageToken);
            url.searchParams.set('fields', 'items(name,size,timeCreated,metadata,contentType,generation),nextPageToken');
            const response = await authorized(url.href);
            if (!response.ok) throw new Error('无法读取 GCS 视频列表。');
            const data = await response.json();
            return { items: (data.items ?? []).map(entry).sort((a, b) => b.created.localeCompare(a.created)), nextPageToken: data.nextPageToken || '' };
        },
    };
}
