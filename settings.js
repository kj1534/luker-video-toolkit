const API = '/api/plugins/gcs-video';
export async function createSettingsPanel(context, onSaved) {
    const root = $('<form class="gcs-settings">');
    const status = $('<p role="status" class="gcs-status">');
    const response = await fetch(`${API}/settings`, { headers: context().getRequestHeaders() });
    const current = await response.json();
    if (!response.ok) throw new Error('仅管理员可以配置视频工具。');
    const field = (title, value, type = 'text') => {
        const input = $('<input class="text_pole">').attr('type', type).val(value);
        return { input, label: $('<label class="gcs-field">').append($('<span>').text(title), input) };
    };
    const upstream = field('Gemini 接口地址', current.upstream);
    const model = field('模型 ID', current.model);
    const bucket = field('GCS 桶名称', current.bucket);
    const maxSize = field('单文件上限（MiB）', current.max_upload_bytes / 1048576, 'number');
    maxSize.input.attr({ min: 1, max: 2048, step: 1 });
    const directSize = field('直链大小上限（MB）', current.https_max_bytes / 1000000, 'number');
    directSize.input.attr({ min: .1, max: 15, step: .1 });
    const origins = $('<textarea class="text_pole" rows="3" placeholder="https://media.example">').val(current.direct_media_origins.join('\n'));
    const credential = $('<input type="file" accept=".json,application/json" class="gcs-file-input">');
    const credentialState = $('<span class="gcs-muted">').text(current.credential_configured ? '已保存密钥；不选择新文件则保持不变。' : '选择 Google 服务账号 JSON 文件。');
    const nodes = $('<div class="gcs-node-list">');
    const nodeRows = [];
    const defaultSelect = $('<select class="text_pole" aria-label="默认导入节点">');
    function updateDefaults() {
        const selected = defaultSelect.val() || current.default_import_worker;
        defaultSelect.empty();
        for (const row of nodeRows) defaultSelect.append($('<option>').val(row.id.input.val()).text(row.label.input.val() || row.id.input.val() || '未命名节点'));
        if (!nodeRows.length) defaultSelect.append($('<option>').val('').text('不使用导入节点'));
        if (nodeRows.some(row => row.id.input.val() === selected)) defaultSelect.val(selected);
    }
    function addNode(value = {}) {
        const row = { id: field('节点 ID', value.id || ''), label: field('显示名称', value.label || ''), url: field('HTTPS 控制接口', value.url || ''), token: field('控制令牌', '', 'password') };
        row.token.input.attr({ autocomplete: 'new-password', placeholder: value.token_configured ? '已保存，留空保持不变' : '粘贴节点控制令牌' });
        row.url.input.attr('placeholder', 'https://node.example/video-import');
        row.id.input.attr('placeholder', 'primary');
        const remove = $('<button type="button" class="menu_button gcs-subtle">').text('移除节点').on('click', () => { nodeRows.splice(nodeRows.indexOf(row), 1); row.element.remove(); updateDefaults(); });
        row.element = $('<div class="gcs-node-row">').append(row.id.label, row.label.label, row.url.label, row.token.label, remove);
        row.id.input.add(row.label.input).on('input', updateDefaults);
        nodeRows.push(row); nodes.append(row.element); updateDefaults();
    }
    for (const node of current.import_workers) addNode(node);
    updateDefaults();
    const add = $('<button type="button" class="menu_button">').text('＋ 添加节点').on('click', () => addNode());
    const save = $('<button type="submit" class="menu_button gcs-primary">').text('保存设置');
    const test = $('<button type="button" class="menu_button">').text('检测已保存的连接');
    const testResult = $('<div class="gcs-check-results" role="status">');
    const fields = $('<fieldset>');
    fields.append(
        $('<h4>').text('模型连接'), $('<p class="gcs-muted">').text('填写与 Luker 当前 Gemini 连接一致的接口地址和模型 ID。'),
        $('<div class="gcs-field-grid">').append(upstream.label, model.label),
        $('<h4>').text('视频存储'), bucket.label,
        $('<label class="gcs-field">').append($('<span>').text('服务账号密钥'), credential, credentialState),
        $('<div class="gcs-field-grid">').append(maxSize.label, directSize.label),
        $('<label class="gcs-field">').append($('<span>').text('允许附加的 HTTPS 视频来源（每行一个域名地址）'), origins),
        $('<h4>').text('导入节点'), $('<p class="gcs-muted">').text('添加已部署节点的接口和令牌；不添加节点也可上传本地视频。'),
        nodes, add, $('<label class="gcs-field">').append($('<span>').text('默认节点'), defaultSelect),
        $('<div class="gcs-actions">').append(save, test), testResult,
    );
    root.append(fields, status);
    root.on('submit', async event => {
        event.preventDefault(); fields.prop('disabled', true); status.text('正在保存…');
        try {
            const keyFile = credential[0].files?.[0];
            if (keyFile?.size > 65536) throw new Error('请选择服务账号 JSON 密钥文件（最大 64 KiB）。');
            const body = { upstream: upstream.input.val(), model: model.input.val(), bucket: bucket.input.val(), max_upload_bytes: Math.round(Number(maxSize.input.val()) * 1048576), https_max_bytes: Math.round(Number(directSize.input.val()) * 1000000), direct_media_origins: origins.val().split('\n').map(x => x.trim()).filter(Boolean), credential_json: keyFile ? await keyFile.text() : undefined, default_import_worker: defaultSelect.val() || '', import_workers: nodeRows.map(row => ({ id: row.id.input.val(), label: row.label.input.val(), url: row.url.input.val(), token: row.token.input.val() })) };
            const result = await fetch(`${API}/settings`, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify(body) });
            const data = await result.json();
            if (!result.ok) throw new Error(data.error || '保存失败。');
            credential.val(''); credentialState.text('已保存密钥；不选择新文件则保持不变。');
            for (const row of nodeRows) row.token.input.val('').attr('placeholder', '已保存，留空保持不变');
            await onSaved(); status.text('已保存并生效，无需重启 Luker。');
        } catch (error) { status.text(error.message); }
        finally { fields.prop('disabled', false); }
    });
    test.on('click', async () => {
        test.prop('disabled', true); testResult.text('正在检测 GCS 与导入节点…');
        try {
            const result = await fetch(`${API}/settings/test`, { method: 'POST', headers: context().getRequestHeaders(), body: '{}' });
            const data = await result.json();
            if (!result.ok) throw new Error('检测失败，请稍后重试。');
            testResult.empty();
            for (const check of data.checks) testResult.append($('<span>').toggleClass('gcs-check-failed', !check.ok).text(`${check.ok ? '✓' : '×'} ${check.label}：${check.ok ? '连接正常' : '连接失败，请检查配置'}`));
        } catch (error) { testResult.text(error.message); }
        finally { test.prop('disabled', false); }
    });
    return root;
}
