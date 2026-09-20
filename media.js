/** GCS video references are stored with chat media, never fetched by the browser. */
const VIDEO_MIME_TYPES = {
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mpeg: 'video/mpeg', mpg: 'video/mpeg', avi: 'video/avi',
    wmv: 'video/wmv', '3gp': 'video/3gpp', flv: 'video/x-flv',
};

/** Validate without changing the object name: GCS object names are case sensitive. */
export function getVideoMimeType(value) {
    if (typeof value !== 'string' || /[\r\n\x00-\x1f]/.test(value)) throw new Error('视频地址无效。');
    let pathname;
    if (value.startsWith('gs://')) {
        if (!/^gs:\/\/[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]\/[^?#]+$/.test(value)) throw new Error('GCS 地址无效。');
        pathname = value;
    } else {
        const parsed = new URL(value);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) throw new Error('直链必须为不含登录凭据的 HTTPS 地址。');
        pathname = parsed.pathname;
    }
    const extension = pathname.slice(pathname.lastIndexOf('.') + 1).toLowerCase();
    const mimeType = VIDEO_MIME_TYPES[extension];
    if (!mimeType) throw new Error('视频地址需包含受支持的文件扩展名；播放页请先云端导入。');
    return mimeType;
}

export function createVideoAttachment(value, duration) {
    const url = String(value ?? '').trim();
    const mimeType = getVideoMimeType(url);
    const durationSeconds = duration == null || duration === '' ? null : Number(duration);
    if (durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds <= 0)) {
        throw new Error('视频时长需大于 0；未知时可留空。');
    }
    return {
        url, type: 'video', title: url.startsWith('https://') ? decodeURIComponent(new URL(url).pathname.split('/').pop()) : url.slice(url.lastIndexOf('/') + 1),
        mime_type: mimeType, duration_seconds: durationSeconds, send_scope: 'turn',
    };
}

/** A new user message ends the previous video's scope, even if it is hidden. */
export function getTurnVideo(chat) {
    const message = chat.findLast(entry => entry.is_user);
    return message && !message.is_system ? message.extra?.gcs_video ?? null : null;
}

/** Operate on the outgoing copy only; never store a relay marker in chat history. */
export function appendVideoMarker(messages, marker) {
    const copy = structuredClone(messages);
    const message = copy.findLast(entry => entry.role === 'user');
    if (!message) throw new Error('本次请求中没有用户消息，无法附加视频。');
    const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: String(message.content ?? '') }];
    message.content = [...content, { type: 'text', text: marker }];
    return copy;
}

/** An empty administrator list allows the currently selected Gemini model. */
export function isAllowedVideoModel(models, model) {
    return typeof model === 'string' && /^[a-zA-Z0-9._-]{1,180}$/.test(model) && (!models.length || models.includes(model));
}
