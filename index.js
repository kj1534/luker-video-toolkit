import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { createVideoAttachment, getTurnVideo, appendVideoMarker, isAllowedVideoModel, fileInfo } from './media.js';
import { uploadResumable, uploadToNode, fileFingerprint } from './upload.js';
import { createSettingsPanel } from './settings.js';

const API = '/api/plugins/gcs-video';
let config;
let pending = null;
const context = () => globalThis.Luker.getContext();
const durationLabel = value => value > 0 ? `${Math.round(value)} 秒` : '时长未知';

async function showVideoManager() {
    config = await (await fetch(`${API}/config`, { headers: context().getRequestHeaders() })).json();
    const storeKey = `gcs-video-upload:${config.user}`;
    const panel = $('<div class="gcs-video-manager">');
    const fileInput = $('<input type="file" class="gcs-file-input">');
    const duration = $('<input type="number" class="text_pole" min="0.1" step="any" placeholder="视频时长（秒）">');
    const progress = $('<progress max="100" value="0" aria-label="上传进度">').hide();
    const status = $('<div role="status" class="gcs-status">');
    const uploadMode = $('<select class="text_pole" aria-label="上传保存方式">');
    for (const [id,label] of [['auto','自动：小文件仅 copyparty，大文件两边各一份'],['copyparty','仅 copyparty：用于播放、下载'],['both','copyparty + GCS：两边各保存一份'],['gcs','仅 GCS：浏览器直接上传 Google']]) if(config.local_upload_available || id==='gcs') uploadMode.append($('<option>').val(id).text(label));
    const uploadPlan = $('<p class="gcs-muted">');
    function describeUpload() {
        const mode=uploadMode.val(),size=selectedFile?.size;
        const double=mode==='both'||(mode==='auto'&&size>config.https_max_bytes);
        const plan=mode==='gcs'?'浏览器 → GCS，仅存一份。以后预览或下载时会先复制到 copyparty。':`浏览器只上传一份到 ${config.copyparty_label || 'copyparty'}。`+(double?'保存到 copyparty 后，由该节点上传 GCS，最终两边各一份。':mode==='auto'&&size===undefined?`不超过 ${(config.https_max_bytes/1000000).toFixed(1)} MB 仅存 copyparty，更大文件由节点再上传 GCS。`:'仅保存到 copyparty；以后附加较大文件时才上传 GCS。');
        uploadPlan.text(plan);
    }
    uploadMode.on('change',describeUpload);
    const upload = $('<button type="button" class="menu_button">').text('上传 / 继续');
    const pause = $('<button type="button" class="menu_button">').text('暂停').prop('disabled', true);
    const fresh = $('<button type="button" class="menu_button">').text('放弃续传，重新上传');
    const list = $('<div class="gcs-video-list" aria-label="文件列表">');
    const importUrl = $('<input class="text_pole" placeholder="粘贴文件直链、Iwara 或 B站播放页链接">');
    const importWorker = $('<select class="text_pole" aria-label="导入节点">');
    for (const worker of config.import_workers) importWorker.append($('<option>').val(worker.id).text(worker.label));
    importWorker.val(config.default_import_worker);
    const syncCopyparty = $('<input type="checkbox">').prop('checked',config.admin);
    const syncLabel = $('<label class="gcs-checkbox">').append(syncCopyparty, ' 同时保存到 copyparty（供播放和下载）').toggle(config.admin);
    const importButton = $('<button type="button" class="menu_button">').text('开始导入');
    const importStatus = $('<div role="status" class="gcs-import-status">');
    let polling = true;
    const more = $('<button type="button" class="menu_button">').text('加载更多').hide();
    let nextPage = '';
    let controller;
    let active = false;
    let selectedFile;
    function loadSaved() { try { return JSON.parse(sessionStorage.getItem(storeKey)); } catch { return null; } }
    describeUpload();
    if (loadSaved()) {uploadMode.val(loadSaved().mode || 'gcs');describeUpload();}
    if (loadSaved()) status.text('有未完成的上传：重新选择相同文件，然后点击“上传 / 继续”。');
    let videos = [];
    let page = 0;
    const pageSize = 12;
    let loading = false;
    let refreshAgain = false;
    const search = $('<input type="search" class="text_pole" placeholder="搜索已加载的文件" aria-label="搜索文件">');
    const filter = $('<select class="text_pole" aria-label="文件类型">');
    for (const [value, label] of [['all','全部类型'],['video','视频'],['audio','音频'],['image','图片'],['pdf','PDF'],['text','文本'],['file','其他文件']]) filter.append($('<option>').val(value).text(label));
    const sourceSelect = $('<select class="text_pole" aria-label="存储来源">').append($('<option value="all">').text('全部来源'), $('<option value="gcs">').text('我的 GCS'));
    let sources = [];
    let directory = '';
    const breadcrumbs = $('<div class="gcs-breadcrumbs">');
    const libraryStatus = $('<p class="gcs-status" role="status">');
    let noticeTimer;
    function notifyLibrary(message) {clearTimeout(noticeTimer);libraryStatus.text(message);noticeTimer=setTimeout(()=>libraryStatus.empty(),4500);}
    async function confirmOperation(title,message) {
        const body=$('<div>').append($('<h3>').text(title),$('<p>').text(message));
        return await new Popup(body,POPUP_TYPE.CONFIRM,'',{okButton:'继续',cancelButton:'取消'}).show()===POPUP_RESULT.AFFIRMATIVE;
    }
    const durationField = $('<label class="gcs-field">').append($('<span>').text('音视频时长（秒，可选）'), duration).hide();
    async function api(route, body) {
        const response = await fetch(API + route, { headers:context().getRequestHeaders(), ...(body ? {method:'POST', body:JSON.stringify(body)} : {}) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || '文件操作失败。'); return data;
    }
    async function loadSources() {
        const selected = sourceSelect.val(); const result = await api('/file-sources'); sources = result.items;
        sourceSelect.empty().append($('<option value="all">').text('全部来源'));
        for (const source of sources) sourceSelect.append($('<option>').val(source.id).text(source.label));
        sourceSelect.val(sources.some(item=>item.id === selected) || selected === 'all' ? selected : 'all');
        if (result.errors?.length) libraryStatus.text(result.errors.join('；'));
    }
    function navigate(item) { sourceSelect.val(`${item.worker_id}:${item.volume}`); directory = item.path; page = 0; search.val(''); refresh(); }
    function renderBreadcrumbs() {
        breadcrumbs.empty(); const source = sources.find(item=>item.id===sourceSelect.val());
        if (source?.storage !== 'copyparty') return;
        breadcrumbs.append($('<button type="button" class="menu_button gcs-subtle">').text(source.label).on('click',()=>{directory='';refresh();}));
        const segments = directory.split('/').filter(Boolean);
        segments.forEach((part,index)=>breadcrumbs.append($('<span>').text('/'),$('<button type="button" class="menu_button gcs-subtle">').text(part).on('click',()=>{directory=segments.slice(0,index+1).join('/');refresh();})));
    }
    async function previewFile(file) {
        const data = await accessibleFile(file);
        if(!data)return;
        file = {...data.file,...fileInfo(data.file.title || data.file.url)};
        const body = $('<div class="gcs-file-preview">').append($('<h3>').text(file.title));
        let media;
        if (file.type === 'video' || file.type === 'audio') media = $(`<${file.type} controls preload="metadata">`).attr('src',data.url);
        else if (file.type === 'image') media = $('<img>').attr({src:data.url,alt:file.title});
        else if (file.type === 'pdf') media = $('<iframe title="PDF 预览">').attr('src',data.url);
        else if (file.type === 'text') {
            media = $('<pre>').text('正在读取文本…');
            const response = await fetch(data.url); if (!response.ok) throw new Error('文本预览读取失败。');
            const reader = response.body.getReader(); const decoder = new TextDecoder(); let text = ''; let bytes = 0; let truncated = false;
            try { while (true) { const result = await reader.read(); if (result.done) break; const remaining = 1048576 - bytes; const chunk = result.value.subarray(0, Math.max(0, remaining)); bytes += chunk.length; text += decoder.decode(chunk,{stream:true}); if (result.value.length > remaining || bytes >= 1048576) {truncated=true;break;} } }
            finally { await reader.cancel(); }
            media.text(text + decoder.decode() + (truncated ? '\n…仅预览前 1 MiB，请下载查看完整内容。' : ''));
        } else media = $('<p>').text('此格式暂不支持在线预览，可以下载后打开。');
        body.append(media, $('<p class="gcs-muted">').text(file.storage === 'gcs' ? '临时访问链接有效期 15 分钟；播放和下载按实际读取流量计费。' : '文件由 copyparty 直接提供，保留时间以目录策略为准。'));
        await new Popup(body, POPUP_TYPE.TEXT, '', {wide:true,large:true,okButton:'关闭'}).show();
        if (file.type === 'video' || file.type === 'audio') {media[0].pause();media.removeAttr('src');media[0].load();}
    }
    async function accessibleFile(file,download=false) {
        if(file.storage==='gcs' && !await confirmOperation(download?'下载到本机':'预览文件','先使用 copyparty 中已有的有效副本；没有副本时，由 GCS 读取节点复制到 copyparty，再从 copyparty '+(download?'下载到本机。':'播放或预览。')+'复制会产生节点流量，GCS 原文件保留。')) return null;
        const result = await api('/file-access',{file,download});
        if (result.url) return result;
        const copied = await completeTask(result);
        if (!copied) throw new Error('尚未完成 copyparty 复制，请稍后重试。');
        return api('/file-access',{file:copied,download});
    }
    async function downloadFile(file) {
        const data = await accessibleFile(file,true);
        if(!data)return;
        const link = $('<a>').attr({href:data.url,download:file.title,target:'_blank',rel:'noopener noreferrer'}).appendTo(panel);link[0].click();link.remove();
    }
    async function deleteFile(file) {
        const body = $('<div>').append($('<h3>').text(`删除 ${file.storage==='gcs'?'GCS':'copyparty'} 中这一份？`), $('<p>').text(file.title), $('<p>').text('将删除当前存储中的文件，另一存储的副本不受影响。引用这一地址的历史附件可能失效。'));
        if (await new Popup(body,POPUP_TYPE.CONFIRM,'',{okButton:'删除文件',cancelButton:'取消'}).show() !== POPUP_RESULT.AFFIRMATIVE) return;
        await api('/file-delete',{file});await refresh();notifyLibrary('已删除所选存储中的这一份文件。');
    }
    async function completeTask(result, attach = false) {
        let file = result.file;
        if (result.job) { sessionStorage.setItem(importKey,result.job.id); const job = await pollImport(result.job.id,libraryStatus); file = job?.video; }
        if (attach && polling && file) {queueVideo(file.url,file.duration_seconds,file.title);toastr.success('文件已附加到本轮。');renderList();}
        else if (file) notifyLibrary(result.reused ? '已使用现有副本，没有重复传输。' : '操作完成。');
        return file;
    }
    async function attachFile(file) {
        const limit=file.type==='image'?Math.min(7000000,config.https_max_bytes):config.https_max_bytes;
        if(file.storage!=='gcs'&&file.size>limit&&!await confirmOperation('附加到本轮对话','这个文件超过直链大小限制。会复用已有 GCS 副本，或由存储节点上传到 GCS，再将 GCS 地址附加给 Gemini；copyparty 原文件保留。'))return;
        await completeTask(await api('/file-attach',{file}),true);
    }
    async function copyFile(file) {
        let target;
        if (file.storage === 'gcs') {
            const choices = sources.filter(item=>item.storage==='copyparty'); if (!choices.length) throw new Error('请先在设置中启用共享目录文件库。');
            const select = $('<select class="text_pole">'); for (const item of choices) select.append($('<option>').val(item.id).text(item.label));
            const preferred = choices.find(item=>item.volume==='imports');if(preferred)select.val(preferred.id);
            const body = $('<div class="gcs-video-dialog">').append($('<h3>').text('复制到 copyparty'),$('<p>').text('由配置的 GCS 读取节点经 Google 私有 API 读取，再保存到所选 copyparty 目录。原文件保留；之后播放使用 copyparty 副本。'),select);
            if(await new Popup(body,POPUP_TYPE.CONFIRM,'',{okButton:'复制',cancelButton:'取消'}).show()!==POPUP_RESULT.AFFIRMATIVE)return;
            target=choices.find(item=>item.id===select.val());
        }
        if(file.storage!=='gcs'&&!await confirmOperation('另存一份到 GCS','由存储节点上传，浏览器不再上传文件；已有有效 GCS 副本会直接复用。copyparty 原文件保留。'))return;
        return await completeTask(await api('/file-transfer',{file,destination:file.storage==='gcs'?'copyparty':'gcs',target}));
    }
    sourceSelect.on('change',()=>{directory='';page=0;refresh();});
    const count = $('<span class="gcs-muted" role="status">');
    const previous = $('<button type="button" class="menu_button">').text('上一页');
    const next = $('<button type="button" class="menu_button">').text('下一页');
    const pageLabel = $('<span class="gcs-muted">');
    const empty = $('<p class="gcs-empty">');
    function formatDuration(value) {
        if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '时长未知';
        const seconds = Math.round(Number(value));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }
    async function copyUrl(url, button) {
        try { await navigator.clipboard.writeText(url); }
        catch {
            const fallback = $('<textarea class="gcs-copy-fallback">').val(url).appendTo(panel);
            fallback[0].select(); const copied = document.execCommand('copy'); fallback.remove();
            if (!copied) { toastr.error('复制失败，请展开地址后手动复制。'); return; }
        }
        const label=button.text();button.text('地址已复制');setTimeout(()=>button.text(label),1500);
    }
    function renderList() {
        const term = String(search.val()).trim().toLocaleLowerCase();
        const matches = videos.filter(video => (!term || video.title.toLocaleLowerCase().includes(term)) && (video.is_directory || filter.val() === 'all' || video.type === filter.val()));
        const pages = Math.max(1, Math.ceil(matches.length / pageSize)); page = Math.min(page, pages - 1);
        list.empty();
        count.text(`${videos.length} 个已加载${nextPage ? ' · 还有更多' : ''}${term || filter.val() !== 'all' ? ` · ${matches.length} 个匹配` : ''}`);
        if (!matches.length) list.append(empty.text(videos.length ? '没有匹配的文件。试试其他名称或存储类型。' : '文件库还是空的。选择“上传文件”或“链接导入”开始。'));
        for (const video of matches.slice(page * pageSize, (page + 1) * pageSize)) {
            const action = (label, callback, primary = false) => $('<button type="button" class="menu_button">').toggleClass('gcs-primary',primary).text(label).on('click',async function(){const button=$(this);clearTimeout(noticeTimer);libraryStatus.empty();button.prop('disabled',true);try{await callback();}catch(error){libraryStatus.text(error.message);toastr.error(error.message);}finally{button.prop('disabled',false);}});
            const main = $('<div class="gcs-video-main">').append($('<strong>').text((video.is_directory ? '▸ ' : '') + video.title).attr('title',video.title));
            if (video.is_directory) {
                main.append($('<div class="gcs-video-meta">').text(video.source_label || '文件夹'));
                $('<article class="gcs-video-list-item">').append(main,action('打开',()=>navigate(video))).appendTo(list);continue;
            }
            const attachable = video.attachable ?? fileInfo(video.url).attachable;
            const limit = video.type==='image'?Math.min(7000000,config.https_max_bytes):config.https_max_bytes;
            const attach = action(pending?.url===video.url?'已附加到本轮':'附加到本轮',()=>attachFile(video),true).prop('disabled',!attachable).attr('title',attachable?(video.storage==='gcs'?'将 GCS 地址交给 Gemini，不下载文件':video.size>limit?'复用或创建 GCS 副本后附加，保留 copyparty 文件':'直接附加 copyparty 地址，仅用于本轮'):'Gemini 不支持此格式，可以下载');
            const date=video.expires?`到期 ${new Date(video.expires).toLocaleDateString()}`:new Date(video.created).toLocaleDateString();
            main.append($('<div class="gcs-video-meta">').append($('<span class="gcs-storage-label">').text(video.source_label || (video.storage==='gcs'?'GCS':'copyparty')), $('<span>').text(`${(video.size/1048576).toFixed(1)} MiB`),$('<span>').text(['video','audio'].includes(video.type)?formatDuration(video.duration_seconds):video.type?.toUpperCase()||'文件'),$('<span>').text(date)));
            const copyLink=action(video.storage==='gcs'?'复制 gs:// 地址':'复制文件直链',()=>copyUrl(video.url,copyLink));
            const menu=$('<details class="gcs-file-menu">').append($('<summary>').text('管理'),$('<div class="gcs-file-menu-actions">').append(action('下载到本机',()=>downloadFile(video)).attr('title',video.storage==='gcs'?'先复用或创建 copyparty 副本，再从副本下载':'从 copyparty 下载到你的设备').prop('disabled',video.storage==='gcs'&&!config.admin),copyLink,...(video.storage!=='gcs'||config.admin?[action(video.storage==='gcs'?'另存一份到 copyparty':'另存一份到 GCS',()=>copyFile(video))]:[])));
            if(video.storage==='gcs'||video.storage==='copyparty')menu.find('.gcs-file-menu-actions').append(action('删除这一份',()=>deleteFile(video)));
            menu.find('.gcs-file-menu-actions').append(action('操作说明',async()=>{
                const body=$('<div>').append($('<h3>').text('这个文件的操作方式'),$('<p>').text(video.storage==='gcs'?'预览、下载：先复用或创建 copyparty 副本，再从副本读取。附加到本轮：直接把 gs:// 地址交给 Gemini。':'预览、下载：直接读取 copyparty 文件。附加到本轮：小文件用直链，大文件复用或上传 GCS 后附加。'),$('<p>').text('另存一份：保留原文件，已有有效副本会复用。删除这一份：只删除当前存储中的文件，不删除其他副本。复制地址：只复制链接，不传输文件。'));
                await new Popup(body,POPUP_TYPE.TEXT,'',{okButton:'知道了'}).show();
            }));
            $('<article class="gcs-video-list-item">').append(main,$('<div class="gcs-actions">').append(action('预览文件',()=>previewFile(video)).prop('disabled',video.storage==='gcs'&&!config.admin),attach,menu)).appendTo(list);

        }
        pageLabel.text(`${page + 1} / ${pages}`); previous.prop('disabled', page === 0); next.prop('disabled', page + 1 >= pages);
        more.toggle(Boolean(nextPage));
    }
    search.on('input', () => { page = 0; renderList(); }); filter.on('change', () => { page = 0; renderList(); });
    previous.on('click', () => { page--; renderList(); list[0].scrollTop = 0; });
    next.on('click', () => { page++; renderList(); list[0].scrollTop = 0; });
    async function refresh(append = false) {
        if (loading) {if(!append)refreshAgain=true;return;}
        clearTimeout(noticeTimer);libraryStatus.empty();
        loading = true; list.attr('aria-busy', 'true'); more.prop('disabled', true); refreshButton.prop('disabled', true);
        try {
            const selected = sources.find(item=>item.id===sourceSelect.val());
            const query = new URLSearchParams({storage:selected?.storage||'all'});
            if(selected?.storage==='copyparty'){query.set('worker_id',selected.worker_id);query.set('volume',selected.volume);query.set('path',directory);}
            if(append&&nextPage)query.set('pageToken',nextPage);
            const data = await api('/files?'+query);
            renderBreadcrumbs();if(data.errors?.length)libraryStatus.text(data.errors.join('；'));
            const unique = new Map((append ? videos : []).map(video => [video.url, video]));
            for (const video of data.items) unique.set(video.url, video);
            videos = [...unique.values()].sort((a, b) => Number(b.is_directory||false)-Number(a.is_directory||false) || String(b.created).localeCompare(String(a.created)));
            if (!append) page = 0;
            nextPage = data.nextPageToken || ''; renderList();
        } catch (error) { count.text(error.message); if (!videos.length) list.empty().append(empty.text('列表暂时不可用，请稍后刷新。')); }
        finally { loading = false; list.attr('aria-busy', 'false'); more.prop('disabled', false); refreshButton.prop('disabled', false); if(refreshAgain){refreshAgain=false;await refresh();} }
    }
    fileInput.on('change', () => {
        selectedFile = fileInput[0].files?.[0];
        if (!selectedFile) return;
        describeUpload();
        const saved = loadSaved();
        if (saved?.fingerprint === fileFingerprint(selectedFile)) {duration.val(saved.video?.duration_seconds || saved.duration_seconds || '');uploadMode.val(saved.mode || 'gcs');describeUpload();}
        else {
            duration.val('');
            const kind=fileInfo(selectedFile.name).type;durationField.toggle(['video','audio'].includes(kind));
            if(!['video','audio'].includes(kind))return;
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
        if (!selectedFile) { toastr.warning('请先选择文件。'); return; }
        if (selectedFile.size > config.max_upload_bytes) { toastr.error('文件超过 2 GiB 上传上限。'); return; }
        controller = new AbortController();
        active = true; progress.show();uploadMode.prop('disabled',true);
        upload.prop('disabled', true); pause.prop('disabled', false); fresh.prop('disabled', true); fileInput.prop('disabled', true);
        try {
            let saved = loadSaved();
            const mode=uploadMode.val();
            if (saved?.fingerprint !== fileFingerprint(selectedFile) || saved.mode!==mode) {
                const response = await fetch(`${API}/${mode==='gcs'?'uploads':'local-uploads'}`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ mode, filename: selectedFile.name, size: selectedFile.size, duration_seconds: duration.val() ? Number(duration.val()) : null }), signal: controller.signal });
                saved = await response.json();
                if (!response.ok) throw new Error(saved.error || '创建上传失败。');
                saved.mode=mode;
                saved.fingerprint = fileFingerprint(selectedFile);
                sessionStorage.setItem(storeKey, JSON.stringify(saved));
            }
            await (mode==='gcs'?uploadResumable:uploadToNode)(selectedFile, saved.session, { signal: controller.signal, onProgress: (done, total) => {
                progress.val(done / total * 100);
                status.text(`已上传 ${(done / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB（${Math.floor(done / total * 100)}%）`);
            } });
            if(mode!=='gcs') {
                status.text('浏览器上传完成，节点正在保存文件；如需 GCS 副本，将由节点继续上传。');
                const task=await api('/local-uploads/finish',{id:saved.id});
                sessionStorage.setItem(importKey,task.job.id);
                sessionStorage.removeItem(storeKey);
                pause.prop('disabled',true);
                const completed=await pollImport(task.job.id,status);
                if(completed?.status==='complete')status.text(completed.warning || (completed.video?.url?.startsWith('gs://')?'保存完成：copyparty 与 GCS 各一份。':'保存完成：文件位于 copyparty。'));
            } else {sessionStorage.removeItem(storeKey);status.text('保存完成：文件位于 GCS。');}
            await refresh();
        } catch (error) {
            status.text(controller.signal.aborted ? '已暂停。点击“上传 / 继续”恢复；刷新后需要重新选择相同文件。' : error.message);
        } finally {
            active = false; uploadMode.prop('disabled',false);upload.prop('disabled', false); pause.prop('disabled', true); fresh.prop('disabled', false); fileInput.prop('disabled', false);
        }
    });
    const refreshButton = $('<button type="button" class="menu_button">').text('刷新列表').on('click', () => refresh().catch(error => toastr.error(error.message)));
    more.on('click', () => refresh(true).catch(error => toastr.error(error.message)));
    const importKey = `gcs-video-import:${config.user}`;
    async function pollImport(id, taskStatus = importStatus) {
        let failures = 0;
        importButton.prop('disabled', true);
        try {
            while (polling) {
                let response;
                try { response = await fetch(`${API}/imports/${encodeURIComponent(id)}`, { headers: context().getRequestHeaders() }); } catch { /* Retry status queries, never resubmit the upload. */ }
                if (!response || response.status >= 500 || response.status === 429) {
                    if (++failures >= 6) throw new Error('暂时无法连接导入节点。任务可能仍在运行，请稍后重新打开文件库查询。');
                    taskStatus.text(`进度连接暂时中断，正在重试（${failures}/6）；不会重复提交上传。`);
                    await new Promise(resolve => setTimeout(resolve, Math.min(30000, failures * 2000)));
                    continue;
                }
                if (!response.ok) throw new Error('无法读取导入状态，请刷新文件列表。登录失效或服务重启后进度记录可能失效。');
                failures = 0;
                const job = await response.json();
                const state = {queued:'排队中',downloading:'解析 / 下载中',ready:'等待上传',running:'上传 GCS 中',publishing:'保存临时直链中',complete:'完成',failed:'失败'}[job.status] || job.status;
                taskStatus.text(`导入节点 ${job.worker_id}：${state} · ${(job.done / 1048576).toFixed(1)} / ${(job.total / 1048576).toFixed(1)} MiB`);
                if (job.status === 'complete') { sessionStorage.removeItem(importKey); taskStatus.text(job.warning || (job.sync_video ? '导入完成，已同步到 copyparty。' : '导入完成，可以从下方列表附加。')); await refresh(); return job; }
                if (job.status === 'failed') { sessionStorage.removeItem(importKey); throw new Error(job.error || '云端导入失败，请检查链接后重试。'); }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        } catch (error) { taskStatus.text(error.message); }
        finally { importButton.prop('disabled', false); }
    }
    importButton.on('click', async () => {
        importButton.prop('disabled', true);
        importStatus.text('正在检查链接并创建导入任务…');
        try {
            const response = await fetch(`${API}/imports`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify({ source_url: importUrl.val(), worker_id: importWorker.val(), sync_copyparty: syncCopyparty.prop('checked') }) });
            const job = await response.json();
            if (!response.ok) throw new Error(job.error || '导入失败。');
            sessionStorage.setItem(importKey, job.id);
            importUrl.val('');
            await pollImport(job.id);
        } catch (error) { importStatus.text(error.message); importButton.prop('disabled', false); }
    });
    const tabs = $('<div class="gcs-tabs" role="tablist" aria-label="文件库功能">');
    const pages = new Map();
    function selectTab(id) {
        for (const [key, value] of pages) { const selected = key === id; value.button.attr({ 'aria-selected': String(selected), tabindex: selected ? 0 : -1 }); value.body.prop('hidden', !selected); }
    }
    function addTab(id, title, body) {
        const button = $('<button type="button" role="tab">').attr({ id: `gcs-tab-${id}`, 'aria-controls': `gcs-panel-${id}` }).text(title).on('click', () => selectTab(id));
        button.on('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); const keys = [...pages.keys()]; let at = keys.indexOf(id);
            at = event.key === 'Home' ? 0 : event.key === 'End' ? keys.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
            selectTab(keys[at]); pages.get(keys[at]).button.trigger('focus');
        });
        body.addClass('gcs-tab-panel').attr({ role: 'tabpanel', id: `gcs-panel-${id}`, 'aria-labelledby': `gcs-tab-${id}` });
        pages.set(id, { button, body }); tabs.append(button); panel.append(body);
    }
    panel.append($('<header class="gcs-library-header">').append($('<div>').append($('<h3>').text('文件库'), $('<p class="gcs-muted">').text('浏览文件，按需附加到本轮对话。'))), tabs);
    const libraryPanel = $('<section>').append($('<div class="gcs-library-toolbar">').append(search, sourceSelect, filter, refreshButton),
        $('<div class="gcs-library-summary">').append(count), breadcrumbs, libraryStatus, list,
        $('<footer class="gcs-list-footer">').append(more, $('<div class="gcs-pagination">').append(previous, pageLabel, next)));
    addTab('library', '我的文件', libraryPanel);
    addTab('upload', '上传文件', $('<section class="gcs-form-panel">').append(
        $('<label class="gcs-field">').append($('<span>').text('选择本地文件'), fileInput),
        $('<label class="gcs-field">').append($('<span>').text('保存方式'),uploadMode),uploadPlan,durationField,
        $('<div class="gcs-actions">').append(upload, pause, fresh), progress, status,
        $('<p class="gcs-muted">').text('浏览器上传支持分片续传。关闭面板会暂停当前上传；节点接手后的保存和 GCS 上传会继续执行。')));
    addTab('import', '链接导入', $('<section class="gcs-form-panel">').append(
        $('<label class="gcs-field">').append($('<span>').text('文件链接'), importUrl),
        $('<div class="gcs-import-controls">').append($('<label class="gcs-field">').append($('<span>').text('处理节点'), importWorker), importButton), syncLabel, importStatus,
        $('<p class="gcs-muted">').text('支持文件直链、Iwara 和 B站。自动读取时长并选择存储，关闭面板后任务继续。')));
    if (!config.import_workers.length) { importButton.prop('disabled', true); importStatus.text('管理员尚未添加导入节点。'); }
    if (config.admin) {
        const settingsPanel = $('<section>').text('正在读取设置…'); addTab('settings', '设置', settingsPanel);
        createSettingsPanel(context, async () => {
            config = await (await fetch(`${API}/config`, { headers: context().getRequestHeaders() })).json();
            importWorker.empty(); for (const worker of config.import_workers) importWorker.append($('<option>').val(worker.id).text(worker.label));
            importWorker.val(config.default_import_worker); importButton.prop('disabled', !config.import_workers.length);
            upload.prop('disabled', !config.configured); await loadSources(); await refresh();
        }).then(form => settingsPanel.empty().append(form)).catch(error => settingsPanel.text(error.message));
    }
    selectTab(config.configured ? 'library' : config.admin ? 'settings' : 'library');
    if (config.configured) loadSources().then(()=>refresh()).catch(error=>libraryStatus.text(error.message));
    else { upload.prop('disabled', true); count.text('请管理员先完成文件工具设置。'); }
    const importId = sessionStorage.getItem(importKey);
    if (importId) pollImport(importId);
    await new Popup(panel, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: '关闭' }).show();
    polling = false;clearTimeout(noticeTimer);
    controller?.abort();
}

function renderPending() {
    $('#gcs-video-pending').remove();
    if (!pending) return;
    $('<div id="gcs-video-pending" class="gcs-video-badge">').append(
        $('<span>').text(`${pending.title} · ${['video','audio'].includes(pending.type)?durationLabel(pending.duration_seconds):pending.type.toUpperCase()} · 仅本轮`),
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
    const detect = $('<button type="button" class="menu_button">').text('重新读取时长').on('click', detectDuration);
    const form = $('<div class="gcs-video-dialog">').append(
        $('<h3>').text('添加文件链接'),
        $('<p>').text('附加到本轮后，使用支持相应文件类型的 Gemini 连接发送。连接与可用模型可在文件库设置中调整。'),
        $('<label>').text('GCS 地址或 HTTPS 文件直链').append(uri),
        $('<label>').text('视频时长（秒，可选）').append(duration), detect, hint,
        $('<p>').text('下一轮不会自动重发文件，需要时可再次附加。'),
    );
    if (uri.val() && !duration.val()) detectDuration();
    try {
        while (await new Popup(form, POPUP_TYPE.CONFIRM, '', { okButton: '附加', cancelButton: '取消' }).show() === POPUP_RESULT.AFFIRMATIVE) {
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
        $('<span>').text(`${video.title} · ${['video','audio'].includes(video.type)?durationLabel(video.duration_seconds):video.type.toUpperCase()} · 文件仅本轮`),
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
        if (!response.ok) throw new Error('文件库后端插件不可用。');
        config = await response.json();
        const ctx = context();
        $('<div class="list-group-item flex-container flexGap5" id="gcs-video-attach">').append(
            $('<div class="fa-fw fa-solid fa-video extensionsMenuExtensionButton">'),
            $('<span>').text('添加文件链接（仅本轮）'),
        ).on('click', showAttachDialog).appendTo('#attach_file_wand_container');
        $('<div class="list-group-item flex-container flexGap5" id="gcs-video-library">').append(
            $('<div class="fa-fw fa-solid fa-cloud-arrow-up extensionsMenuExtensionButton">'),
            $('<span>').text('文件库：上传与管理'),
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
