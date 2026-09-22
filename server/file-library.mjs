import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileInfo, createVideoAttachment } from '../media.js';
import { isAdmin } from './settings.mjs';

export function fileCopyKey(user, file, destination = 'gcs', target = {}) {
    return createHash('sha256').update(JSON.stringify([user, file.storage, file.worker_id, file.volume, file.path || file.url, file.size, file.generation || file.modified, [destination, target.worker_id, target.volume]])).digest('hex');
}

export function registerFileLibrary(router, dependencies) {
    const { config, worker, storage, startJob, catalog, copyFile, forgetCatalog } = dependencies;
    const enrich = item => ({ ...item, ...fileInfo(item.title || item.url) });
    const sharedWorker = (request, id) => {
        if (!isAdmin(request)) throw Object.assign(new Error('共享目录仅管理员可管理。'), {status:403});
        if (!config.import_workers.some(item => item.id === id && item.library_enabled)) throw new Error('该节点未启用共享文件库。');
        return id;
    };
    const endpoint = handler => async (request, response) => {
        if (!request.user?.profile?.handle) return response.sendStatus(401);
        response.set('Cache-Control', 'no-store');
        try { response.json(await handler(request)); }
        catch (error) { response.status(error.status || 400).json({ error: error.message || '文件操作失败。' }); }
    };
    async function sources(request) {
        const items = [{ storage: 'gcs', id: 'gcs', label: '我的 GCS' }];
        const errors = [];
        if (isAdmin(request)) for (const node of config.import_workers.filter(item => item.library_enabled)) {
            try {
                const result = await worker(node.id, '/library/roots');
                for (const volume of result.volumes) items.push({ storage: 'copyparty', id: `${node.id}:${volume.id}`, worker_id: node.id, volume: volume.id, public_url: volume.public_url, label: `${node.label} / ${volume.label}` });
            } catch { errors.push(`${node.label} 暂时不可用`); }
        }
        return { items, errors };
    }
    async function resolve(request, ref) {
        const user = request.user.profile.handle;
        if (ref.storage === 'gcs') return enrich(await storage().stat(ref.url, user));
        if (ref.storage === 'copyparty') {
            sharedWorker(request, ref.worker_id);
            return enrich({ ...await worker(ref.worker_id, '/library/file', { volume: ref.volume, path: ref.path }), worker_id: ref.worker_id });
        }
        if (ref.storage === 'https') {
            const file = catalog(user).find(item => item.url === ref.url);
            if (file) return enrich(file);
        }
        throw new Error('文件来源无效。');
    }
    function readCopies() { return fs.existsSync(copyFile) ? JSON.parse(fs.readFileSync(copyFile, 'utf8')) : {}; }
    async function promote(request, file, destination = 'gcs', target = {}) {
        const user = request.user.profile.handle;
        const key = fileCopyKey(user, file, destination, target);
        if (destination === 'gcs') {
            const existing = readCopies()[key];
            if (existing) { try { return { file: await storage().stat(existing, user), reused: true }; } catch {} }
        }
        let url = file.url;
        let workerId = file.worker_id || config.default_import_worker;
        let copyWorker;
        if (destination === 'copyparty') {
            copyWorker = sharedWorker(request, target.worker_id);
            const cached = readCopies()[key];
            if (cached?.storage === 'copyparty') {
                try {
                    const found = await worker(copyWorker, '/library/file', {volume:target.volume,path:cached.path});
                    if (found.size===cached.size && found.modified===cached.modified) return {file:enrich({...found,worker_id:copyWorker}),reused:true};
                } catch { /* Missing/expired copy is recreated only on this explicit action. */ }
            }
            workerId = config.gcs_read_worker;
            if (!workerId) throw new Error('请先配置 GCS 读取节点。');
            if (file.storage !== 'gcs') throw new Error('请选择 GCS 文件复制到共享目录。');
            url = (await storage().access(file.url, user, true)).url;
        } else if (file.storage === 'gcs') return { file };
        const job = await startJob(user, workerId, url, { destination, volume: target.volume, filename: file.title, copyKey: destination === 'gcs' ? key : undefined, originGcs: destination === 'copyparty' ? file.url : undefined, copyVolume: target.volume, copyWorker, copyLinkKey: destination === 'copyparty' ? key : undefined, gcs_source: destination === 'copyparty' });
        return { job };
    }
    router.get('/file-sources', endpoint(sources));
    router.get('/files', endpoint(async request => {
        const source = String(request.query.storage || 'all');
        const user = request.user.profile.handle;
        if (source === 'copyparty') {
            const id = sharedWorker(request, request.query.worker_id);
            const data = await worker(id, '/library/list', { volume: request.query.volume, path: request.query.path || '' });
            return { ...data, items: data.items.map(item => enrich({ ...item, worker_id: id })), nextPageToken: '', errors: [] };
        }
        if (!['all', 'gcs'].includes(source)) throw new Error('未知存储来源。');
        const result = await storage().list(user, String(request.query.pageToken || ''));
        result.errors = [];
        if (source === 'all' && !request.query.pageToken) {
            const available = await sources(request); result.errors.push(...available.errors);
            const liveRoots = [];
            for (const item of available.items.filter(item => item.storage === 'copyparty')) {
                try {
                    const data = await worker(item.worker_id, '/library/list', { volume: item.volume, path: '' });
                    if (item.public_url) liveRoots.push(item.public_url.replace(/\/?$/, '/'));
                    result.items.push(...data.items.map(file => enrich({ ...file, worker_id: item.worker_id, source_label: item.label })));
                } catch { result.errors.push(`${item.label} 列表暂时不可用`); }
            }
            result.items.push(...catalog(user).filter(file=>!liveRoots.some(root=>file.url.startsWith(root))).map(item=>enrich({...item,source_label:'已记录直链'})));
        }
        // A previously imported direct reference may also appear in a live copyparty listing.
        const unique = new Map();
        for (const item of result.items) if (!unique.has(item.url) || item.storage === 'copyparty') unique.set(item.url, enrich(item));
        result.items = [...unique.values()].sort((a,b) => Number(b.is_directory || false) - Number(a.is_directory || false) || String(b.created).localeCompare(String(a.created)));
        return result;
    }));
    router.post('/file-access', endpoint(async request => {
        const file = await resolve(request, request.body.file || {});
        const download = request.body.download === true;
        if (file.storage === 'gcs') {
            if (!config.copyparty_worker || !config.copyparty_volume) throw new Error('请先配置默认 copyparty 目标。');
            return promote(request,file,'copyparty',{worker_id:config.copyparty_worker,volume:config.copyparty_volume});
        }
        return { file, url: file.url + (download ? (file.url.includes('?') ? '&' : '?') + 'dl' : ''), expires_at: file.expires || null };
    }));
    router.post('/file-delete', endpoint(async request => {
        const ref = request.body.file || {};
        const file = await resolve(request, ref);
        if (file.storage === 'gcs') return storage().remove(file.url, request.user.profile.handle, ref.generation);
        if (file.storage !== 'copyparty') throw new Error('请在共享目录中删除此文件。');
        const result = await worker(file.worker_id, '/library/delete', { volume: file.volume, path: file.path, size: ref.size, modified: ref.modified });
        forgetCatalog(file.url); return result;
    }));
    router.post('/file-transfer', endpoint(async request => {
        const file = await resolve(request, request.body.file || {});
        const destination = request.body.destination;
        if (!['gcs', 'copyparty'].includes(destination)) throw new Error('复制目标无效。');
        return promote(request, file, destination, request.body.target || {});
    }));
    router.post('/file-attach', endpoint(async request => {
        const file = await resolve(request, request.body.file || {});
        if (!file.attachable) throw new Error('此格式可存储和下载，但 Gemini 不支持作为文件附件。');
        const limit = file.type === 'image' ? Math.min(7000000, config.https_max_bytes) : config.https_max_bytes;
        if (file.storage === 'gcs' || file.size <= limit) return { file: { ...file, ...createVideoAttachment(file.url, file.duration_seconds) } };
        return promote(request, file);
    }));
}
