import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { createVideoAttachment, getTurnVideo, appendVideoMarker, isAllowedVideoModel, fileInfo } from './media.js';
import { showLibrary } from './library-ui.js';

const API = '/api/plugins/gcs-video';
let config;
let pending = null;
const context = () => globalThis.Luker.getContext();
const durationLabel = value => value > 0 ? `${Math.round(value)} 秒` : '时长未知';

async function connectLibrary() {
    const state=await (await fetch(API+'/connection',{headers:context().getRequestHeaders()})).json();
    const token=$('<input type="password" class="text_pole" autocomplete="off" placeholder="在此粘贴在文件库生成的访问令牌">');
    const body=$('<div>').append(
        $('<h3>').text('连接文件库服务'),
        $('<p class="gcs-muted" style="margin:6px 0 12px;">').append('请先前往 ', $('<a target="_blank" rel="noopener noreferrer" style="color:#059669;font-weight:600;">').attr('href',state.app_url).text('独立文件库管理页面'), '，登录管理员或个人账号并签发专属访问令牌。'),
        $('<label>').text('插件访问令牌').append(token)
    );
    if(await new Popup(body,POPUP_TYPE.CONFIRM,'',{okButton:'确认连接',cancelButton:'取消'}).show()!==POPUP_RESULT.AFFIRMATIVE)return false;
    const response=await fetch(API+'/connection',{method:'POST',headers:context().getRequestHeaders(),body:JSON.stringify({token:token.val()})});
    token.val('');const data=await response.json();if(!response.ok)throw Error(data.error || '连接失败。');
    toastr.success('已成功连接独立文件库。');return true;
}
async function showVideoManager() {
    const response=await fetch(API+'/config',{headers:context().getRequestHeaders()});
    if(!response.ok){
        if(response.status!==401||!await connectLibrary())return;
        return showVideoManager();
    }
    config=await response.json();
    return showLibrary({API,context,Popup,POPUP_TYPE,POPUP_RESULT,queueVideo,getPending:()=>pending,onAttachLink:()=>showAttachDialog().catch(error=>toastr.error(error.message)),onConnect:()=>connectLibrary().catch(error=>toastr.error(error.message))});
}

const paperclipSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:5px;flex-shrink:0;"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 17.96 8.8l-8.58 8.57a2 2 0 0 1-2.83-2.83l7.87-7.87"/></svg>';

function renderPending() {
    $('#gcs-video-pending').remove();
    if (!pending) return;
    $('<div id="gcs-video-pending" class="gcs-video-badge">').append(
        $('<span>').append($(paperclipSvg), `${pending.title} · ${['video','audio'].includes(pending.type)?durationLabel(pending.duration_seconds):pending.type.toUpperCase()} · 仅本轮有效`),
        $('<button type="button" class="menu_button danger">').text('移除附件').on('click', () => { pending = null; renderPending(); }),
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
    config=await(await fetch(API+'/config',{headers:context().getRequestHeaders()})).json();
    const uri = $('<input class="text_pole" name="uri" placeholder="gs://… 或 https://…">').val(pending?.url ?? '');
    const duration = $('<input class="text_pole" name="duration" type="number" min="0.1" step="any" placeholder="自动读取，未知可留空">').val(pending?.duration_seconds ?? '');
    const hint = $('<p role="status">').text('时长仅用于估算上下文，不是 Gemini 读取视频的必填参数。');
    let lookup;
    let timer;
    async function detectDuration() {
        lookup?.abort(); lookup = new AbortController(); const signal = lookup.signal;
        const value = String(uri.val()).trim(); if (!value) return;
        hint.text('正在读取视频时长…');
        try {
            if (!['video','audio'].includes(fileInfo(value).type)) {hint.text('此类型无需填写时长。'); return;}
            const response = await fetch(`${API}/metadata`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({url:value}), signal });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || '未能读取时长。');
            let seconds = data.duration_seconds;
            if (!(seconds > 0) && value.startsWith('https://')) {
                seconds = await new Promise(resolve => {
                    const video = document.createElement('video'); let done = false;
                    const finish = result => { if (done) return; done = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); video.removeAttribute('src'); video.load(); resolve(result); };
                    const abort = () => finish(null);
                    const timeout = setTimeout(() => finish(null), 12000);
                    signal.addEventListener('abort', abort, {once:true});
                    video.preload = 'metadata'; video.onloadedmetadata = () => finish(Number.isFinite(video.duration) ? video.duration : null); video.onerror = () => finish(null);
                    if (signal.aborted) return finish(null); video.src = value;
                });
            }
            if (signal.aborted || String(uri.val()).trim() !== value) return;
            if (seconds > 0) { if (!duration.val()) duration.val(Math.round(seconds * 10) / 10); hint.text('已读取时长，可按需修正。'); }
            else hint.text('未获取到时长，仍可留空附加；届时不提前估算视频上下文。');
        } catch (error) { if (!signal.aborted) hint.text(error.message + ' 时长可留空。'); }
    }
    uri.on('input', () => { duration.val(''); lookup?.abort(); clearTimeout(timer); timer = setTimeout(detectDuration, 500); });
    const detect = $('<button type="button" class="menu_button">').text('自动获取媒体时长').on('click', detectDuration);
    const form = $('<div class="gcs-video-dialog">').append(
        $('<h3>').text('通过链接直接附加文件'),
        $('<p class="gcs-muted">').text('将外部媒体直链或云端 GCS 存储地址直接作为附件引入当前轮次对话。'),
        $('<label>').text('媒体文件链接 (gs:// 或 HTTPS 直链)').append(uri),
        $('<label>').text('媒体时长（秒，可选）').append(duration), detect, hint,
        $('<p class="gcs-muted" style="margin-top:8px;">').text('提示：此附件仅在当前轮次会话中生效，下一轮对话不会自动延续。'),
    );
    if (uri.val() && !duration.val()) detectDuration();
    try {
        while (await new Popup(form, POPUP_TYPE.CONFIRM, '', { okButton: '确认附加到本轮', cancelButton: '取消' }).show() === POPUP_RESULT.AFFIRMATIVE) {
            try { queueVideo(uri.val(), duration.val(), undefined); return; }
            catch (error) { toastr.error(error.message); }
        }
    } finally { lookup?.abort(); clearTimeout(timer); }
}

function renderMessage(index) {
    const ctx = context();
    const video = ctx.chat[index]?.extra?.gcs_video;
    const message = $(`.mes[mesid="${Number(index)}"]`);
    message.find('.gcs-video-message').remove();
    if (!video) return;
    $('<div class="gcs-video-message gcs-video-badge">').append(
        $('<span>').append($(paperclipSvg), `${video.title} · ${['video','audio'].includes(video.type)?durationLabel(video.duration_seconds):video.type.toUpperCase()} · 文件仅本轮`),
        $('<button type="button" class="menu_button gcs-primary">').text('再次附加').on('click', () => {
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
        toastr.error('文件附件未能保存，已停止生成。请重试。');
    }
}

async function prepareRequest(data) {
    const ctx = context();
    const video = getTurnVideo(ctx.chat);
    if (!video) return;
    try {
        const upstream = String(data.reverse_proxy || data.base_url || '').replace(/\/$/, '');
        if (data.chat_completion_source !== 'makersuite' || !isAllowedVideoModel(config.models, data.model) || upstream !== config.upstream) {
            throw new Error('本轮含文件，请使用设置中允许的 Gemini 连接与模型。');
        }
        const response = await fetch(`${API}/prepare`, {
            method: 'POST', headers: ctx.getRequestHeaders(),
            body: JSON.stringify({ video, upstream, model: data.model, chat_completion_source: data.chat_completion_source,
                proxy_password: data.proxy_password, secret_id: data.secret_id || data.secretId }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '无法准备文件请求。');
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
        config = response.ok ? await response.json() : {models:[],direct_media_origins:[]};
        const ctx = context();
        $('<div class="list-group-item flex-container flexGap5" id="gcs-video-library">').append(
            $('<div class="fa-fw fa-solid fa-cloud-arrow-up extensionsMenuExtensionButton">'),
            $('<span>').text('文件库'),
        ).on('click', () => showVideoManager().catch(error=>toastr.error(error.message))).appendTo('#attach_file_wand_container');
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
            if (!video || !(video.type === 'video' && video.duration_seconds > 0) || !Number.isFinite(payload.maxContext)) return;
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
