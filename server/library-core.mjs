import fs from 'node:fs';
import path from 'node:path';
import { validateVideo } from './relay.mjs';
import { createStorage } from './storage.mjs';
import { createImportWorkers } from './workers.mjs';
import { registerFileLibrary, fileCopyKey } from './file-library.mjs';
import { fileInfo } from '../media.js';
import { loadConfig, visibleSettings, prepareSettings, commitSettings, isAdmin, allowsModel } from './settings.mjs';

export function createLibrary(router, configFile, fetchImpl = globalThis.fetch) {
const config = loadConfig(configFile);
const copyFile = path.resolve(path.dirname(configFile), 'file-copies.json');
const catalogFile = path.resolve(path.dirname(configFile), 'direct-videos.json');
let ready;
let storage;
const importTokens = new Map();
let importPoller;
const jobsFile = path.join(path.dirname(configFile), 'jobs.json');
const importJobs = new Map(fs.existsSync(jobsFile) ? JSON.parse(fs.readFileSync(jobsFile, 'utf8')) : []);
for (const entry of importJobs.values()) delete entry.busy;
function persist() { fs.writeFileSync(jobsFile+'.tmp', JSON.stringify([...importJobs].map(([id, entry])=>[id,{...entry,busy:false}])),{mode:0o600}); fs.renameSync(jobsFile+'.tmp',jobsFile); }

let workers = createImportWorkers(config);
let saving = false;

async function worker(workerId, route, body) {
    const response = await fetchImpl(workers.get(workerId).url + route, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${importTokens.get(workerId)}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw Object.assign(new Error('节点请求失败。'),{status:response.status});
    return response.json();
}


async function completeDirectImport(entry, job) {

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
        if (!entry.originGcs && !entry.localUpload && fileInfo(job.video.url).attachable) validateVideo(job.video, config);
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

const pendingStarts=new Map();
async function startJob(user, workerId, source, options = {}) {
    const key=user+':'+(options.copyKey||options.copyLinkKey||'');
    const dedupe=Boolean(options.copyKey||options.copyLinkKey);
    if(dedupe&&pendingStarts.has(key))return pendingStarts.get(key);
    const perform=async()=>{
    if (options.copyKey || options.copyLinkKey) for (const [id, entry] of importJobs) {
        if (entry.user === user && (entry.copyKey || entry.copyLinkKey) === (options.copyKey || options.copyLinkKey) && !entry.finished && !entry.error) return {id, worker_id:entry.workerId};
    }
    const {copyKey, originGcs, copyVolume, copyWorker, copyLinkKey, ...body} = options;
    const job = await worker(workerId, '/jobs', { source_url:source, ...body });
    const id = `${workerId}:${job.id}`;
    importJobs.set(id, {user, workerId, remoteId:job.id, created:Date.now(), copyKey, originGcs, copyVolume, copyWorker, copyLinkKey});
    persist();
    return {id, worker_id:workerId};
    };
    const pending=perform();if(dedupe)pendingStarts.set(key,pending);
    try{return await pending;}finally{if(dedupe)pendingStarts.delete(key);}

}


    registerFileLibrary(router, {config, worker, storage:()=>storage, startJob, catalog:readDirectVideos, copyFile, forgetCatalog});
    router.get('/config', async (request, response) => {
        try {
            await ready;
            const availableNodes=await Promise.all(workers.publicList.map(async node=>{try{const h=await worker(node.id,'/healthz');return {...node,online:true,sites:h.capabilities.available_sites,private_gcs_read:h.capabilities.private_gcs_read};}catch{return {...node,online:false};}}));
            response.json({ configured: Boolean(storage), admin: isAdmin(request), models: config.models, bucket: config.bucket, upstream: config.upstream, scope: 'turn', management: !request.pluginToken, app_url: config.public_url, max_upload_bytes: config.max_upload_bytes, user: request.user?.profile?.handle, https_max_bytes: config.https_max_bytes, direct_media_origins: config.direct_media_origins, import_workers: availableNodes, default_import_worker: config.default_import_worker, local_upload_available: isAdmin(request) && Boolean(config.copyparty_worker && config.copyparty_volume), copyparty_label: config.import_workers.find(item=>item.id===config.copyparty_worker)?.label || 'copyparty' });
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
                if (!['complete', 'failed', 'cancelled', 'expired'].includes(job.status)) return response.status(409).json({ error: '请等待当前导入完成后再修改配置。' });
                entry.finished = true;
            }
            let prepared;
            try { prepared = prepareSettings(request.body, config, path.dirname(configFile)); }
            catch (error) { return response.status(400).json({ error: error.message }); }
            for (const node of prepared.config.import_workers) if(config.import_workers.some(old=>old.id===node.id)) await worker(node.id,'/settings',{max_bytes:prepared.config.max_upload_bytes,https_max_bytes:prepared.config.https_max_bytes});
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
    router.post('/local-uploads', async (request,response)=>{
        try {
            await ready;
            if (!isAdmin(request)) return response.sendStatus(403);
            const node=workers.get(config.copyparty_worker);
            if (!node.library_enabled) throw new Error('请配置可管理的 copyparty 上传节点。');
            const body=request.body || {};
            const result=await worker(node.id,'/local-uploads',{filename:body.filename,size:body.size,mime_type:fileInfo(body.filename).mime_type,origin:(request.headers.origin || request.clientOrigin),mode:body.mode,threshold:config.https_max_bytes,volume:config.copyparty_volume});
            const id=`${node.id}:${result.id}`;
            importJobs.set(id,{user:request.user.profile.handle,workerId:node.id,remoteId:result.id,created:Date.now(),localUpload:true});
            persist();
            response.set('Cache-Control','no-store').json({id,session:node.url+'/upload-data/'+result.ticket,chunk_size:result.chunk_size,size:body.size});
        } catch {response.status(400).json({error:'无法创建 copyparty 上传会话，请检查节点与存储配置。'});}
    });
    router.post('/local-uploads/finish', async (request,response)=>{
        try {
            if (!isAdmin(request)) return response.sendStatus(403);
            const entry=importJobs.get(request.body?.id);
            if (!entry || entry.user!==request.user.profile.handle) return response.sendStatus(404);
            await worker(entry.workerId,`/local-uploads/${entry.remoteId}/finish`,{});
            response.json({job:{id:request.body.id,worker_id:entry.workerId}});
        } catch {response.status(400).json({error:'文件尚未完整上传或会话已过期，请继续上传或重新开始。'});}
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
            response.status(202).json(await startJob(user, workerId, source, {sync_copyparty:sync, ...(isAdmin(request)?{}:{destination:'gcs'})}));
        } catch { response.status(400).json({ error: '无法导入。请检查所选节点、链接类型与链接权限；支持视频直链及 Iwara、B站、YouTube 公开播放页和 HTTPS 短链接。' }); }
    });
    router.get('/imports/:id', async (request, response) => {
        try {
            await ready;
            const entry = importJobs.get(request.params.id);
            if (!entry || entry.user !== request.user?.profile?.handle) return response.sendStatus(404);
            if (entry.error) return response.json({ status: entry.status || 'failed', error: entry.error, worker_id: entry.workerId });
            const job = await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`);
            entry.status=job.status;
            await completeDirectImport(entry, job);
            response.json({ ...job, worker_id: entry.workerId, video: entry.video });
        } catch { response.status(502).json({ error: '暂时无法读取导入进度，请稍后刷新视频列表。' }); }
    });
    router.post('/authorize', async (request, response) => {
        try {
            const video = validateVideo(request.body?.video, config);
            const user = request.user.profile.handle;
            if (video.url.startsWith('gs://')) await storage.stat(video.url,user);
            else if (!readDirectVideos(user).some(item=>item.url===video.url) && !isAdmin(request)) throw Error();
            response.json({ok:true});
        } catch { response.status(403).json({error:'此附件不属于当前账号或未获授权。'}); }
    });
    router.get('/tasks', (request,response)=>response.json({items:[...importJobs].filter(([,e])=>e.user===request.user.profile.handle).map(([id,e])=>({id,worker_id:e.workerId,created:e.created,status:e.status || (e.finished?'complete':'queued'),error:e.error,video:e.video})).reverse()}));
    router.post('/tasks/:id/cancel', async (request,response)=>{
        const e=importJobs.get(request.params.id);
        if(!e || e.user!==request.user.profile.handle)return response.sendStatus(404);
        try {await worker(e.workerId,`/jobs/${e.remoteId}/cancel`,{}); e.status='cancelled';e.finished=true;persist();response.json({ok:true});}
        catch {response.status(409).json({error:'节点不可用或任务已结束，未确认取消。'});}
    });
    router.post('/tasks/:id/retry', async (request,response)=>{
        const e=importJobs.get(request.params.id);
        if(!e || e.user!==request.user.profile.handle)return response.sendStatus(404);
        try {const job=await worker(e.workerId,`/jobs/${e.remoteId}/retry`,{}); e.remoteId=job.id;delete e.uploadSession;delete e.video;delete e.copyRecorded;e.error=null;e.finished=false;e.submitted=false;e.status='queued';e.created=Date.now();persist();response.json({id:request.params.id});}
        catch {response.status(409).json({error:'无法重试；本地上传票据过期时需重新选择文件上传。'});}
    });
    ready = (async () => {
        if (config.credential_file && config.bucket && config.upstream) {
            try { storage = createStorage(config, fetchImpl); } catch { console.warn('[Video Toolkit] Configure storage in the administrator settings.'); }
        }
        for (const item of config.import_workers) { try { importTokens.set(item.id, fs.readFileSync(item.token_file, 'utf8').trim()); } catch {} }
        async function poll(entry) {
            if(entry.busy || entry.finished || entry.error) return;
            entry.busy=true;
            try {
                const job=await worker(entry.workerId, `/jobs/${encodeURIComponent(entry.remoteId)}`);
                entry.status=job.status;entry.failures=0;
                await completeDirectImport(entry,job);
                if(job.status==='complete')entry.finished=true;
                if(['failed','expired','cancelled'].includes(job.status)) {entry.error=job.error;entry.finished=true;return;}
                if(job.status==='ready') {
                    if(!entry.uploadSession) {const upload=await storage.startUpload(job.metadata,entry.user);entry.video=upload.video;entry.uploadSession=upload.session;persist();}
                    await worker(entry.workerId,`/jobs/${entry.remoteId}/upload`,{session:entry.uploadSession});
                }
            } catch(error) {
                entry.failures=(entry.failures||0)+1;
                entry.status='disconnected';
                if(error.status===404) {entry.status='expired';entry.finished=true;entry.error='节点已无此任务。请重新导入；本地上传需重新选择文件。';}
                else if(entry.created<Date.now()-7*86400000) {entry.status='expired';entry.finished=true;entry.error='任务超过七天仍无法确认，请检查节点。';}
            } finally {entry.busy=false;persist();}
        }
        importPoller=setInterval(()=>{for(const entry of importJobs.values())void poll(entry);},2000);
        importPoller.unref();
    })();
    return {config, ready, worker, storage:()=>storage, close(){clearInterval(importPoller);persist();}};
}
