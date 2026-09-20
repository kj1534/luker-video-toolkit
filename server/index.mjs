import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateVideo, createRelay } from './relay.mjs';
import { createStorage } from './storage.mjs';
import { createImportWorkers } from './workers.mjs';
import { loadConfig, visibleSettings, prepareSettings, commitSettings, isAdmin } from './settings.mjs';

export const info = { id: 'gcs-video', name: 'Video Toolkit', description: 'Turn-scoped private GCS video attachments using the existing native Gemini connection.' };
const configFile = path.resolve(process.cwd(), 'config/gcs-video/config.json');
const config = loadConfig(configFile);
const catalogFile = path.resolve(path.dirname(configFile), 'direct-videos.json');
let relay;
let ready;
let secretModule;
let storage;
let fetchImpl;
const importTokens = new Map();
let importPoller;
const importJobs = new Map();
let workers = createImportWorkers(config);
let saving = false;

async function worker(workerId, route, body) {
    const response = await fetchImpl(workers.get(workerId).url + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${importTokens.get(workerId)}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error('海外导入服务无法读取此直链或暂不可用。');
    return response.json();
}


function completeDirectImport(entry, job) {
    if (['complete', 'failed'].includes(job.status)) entry.finished = true;
    if (job.status !== 'complete' || !job.video) return false;
    if (!entry.submitted) {
        validateVideo(job.video, config);
        saveDirectVideo(entry.user, job.video);
        entry.video = job.video;
        entry.submitted = true;
    }
    return true;
}
function readCatalog() {
    return fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile, 'utf8')) : {};
}
function readDirectVideos(handle) {
    return (readCatalog()[handle] || []).filter(video => Date.parse(video.expires) > Date.now());
}
function saveDirectVideo(handle, video) {
    const data = readCatalog();
    data[handle] = [...(data[handle] || []).filter(item => item.url !== video.url && Date.parse(item.expires) > Date.now()), video];
    const temporary = catalogFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temporary, catalogFile);
}

export function init(router) {
    router.get('/config', async (request, response) => {
        try {
            await ready;
            response.json({ configured: Boolean(storage), admin: isAdmin(request), model: config.model, bucket: config.bucket, upstream: config.upstream, scope: 'turn', max_upload_bytes: config.max_upload_bytes, user: request.user?.profile?.handle, https_max_bytes: config.https_max_bytes, direct_media_origins: config.direct_media_origins, import_workers: workers.publicList, default_import_worker: config.default_import_worker });
        } catch { response.status(503).json({ error: 'GCS video plugin is unavailable.' }); }
    });
    router.get('/settings', (request, response) => {
        if (!isAdmin(request)) return response.sendStatus(403);
        response.set('Cache-Control', 'no-store').json(visibleSettings(config));
    });
    router.post('/settings', async (request, response) => {
        if (!isAdmin(request)) return response.sendStatus(403);
        if (saving) return response.status(409).json({ error: '配置正在保存，请稍后重试。' });
        saving = true;
        try {
            await ready;
            for (const entry of importJobs.values()) {
                if (entry.error || entry.finished) continue;
                let job;
                try { job = await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`); }
                catch { return response.status(409).json({ error: '暂时无法确认已有导入任务状态，请稍后重试。' }); }
                if (!['complete', 'failed'].includes(job.status)) return response.status(409).json({ error: '请等待当前导入完成后再修改配置。' });
                entry.finished = true;
            }
            let prepared;
            try { prepared = prepareSettings(request.body, config, path.dirname(configFile)); }
            catch (error) { return response.status(400).json({ error: error.message }); }
            commitSettings(configFile, prepared);
            Object.assign(config, prepared.config);
            storage = createStorage(config, fetchImpl);
            workers = createImportWorkers(config);
            importTokens.clear();
            for (const item of config.import_workers) importTokens.set(item.id, fs.readFileSync(item.token_file, 'utf8').trim());
            response.set('Cache-Control', 'no-store').json({ ok: true, settings: visibleSettings(config) });
        } catch { response.status(500).json({ error: '保存失败，请检查服务端配置目录权限。' }); }
        finally { saving = false; }
    });
    router.post('/settings/test', async (request, response) => {
        if (!isAdmin(request)) return response.sendStatus(403);
        await ready;
        const checks = await Promise.all([
            (async () => { try { await storage.list(request.user.profile.handle); return { label: 'GCS', ok: true }; } catch { return { label: 'GCS', ok: false }; } })(),
            ...config.import_workers.map(async item => { try { await worker(item.id, '/healthz'); return { label: item.label, ok: true }; } catch { return { label: item.label, ok: false }; } }),
        ]);
        response.set('Cache-Control', 'no-store').json({ checks });
    });
    router.get('/videos', async (request, response) => {
        try {
            await ready;
            if (!request.user?.profile?.handle) return response.sendStatus(401);
            const handle = request.user.profile.handle;
            const pageToken = String(request.query.pageToken || '');
            const result = await storage.list(handle, pageToken);
            if (!pageToken) result.items = [...readDirectVideos(handle), ...result.items].sort((a, b) => b.created.localeCompare(a.created));
            response.set('Cache-Control', 'no-store').json(result);
        } catch (error) { response.status(502).json({ error: '无法读取视频列表，请检查 GCS 连接。' }); }
    });
    router.post('/uploads', async (request, response) => {
        try {
            await ready;
            if (!request.user?.profile?.handle) return response.sendStatus(401);
            response.set('Cache-Control', 'no-store').json(await storage.startUpload(request.body || {}, request.user.profile.handle, request.headers.origin));
        } catch (error) { response.status(400).json({ error: error.message?.includes('账号') ? 'GCS 上传账号暂不可用。' : '无法创建上传，请检查视频类型、时长、大小和存储权限。' }); }
    });
    router.post('/imports', async (request, response) => {
        try {
            await ready;
            const user = request.user?.profile?.handle;
            if (!user) return response.sendStatus(401);
            const workerId = workers.get(request.body?.worker_id).id;
            const source = String(request.body?.source_url || '');
            const job = await worker(workerId, '/jobs', { source_url: source });
            const id = `${workerId}:${job.id}`;
            importJobs.set(id, { user, workerId, remoteId: job.id, created: Date.now() });
            response.status(202).json({ id, worker_id: workerId });
        } catch { response.status(400).json({ error: '无法导入。请检查所选节点、链接类型与链接权限；支持视频直链及 Iwara、B站公开播放页。' }); }
    });
    router.get('/imports/:id', async (request, response) => {
        try {
            await ready;
            const entry = importJobs.get(request.params.id);
            if (!entry || entry.user !== request.user?.profile?.handle) return response.sendStatus(404);
            if (entry.error) return response.json({ status: 'failed', error: entry.error, worker_id: entry.workerId });
            const job = await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`);
            completeDirectImport(entry, job);
            response.json({ ...job, worker_id: entry.workerId, video: entry.video });
        } catch { response.status(502).json({ error: '暂时无法读取导入进度，请稍后刷新视频列表。' }); }
    });
    router.post('/prepare', async (request, response) => {
        try {
            await ready;
            if (!request.user?.profile?.handle || !request.user?.directories) return response.sendStatus(401);
            const body = request.body || {};
            if (body.model !== config.model || body.chat_completion_source !== 'makersuite'
                || String(body.upstream || '').replace(/\/$/, '') !== config.upstream) {
                return response.status(400).json({ error: `请选择已配置的 Gemini 连接及 ${config.model} 模型。` });
            }
            const apiKey = typeof body.proxy_password === 'string' && body.proxy_password
                ? body.proxy_password
                : secretModule.readProviderSecret(request, secretModule.SECRET_KEYS.MAKERSUITE);
            response.set('Cache-Control', 'no-store').json(relay.prepare(body.video, apiKey, request.user.profile.handle));
        } catch (error) {
            response.status(400).json({ error: '无法准备 GCS 视频请求，请检查附件、Gemini 连接和插件状态。' });
        }
    });
    ready = (async () => {
        ({ default: fetchImpl } = await import('node-fetch'));
        secretModule = await import(pathToFileURL(path.join(process.cwd(), 'src/endpoints/secrets.js')).href);
        if (config.credential_file && config.bucket && config.model && config.upstream) {
            try { storage = createStorage(config, fetchImpl); } catch { console.warn('[Video Toolkit] Configure storage in the administrator settings.'); }
        }
        for (const item of config.import_workers) { try { importTokens.set(item.id, fs.readFileSync(item.token_file, 'utf8').trim()); } catch {} }
        importPoller = setInterval(() => {
            for (const [id, entry] of importJobs) {
                if (entry.created < Date.now() - 86400000) { importJobs.delete(id); continue; }
                if (entry.submitted || entry.busy || entry.error) continue;
                entry.busy = true;
                (async () => {
                    const job = await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`);
                    entry.failures = 0;
                    if (completeDirectImport(entry, job)) return;
                    if (job.status === 'failed') { entry.error = job.error || '网站解析失败。'; return; }
                    if (entry.video && ['queued', 'running', 'complete'].includes(job.status)) { entry.submitted = true; return; }
                    if (job.status !== 'ready') return;
                    const upload = await storage.startUpload(job.metadata, entry.user);
                    entry.video = upload.video;
                    await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}/upload`, { session: upload.session });
                    entry.submitted = true;
                })().catch(() => {
                    entry.failures = (entry.failures || 0) + 1;
                    if (entry.failures >= 3) entry.error = '无法准备云端视频上传，请重新导入。';
                }).finally(() => { entry.busy = false; });
            }
        }, 2000);
        importPoller.unref();
        relay = createRelay(config, fetchImpl);
        await new Promise((resolve, reject) => {
            relay.server.once('error', reject);
            relay.server.listen(config.port, '127.0.0.1', resolve);
        });
        console.info('[Video Toolkit] Ready; private loopback relay and frontend extension loaded.');
    })();
    return ready;
}

export async function exit() { clearInterval(importPoller); if (relay) await relay.close(); }
