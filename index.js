import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { createVideoAttachment, getTurnVideo, appendVideoMarker } from './media.js';
import { uploadResumable, fileFingerprint } from './upload.js';

const API = '/api/plugins/gcs-video';
let config;
let pending = null;
const context = () => globalThis.Luker.getContext();

async function showVideoManager() {
    const storeKey = `gcs-video-upload:${config.user}`;
    const panel = $('<div class="gcs-video-manager">');
    const fileInput = $('<input type="file" accept="video/*">');
    const duration = $('<input type="number" class="text_pole" min="0.1" step="any" placeholder="视频时长（秒）">');
    const progress = $('<progress max="100" value="0">');
    const status = $('<div role="status">').text('选择视频直接上传到 GCS；中断后重新选择相同文件可以续传。');
    const upload = $('<button type="button" class="menu_button">').text('上传 / 继续');
    const pause = $('<button type="button" class="menu_button">').text('暂停').prop('disabled', true);
    const fresh = $('<button type="button" class="menu_button">').text('放弃续传，重新上传');
    const list = $('<div class="gcs-video-list">');
    const importUrl = $('<input class="text_pole" placeholder="粘贴视频直链、Iwara 或 B站播放页链接">');
    const importWorker = $('<select class="text_pole" aria-label="导入节点">');
    for (const worker of config.import_workers) importWorker.append($('<option>').val(worker.id).text(worker.label));
    importWorker.val(config.default_import_worker);
    const importButton = $('<button type="button" class="menu_button">').text('云端导入');
    const importStatus = $('<div role="status" class="gcs-import-status">');
    let polling = true;
    const more = $('<button type="button" class="menu_button">').text('加载更多').hide();
    let nextPage = '';
    let controller;
    let active = false;
    let selectedFile;
    function loadSaved() { try { return JSON.parse(sessionStorage.getItem(storeKey)); } catch { return null; } }
    if (loadSaved()) status.text('有未完成的上传：重新选择相同文件，然后点击“上传 / 继续”。');
    async function refresh(append = false) {
        const response = await fetch(`${API}/videos${append && nextPage ? `?pageToken=${encodeURIComponent(nextPage)}` : ''}`, { headers: context().getRequestHeaders() });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '读取列表失败。');
        if (!append) list.empty();
        if (!append && !data.items.length) list.append($('<p>').text('还没有通过此账号上传的视频。也可以直接附加已有 gs:// 地址。'));
        for (const video of data.items) {
            $('<div class="gcs-video-list-item">').append(
                $('<strong>').text(video.title),
                $('<small>').text(`${video.storage === 'https' ? 'HTTPS 直链' : 'GCS'} · ${(video.size / 1048576).toFixed(1)} MiB · ${video.duration_seconds ?? '?'} 秒 · ${video.expires ? '到期 ' + new Date(video.expires).toLocaleString() : new Date(video.created).toLocaleString()}`),
                $('<input class="text_pole" readonly>').val(video.url).on('click', function () { this.select(); }),
                $('<div class="flex-container flexGap5">').append(
                    $('<button type="button" class="menu_button">').text('复制地址').on('click', async () => {
                        try { await navigator.clipboard.writeText(video.url); toastr.success('已复制视频地址。'); }
                        catch { const field = list.find('input').filter((_, el) => el.value === video.url).get(0); field?.focus(); field?.select(); document.execCommand('copy'); toastr.info('已选择地址，可按 Ctrl+C 复制。'); }
                    }),
                    $('<button type="button" class="menu_button">').text('附加到本轮').on('click', () => {
                        try { queueVideo(video.url, video.duration_seconds, video.title); toastr.success('已附加，关闭面板后输入问题并发送。'); }
                        catch (error) { toastr.error(error.message); }
                    }),
                ),
            ).appendTo(list);
        }
        nextPage = data.nextPageToken;
        more.toggle(Boolean(nextPage));
    }
    fileInput.on('change', () => {
        selectedFile = fileInput[0].files?.[0];
        if (!selectedFile) return;
        const saved = loadSaved();
        if (saved?.fingerprint === fileFingerprint(selectedFile)) duration.val(saved.video.duration_seconds);
        else {
            duration.val('');
            const candidate = selectedFile;
            const url = URL.createObjectURL(candidate);
            const element = document.createElement('video');
            element.preload = 'metadata';
            const clean = () => { URL.revokeObjectURL(url); element.removeAttribute('src'); };
            element.onloadedmetadata = () => { if (selectedFile === candidate && Number.isFinite(element.duration)) duration.val(Math.ceil(element.duration)); clean(); };
            element.onerror = clean;
            element.src = url;
        }
    });
    pause.on('click', () => controller?.abort());
    fresh.on('click', () => { if (!active) { sessionStorage.removeItem(storeKey); progress.val(0); status.text('下一次上传会创建新的续传会话。'); } });
    upload.on('click', async () => {
        if (active) return;
        if (!selectedFile) { toastr.warning('请先选择视频。'); return; }
        if (selectedFile.size > config.max_upload_bytes) { toastr.error('视频超过 2 GiB 上传上限。'); return; }
        controller = new AbortController();
        active = true;
        upload.prop('disabled', true); pause.prop('disabled', false); fresh.prop('disabled', true); fileInput.prop('disabled', true);
        try {
            let saved = loadSaved();
            if (saved?.fingerprint !== fileFingerprint(selectedFile)) {
                const response = await fetch(`${API}/uploads`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ filename: selectedFile.name, size: selectedFile.size, duration_seconds: Number(duration.val()) }), signal: controller.signal });
                saved = await response.json();
                if (!response.ok) throw new Error(saved.error || '创建上传失败。');
                saved.fingerprint = fileFingerprint(selectedFile);
                sessionStorage.setItem(storeKey, JSON.stringify(saved));
            }
            await uploadResumable(selectedFile, saved.session, { signal: controller.signal, onProgress: (done, total) => {
                progress.val(done / total * 100);
                status.text(`已上传 ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB（${Math.floor(done / total * 100)}%）`);
            } });
            sessionStorage.removeItem(storeKey);
            status.text('上传完成。视频已出现在下方列表，可以复制地址或附加到本轮。');
            await refresh();
        } catch (error) {
            status.text(controller.signal.aborted ? '已暂停。点击“上传 / 继续”恢复；刷新后需要重新选择相同文件。' : error.message);
        } finally {
            active = false; upload.prop('disabled', false); pause.prop('disabled', true); fresh.prop('disabled', false); fileInput.prop('disabled', false);
        }
    });
    const refreshButton = $('<button type="button" class="menu_button">').text('刷新列表').on('click', () => refresh().catch(error => toastr.error(error.message)));
    more.on('click', () => refresh(true).catch(error => toastr.error(error.message)));
    const importKey = `gcs-video-import:${config.user}`;
    async function pollImport(id) {
        let failures = 0;
        importButton.prop('disabled', true);
        try {
            while (polling) {
                let response;
                try { response = await fetch(`${API}/imports/${encodeURIComponent(id)}`, { headers: context().getRequestHeaders() }); } catch { /* Retry status queries, never resubmit the upload. */ }
                if (!response || response.status >= 500 || response.status === 429) {
                    if (++failures >= 6) throw new Error('暂时无法连接导入节点。任务可能仍在运行，请稍后重新打开视频库查询。');
                    importStatus.text(`进度连接暂时中断，正在重试（${failures}/6）；不会重复提交上传。`);
                    await new Promise(resolve => setTimeout(resolve, Math.min(30000, failures * 2000)));
                    continue;
                }
                if (!response.ok) throw new Error('无法读取导入状态，请刷新视频列表。登录失效或服务重启后进度记录可能失效。');
                failures = 0;
                const job = await response.json();
                const state = {queued:'排队中',downloading:'解析 / 下载中',ready:'等待上传',running:'上传 GCS 中',publishing:'保存临时直链中',complete:'完成',failed:'失败'}[job.status] || job.status;
                importStatus.text(`导入节点 ${job.worker_id}：${state} · ${(job.done / 1048576).toFixed(1)} / ${(job.total / 1048576).toFixed(1)} MiB`);
                if (job.status === 'complete') { sessionStorage.removeItem(importKey); importStatus.text('导入完成，可以从下方列表附加。'); await refresh(); break; }
                if (job.status === 'failed') { sessionStorage.removeItem(importKey); throw new Error(job.error || '云端导入失败，请检查链接后重试。'); }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) { importStatus.text(error.message); }
        finally { importButton.prop('disabled', false); }
    }
    importButton.on('click', async () => {
        importButton.prop('disabled', true);
        importStatus.text('正在海外检查文件并创建导入任务……');
        try {
            const response = await fetch(`${API}/imports`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ source_url: importUrl.val(), worker_id: importWorker.val() }) });
            const job = await response.json();
            if (!response.ok) throw new Error(job.error || '导入失败。');
            sessionStorage.setItem(importKey, job.id);
            importUrl.val('');
            await pollImport(job.id);
        } catch (error) { importStatus.text(error.message); importButton.prop('disabled', false); }
    });
    panel.append($('<h3>').text('视频库'), $('<p>').text('视频仅在自己的账号列表展示。直链与 GCS 的保留时间由部署配置决定。关闭面板会暂停浏览器上传，云端任务继续。'), fileInput, duration,
        $('<div class="flex-container flexGap5">').append(upload, pause, fresh), progress, status,
        $('<hr>'), $('<h4>').text('从链接云端导入'), $('<p>').text('所选节点支持公网 HTTPS 视频直链及 Iwara、B站公开播放页；小视频保留直链，大视频上传 GCS。自动识别链接类型和视频时长，无需本地下载。登录限制会报告失败；关闭面板后任务继续。'),
        importUrl, $('<label>').text('导入节点').append(importWorker), importButton, importStatus, refreshButton, list, more);
    refresh().catch(error => status.text(error.message));
    const importId = sessionStorage.getItem(importKey);
    if (importId) pollImport(importId);
    await new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: '关闭' }).show();
    polling = false;
    controller?.abort();
}

function renderPending() {
    $('#gcs-video-pending').remove();
    if (!pending) return;
    $('<div id="gcs-video-pending" class="gcs-video-badge">').append(
        $('<span>').text(`${pending.title} · ${pending.duration_seconds} 秒 · 仅本轮`),
        $('<button type="button" class="menu_button">').text('取消附件').on('click', () => { pending = null; renderPending(); }),
    ).insertBefore('#nonQRFormItems');
}

function queueVideo(url, duration, title) {
    const video = createVideoAttachment(url, duration);
    if (video.url.startsWith('gs://')) {
        if (!video.url.startsWith(`gs://${config.bucket}/`)) throw new Error('请使用配置的 GCS Bucket。');
    } else if (!config.direct_media_origins.includes(new URL(video.url).origin)) throw new Error('此直链来源尚未配置，请先云端导入。');
    if (title) video.title = String(title).slice(0, 180);
    pending = video;
    renderPending();
    $('#send_textarea').trigger('focus');
}

async function showAttachDialog() {
    const form = $('<div class="gcs-video-dialog">').append(
        $('<h3>').text('添加视频链接（仅本轮）'),
        $('<p>').text(`沿用 已配置的 Gemini 连接，选择 ${config.model} 模型。附加后在输入框中填写问题并发送。`),
        $('<label>').text('GCS 地址或 HTTPS 视频直链').append($('<input class="text_pole" name="uri">').attr('placeholder', `gs://${config.bucket}/videos/video.mp4`).val(pending?.url ?? '')),
        $('<label>').text('时长（秒，用于估算上下文占用）').append($('<input class="text_pole" name="duration" type="number" min="0.1" step="any">').val(pending?.duration_seconds ?? '')),
        $('<p>').text('后续用户消息不再发送此视频；重新生成本轮回答会再次发送。文件删除后可继续基于已有文字回答聊天，需要重看时重新上传并附加。'),
    );
    while (await new Popup(form, POPUP_TYPE.CONFIRM, '', { okButton: '附加', cancelButton: '取消' }).show() === POPUP_RESULT.AFFIRMATIVE) {
        try { queueVideo(form.find('[name=uri]').val(), form.find('[name=duration]').val()); return; }
        catch (error) { toastr.error(error.message); }
    }
}

function renderMessage(index) {
    const ctx = context();
    const video = ctx.chat[index]?.extra?.gcs_video;
    const message = $(`.mes[mesid="${Number(index)}"]`);
    message.find('.gcs-video-message').remove();
    if (!video) return;
    $('<div class="gcs-video-message gcs-video-badge">').append(
        $('<span>').text(`${video.title} · ${video.duration_seconds} 秒 · 视频仅本轮`),
        $('<button type="button" class="menu_button">').text('再次附加').on('click', () => {
            try { queueVideo(video.url, video.duration_seconds, video.title); }
            catch (error) { toastr.error(error.message); }
        }),
    ).insertAfter(message.find('.mes_text').first());
}

async function captureUserMessage(index) {
    if (!pending) return;
    const ctx = context();
    const message = ctx.chat[index];
    if (!message?.is_user) return;
    try {
        await ctx.updateMessages({ index: Number(index), patch: { extra: { ...structuredClone(message.extra ?? {}), gcs_video: pending } } });
        pending = null;
        renderPending();
        renderMessage(index);
    } catch (error) {
        ctx.stopGeneration();
        toastr.error('视频附件未能保存，已停止生成。请重试。');
    }
}

async function prepareRequest(data) {
    const ctx = context();
    const video = getTurnVideo(ctx.chat);
    if (!video) return;
    try {
        const upstream = String(data.reverse_proxy || data.base_url || '').replace(/\/$/, '');
        if (data.chat_completion_source !== 'makersuite' || data.model !== config.model || upstream !== config.upstream) {
            throw new Error(`本轮含 GCS 视频，请选择 已配置的 Gemini 连接和 ${config.model} 模型。`);
        }
        const response = await fetch(`${API}/prepare`, {
            method: 'POST', headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ video, upstream, model: data.model, chat_completion_source: data.chat_completion_source,
                proxy_password: data.proxy_password, secret_id: data.secret_id || data.secretId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '无法准备 GCS 视频请求。');
        data.messages = appendVideoMarker(data.messages, result.marker);
        data.reverse_proxy = result.reverse_proxy;
        data.base_url = result.reverse_proxy;
        data.proxy_password = result.proxy_password;
    } catch (error) {
        // Event buses may swallow listener exceptions: also prevent an unmodified request from being sent.
        data.model = '';
        ctx.stopGeneration();
        toastr.error(error.message);
        throw error;
    }
}

jQuery(async () => {
    try {
        const response = await fetch(`${API}/config`, { headers: context().getRequestHeaders() });
        if (!response.ok) throw new Error('GCS 视频后端插件不可用。');
        config = await response.json();
        const ctx = context();
        $('<div class="list-group-item flex-container flexGap5" id="gcs-video-attach">').append(
            $('<div class="fa-fw fa-solid fa-video extensionsMenuExtensionButton">'),
            $('<span>').text('添加视频链接（仅本轮）'),
        ).on('click', showAttachDialog).appendTo('#attach_file_wand_container');
        $('<div class="list-group-item flex-container flexGap5" id="gcs-video-library">').append(
            $('<div class="fa-fw fa-solid fa-cloud-arrow-up extensionsMenuExtensionButton">'),
            $('<span>').text('视频库：上传与管理'),
        ).on('click', showVideoManager).appendTo('#attach_file_wand_container');
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_SENT, captureUserMessage);
        for (const event of [ctx.eventTypes.USER_MESSAGE_RENDERED, ctx.eventTypes.MESSAGE_UPDATED]) {
            ctx.eventSource.on(event, renderMessage);
        }
        ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
            pending = null;
            renderPending();
            context().chat.forEach((_, index) => renderMessage(index));
        });
        ctx.eventSource.on(ctx.eventTypes.GENERATION_CONTEXT_READY, payload => {
            const video = getTurnVideo(context().chat);
            if (!video || !Number.isFinite(payload.maxContext)) return;
            const reserve = Math.ceil(video.duration_seconds * 300);
            if (payload.maxContext - reserve < 1024) {
                if (!payload.dryRun) { context().stopGeneration(); toastr.error('视频估算占用超过当前上下文预算，请调整上下文长度或缩短视频。'); }
                return;
            }
            payload.maxContext -= reserve;
        });
        ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY, prepareRequest);
        ctx.registerExtensionApi('gcs-video', { attach: queueVideo });
        ctx.chat.forEach((_, index) => renderMessage(index));
    } catch (error) { toastr.error(error.message); }
});
