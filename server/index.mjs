import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateVideo, createRelay } from './relay.mjs';
import { createStorage } from './storage.mjs';
import { createImportWorkers } from './workers.mjs';
import { registerFileLibrary, fileCopyKey } from './file-library.mjs';
import { fileInfo } from '../media.js';
import { loadConfig, visibleSettings, prepareSettings, commitSettings, isAdmin, allowsModel } from './settings.mjs';

export const info = { id: 'gcs-video', name: 'File Library', description: 'Unified GCS and copyparty file management with turn-scoped Gemini attachments.' };
const configFile = path.resolve(process.cwd(), 'config/gcs-video/config.json');
const config = loadConfig(configFile);
const copyFile = path.resolve(path.dirname(configFile), 'file-copies.json');
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


async function completeDirectImport(entry, job) {
    if (['complete', 'failed'].includes(job.status)) entry.finished = true;
    if (job.status === 'complete' && !entry.copyRecorded) {
        let key = entry.copyKey;
        let uri = entry.video?.url;
        let copied;
        if (entry.originGcs && job.video?.url) {
            const destinationWorker = entry.copyWorker || entry.workerId;
            const roots = await worker(destinationWorker, '/library/roots');
            const root = roots.volumes.find(item=>item.id===entry.copyVolume);
            if (!root) throw new Error('目标目录已移除，无法登记副本。');
            const base = new URL(root.public_url); const url = new URL(job.video.url);
            const prefix = base.pathname.replace(/\/?$/, '/');
            if (url.origin !== base.origin || !url.pathname.startsWith(prefix)) throw new Error('副本路径不在目标目录内。');
            const file = await worker(destinationWorker, '/library/file', {volume:entry.copyVolume,path:decodeURIComponent(url.pathname.slice(prefix.length))});
            copied = {...file,worker_id:destinationWorker};
            key = fileCopyKey(entry.user,copied); uri = entry.originGcs;
        }
        if (key && uri?.startsWith('gs://')) {
            const copies = fs.existsSync(copyFile) ? JSON.parse(fs.readFileSync(copyFile,'utf8')) : {};
            copies[key] = uri;
            if (entry.copyLinkKey && copied) copies[entry.copyLinkKey] = copied;
            fs.writeFileSync(copyFile+'.tmp',JSON.stringify(copies),{mode:0o600});fs.renameSync(copyFile+'.tmp',copyFile);
        }
        if (job.sync_video && entry.video?.url?.startsWith('gs://')) {
            saveDirectVideo(entry.user, job.sync_video);
            const node = config.import_workers.find(item=>item.id===config.copyparty_worker && item.library_enabled);
            if (node) {
                const roots = await worker(node.id, '/library/roots');
                const url = new URL(job.sync_video.url);
                for (const root of roots.volumes) {
                    const base = new URL(root.public_url); const prefix = base.pathname.replace(/\/?$/, '/');
                    if (url.origin!==base.origin || !url.pathname.startsWith(prefix)) continue;
                    const file = await worker(node.id,'/library/file',{volume:root.id,path:decodeURIComponent(url.pathname.slice(prefix.length))});
                    const copies = fs.existsSync(copyFile)?JSON.parse(fs.readFileSync(copyFile,'utf8')):{};
                    const original = await storage.stat(entry.video.url,entry.user);
                    const copied = {...file,worker_id:node.id};
                    copies[fileCopyKey(entry.user,copied)]=entry.video.url;
                    copies[fileCopyKey(entry.user,original,'copyparty',{worker_id:node.id,volume:root.id})]=copied;
                    fs.writeFileSync(copyFile+'.tmp',JSON.stringify(copies),{mode:0o600});fs.renameSync(copyFile+'.tmp',copyFile);
                }
            }
        }
        entry.copyRecorded = true;
    }
    if (job.status !== 'complete' || !job.video) return false;
    if (!entry.submitted) {
        // Unknown formats remain manageable files, but cannot be sent as model attachments.
        // Explicit storage copies may exceed the HTTP attachment limit; attach promotes them to GCS.
        if (!entry.originGcs && fileInfo(job.video.url).attachable) validateVideo(job.video, config);
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
function forgetCatalog(url) {
    const data = readCatalog();
    for (const user of Object.keys(data)) data[user] = data[user].filter(item=>item.url.split('?')[0] !== url.split('?')[0]);
    fs.writeFileSync(catalogFile + '.tmp', JSON.stringify(data), {mode:0o600});fs.renameSync(catalogFile+'.tmp',catalogFile);
}
function saveDirectVideo(handle, video) {
    const data = readCatalog();
    data[handle] = [...(data[handle] || []).filter(item => item.url !== video.url && Date.parse(item.expires) > Date.now()), video];
    const temporary = catalogFile + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(temporary, catalogFile);
}

async function startJob(user, workerId, source, options = {}) {
    if (options.copyKey) for (const [id, entry] of importJobs) {
        if (entry.user === user && entry.copyKey === options.copyKey && !entry.finished && !entry.error) return {id, worker_id:entry.workerId};
    }
    const {copyKey, originGcs, copyVolume, copyWorker, copyLinkKey, ...body} = options;
    const job = await worker(workerId, '/jobs', { source_url:source, ...body });
    const id = `${workerId}:${job.id}`;
    importJobs.set(id, {user, workerId, remoteId:job.id, created:Date.now(), copyKey, originGcs, copyVolume, copyWorker, copyLinkKey});
    return {id, worker_id:workerId};
}

export function init(router) {
    registerFileLibrary(router, {config, worker, storage:()=>storage, startJob, catalog:readDirectVideos, copyFile, forgetCatalog});
    router.get('/config', async (request, response) => {
        try {
            await ready;
            response.json({ configured: Boolean(storage), admin: isAdmin(request), models: config.models, bucket: config.bucket, upstream: config.upstream, scope: 'turn', max_upload_bytes: config.max_upload_bytes, user: request.user?.profile?.handle, https_max_bytes: config.https_max_bytes, direct_media_origins: config.direct_media_origins, import_workers: workers.publicList, default_import_worker: config.default_import_worker });
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
    router.post('/metadata', async (request, response) => {
        if (!request.user?.profile?.handle) return response.sendStatus(401);
        try {
            await ready;
            const video = validateVideo({ url: request.body?.url }, config);
            const handle = request.user.profile.handle;
            const data = video.url.startsWith('gs://') ? await storage.metadata(video.url, handle)
                : { duration_seconds: readDirectVideos(handle).find(item => item.url === video.url)?.duration_seconds || null };
            response.set('Cache-Control', 'no-store').json(data);
        } catch { response.status(400).json({ error: '无法读取时长，可留空后继续附加。' }); }
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
            const sync = request.body?.sync_copyparty === true;
            if (sync && !isAdmin(request)) return response.sendStatus(403);
            response.status(202).json(await startJob(user, workerId, source, {sync_copyparty:sync}));
        } catch { response.status(400).json({ error: '无法导入。请检查所选节点、链接类型与链接权限；支持视频直链及 Iwara、B站公开播放页。' }); }
    });
    router.get('/imports/:id', async (request, response) => {
        try {
            await ready;
            const entry = importJobs.get(request.params.id);
            if (!entry || entry.user !== request.user?.profile?.handle) return response.sendStatus(404);
            if (entry.error) return response.json({ status: 'failed', error: entry.error, worker_id: entry.workerId });
            const job = await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`);
            await completeDirectImport(entry, job);
            response.json({ ...job, worker_id: entry.workerId, video: entry.video });
        } catch { response.status(502).json({ error: '暂时无法读取导入进度，请稍后刷新视频列表。' }); }
    });
    router.post('/prepare', async (request, response) => {
        try {
            await ready;
            if (!request.user?.profile?.handle || !request.user?.directories) return response.sendStatus(401);
            const body = request.body || {};
            if (!allowsModel(config, body.model) || body.chat_completion_source !== 'makersuite'
                || String(body.upstream || '').replace(/\/$/, '') !== config.upstream) {
                return response.status(400).json({ error: '请使用已配置的 Gemini 连接及允许的模型。' });
            }
            const apiKey = typeof body.proxy_password === 'string' && body.proxy_password
                ? body.proxy_password
                : secretModule.readProviderSecret(request, secretModule.SECRET_KEYS.MAKERSUITE);
            response.set('Cache-Control', 'no-store').json(relay.prepare(body.video, apiKey, request.user.profile.handle, body.model));
        } catch (error) {
            response.status(400).json({ error: '无法准备 GCS 视频请求，请检查附件、Gemini 连接和插件状态。' });
        }
    });
    ready = (async () => {
        ({ default: fetchImpl } = await import('node-fetch'));
        secretModule = await import(pathToFileURL(path.join(process.cwd(), 'src/endpoints/secrets.js')).href);
        if (config.credential_file && config.bucket && config.upstream) {
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
                    if (await completeDirectImport(entry, job)) return;
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
