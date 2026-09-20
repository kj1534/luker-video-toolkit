import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, randomUUID } from 'node:crypto';

export const defaults = { upstream: '', model: '', bucket: '', port: 18779, prepare_ttl_ms: 120000, request_timeout_ms: 300000, max_upload_bytes: 2147483648, https_max_bytes: 14000000, direct_media_origins: [], default_import_worker: '', import_workers: [] };
export function isAdmin(request) { return request.user?.profile?.admin === true; }
export function loadConfig(file) { return fs.existsSync(file) ? { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) } : structuredClone(defaults); }
export function visibleSettings(config) {
    return { upstream: config.upstream, model: config.model, bucket: config.bucket,
        max_upload_bytes: config.max_upload_bytes, https_max_bytes: config.https_max_bytes,
        direct_media_origins: config.direct_media_origins, default_import_worker: config.default_import_worker,
        credential_configured: Boolean(config.credential_file && fs.existsSync(config.credential_file)),
        import_workers: config.import_workers.map(({ id, label, url, token_file }) => ({ id, label, url, token_configured: Boolean(token_file && fs.existsSync(token_file)) })) };
}
function https(value, label, originOnly = false) {
    let url;
    try { url = new URL(String(value).trim()); } catch { throw new Error(`${label}不是有效地址。`); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (originOnly && url.pathname !== '/')) throw new Error(`${label}需使用不含密码、参数的 HTTPS 地址。`);
    return originOnly ? url.origin : url.href.replace(/\/$/, '');
}
function integer(value, min, max, label) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}超出允许范围。`); return value; }

/** Validate the entire form before touching disk. Never accept paths from a browser. */
export function prepareSettings(input, previous, directory) {
    const writes = [];
    const config = { ...previous };
    config.upstream = https(input.upstream, '模型接口');
    config.model = String(input.model || '').trim();
    if (!/^[a-zA-Z0-9._-]{1,180}$/.test(config.model)) throw new Error('请输入有效模型 ID。');
    config.bucket = String(input.bucket || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(config.bucket)) throw new Error('请输入 GCS 桶名称，不含 gs://。');
    config.max_upload_bytes = integer(input.max_upload_bytes, 1, 2147483648, '上传大小');
    config.https_max_bytes = integer(input.https_max_bytes, 1, 15000000, '直链大小');
    if (!Array.isArray(input.direct_media_origins) || input.direct_media_origins.length > 50) throw new Error('直链来源列表无效。');
    config.direct_media_origins = [...new Set(input.direct_media_origins.map(value => https(value, '直链来源', true)))];
    if (input.credential_json) {
        if (Buffer.byteLength(JSON.stringify(input.credential_json)) > 65536) throw new Error('服务账号 JSON 不能超过 64 KiB。');
        let key;
        try {
            key = typeof input.credential_json === 'string' ? JSON.parse(input.credential_json) : input.credential_json;
            if (key.type !== 'service_account' || !key.client_email?.endsWith('.iam.gserviceaccount.com') || !key.project_id || createPrivateKey(key.private_key).asymmetricKeyType !== 'rsa') throw Error();
        } catch { throw new Error('服务账号 JSON 无效，请选择 Google 导出的密钥文件。'); }
        config.credential_file = path.join(directory, 'credentials', randomUUID() + '.json');
        writes.push([config.credential_file, JSON.stringify(key)]);
    } else if (!config.credential_file || !fs.existsSync(config.credential_file)) throw new Error('请上传服务账号 JSON。');
    if (!Array.isArray(input.import_workers) || input.import_workers.length > 20) throw new Error('节点列表无效。');
    const ids = new Set();
    config.import_workers = input.import_workers.map(item => {
        const id = String(item.id || '').trim();
        if (!/^[a-z0-9-]{1,48}$/.test(id) || ids.has(id)) throw new Error('节点 ID 只能包含小写字母、数字、短横线，且不能重复。');
        ids.add(id);
        const label = String(item.label || '').trim();
        if (!label || label.length > 80) throw new Error('请输入节点名称。');
        const worker = { id, label, url: https(item.url, '节点接口'), token_file: previous.import_workers.find(old => old.id === id)?.token_file };
        const token = String(item.token || '').trim();
        if (token) {
            if (token.length < 24 || token.length > 4096 || /\s/.test(token)) throw new Error('节点令牌至少 24 个字符，不能含空白。');
            worker.token_file = path.join(directory, 'credentials', randomUUID() + '.token');
            writes.push([worker.token_file, token + '\n']);
        } else if (!worker.token_file || !fs.existsSync(worker.token_file)) throw new Error(`请填写节点 ${label} 的令牌。`);
        return worker;
    });
    config.default_import_worker = input.default_import_worker || '';
    if (ids.size ? !ids.has(config.default_import_worker) : Boolean(config.default_import_worker)) throw new Error('请选择有效的默认节点。');
    return { config, writes };
}
export function commitSettings(file, prepared) {
    const created = [];
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        for (const [target, data] of prepared.writes) {
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
            fs.writeFileSync(target, data, { mode: 0o600, flag: 'wx' }); created.push(target);
        }
        fs.writeFileSync(temporary, JSON.stringify(prepared.config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } catch (error) {
        for (const target of [...created, temporary]) fs.rmSync(target, { force: true });
        throw error;
    }
}
