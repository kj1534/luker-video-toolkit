import {showLibrary} from './library-ui.js';
import {createSettingsPanel} from './settings.js';
const API=new URL('api',location.href).pathname;
let csrf='';let session;
const context=()=>({getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':csrf})});
async function api(route,body){const r=await fetch(API+route,{headers:context().getRequestHeaders(),...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json().catch(()=>({error:'请求失败，请重新登录。'}));if(!r.ok)throw Error(data.error);return data;}
let noticeTimer;function notice(text){$('#notice').text(text);clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').empty(),6000);}
globalThis.toastr={error:notice,warning:notice,success:notice};
const POPUP_TYPE={TEXT:1,CONFIRM:2},POPUP_RESULT={AFFIRMATIVE:1};
class Popup{
    constructor(body,type,unused='',options={}){
        if(typeof unused==='object'&&unused!==null&&Object.keys(options).length===0){
            options=unused;unused='';
        }
        Object.assign(this,{body,type,unused,options});
    }
    show(){
        return new Promise(resolve=>{
            const dialog=$('<dialog>').append(this.body).appendTo('body');
            const end=value=>{dialog[0].close();dialog.remove();resolve(value);};
            const footer=$('<footer>');
            if(this.type===2){
                footer.append($('<button type="button" class="menu_button gcs-subtle">').text(this.options.cancelButton||'取消').on('click',()=>end(0)));
            }
            footer.append($('<button type="button" class="menu_button gcs-primary">').text(this.options.okButton||'知道了').on('click',()=>end(1)));
            dialog.append(footer).on('cancel',e=>{e.preventDefault();end(0);});
            dialog[0].showModal();
        });
    }
}
const field=(label,value='',type='text')=>{const input=$('<input class="text_pole">').attr('type',type).val(value);return {input,element:$('<label>').append($('<span>').text(label),input)};};
const button=(label,action,className='menu_button')=>$(`<button type="button" class="${className}">`).text(label).on('click',async()=>{try{await action();}catch(e){notice(e.message);}});

async function account(){
    const panel=$('<section class="gcs-admin-dialog">').append(
        $('<h2>').text('Luker 插件授权令牌'),
        $('<p class="gcs-muted">').text('在此生成用于在 Luker 对话界面“文件库”中连接当前账号的专用令牌。出于安全考虑，新令牌仅在生成后展示一次，请妥善保存。')
    );
    const label=field('令牌标识名称（区分客户端）','Luker-桌面客户端');
    const shared=$('<input type="checkbox">');
    panel.append(label.element);
    if(session.user.admin){
        panel.append($('<label class="gcs-checkbox">').append(shared,' 允许插件访问共享目录（仅支持浏览、上传和导入，不开放管理配置权限）'));
    }
    const tokenOutput=$('<div style="margin: 12px 0;">');
    const generateBtn = button('生成连接令牌',async()=>{
        const result=await api('/tokens',{label:label.input.val(),shared:shared.prop('checked')});
        const copyBtn=$('<button type="button" class="menu_button" style="margin-top:6px;">').text('复制令牌').on('click',async()=>{
            try{await navigator.clipboard.writeText(result.token);copyBtn.text('✓ 已复制到剪贴板');setTimeout(()=>copyBtn.text('复制令牌'),1500);}catch(e){notice('请长按或手动选择复制');}
        });
        tokenOutput.empty().append(
            $('<p class="gcs-muted" style="color:#059669;font-weight:600;">').text('✓ 令牌已生成（仅展示一次，请复制后在 Luker 文件库连接窗口粘贴）：'),
            $('<input readonly class="token">').val(result.token),
            copyBtn
        );
        await tokens();
    },'menu_button gcs-primary');
    panel.append($('<div style="margin: 12px 0 16px;">').append(generateBtn), tokenOutput);

    panel.append($('<h3>').text('已授权的令牌列表'));
    const rows=$('<div class="gcs-token-list" style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">');
    panel.append(rows);
    async function tokens(){
        rows.empty();
        const res=await api('/tokens');
        if(!res.items.length){
            rows.append($('<p class="gcs-muted">').text('暂无已授权的令牌。'));
            return;
        }
        for(const t of res.items){
            const row=$('<div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">');
            const info=$('<div>').append(
                $('<strong>').text(t.label),
                $('<div class="gcs-muted" style="font-size:0.8rem;margin-top:2px;">').text('签发于 ' + new Date(t.created).toLocaleString())
            );
            row.append(info, button('撤销授权',async()=>{await api('/tokens/'+t.id+'/revoke',{});notice('令牌已撤销，相关连接已断开。');await tokens();},'menu_button danger'));
            rows.append(row);
        }
    }
    await tokens();
    await new Popup(panel,1,'',{okButton:'完成'}).show();
}

async function nodes(){
    const panel=$('<section class="gcs-admin-dialog">').append(
        $('<h2>').text('分布式节点与存储策略'),
        $('<p class="gcs-muted">').text('监控后台解析下载节点运行状态、管理各站点解析代理出口，并配置全局文件生命周期自动清理周期。')
    );
    const settings=await api('/settings');
    for(const node of settings.import_workers){
        const row=$('<div class="row" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:14px;">').append($('<h3>').text(node.label || node.id));
        panel.append(row);
        let health;
        try{health=await api('/nodes/'+node.id);}
        catch(e){row.append($('<p class="danger">').text('节点状态异常：' + e.message));continue;}
        const c=health.capabilities;
        row.append(
            $('<div style="display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px;">').append(
                $('<span class="gcs-storage-label">').text(`核心版本 v${health.version}`),
                $('<span class="gcs-storage-label">').text(`活跃任务: ${health.active}`),
                $('<span class="gcs-storage-label">').text(`GCS私有读取: ${c.private_gcs_read?'可用':'未配置'}`),
                $('<span class="gcs-storage-label">').text(`支持解析: ${(c.available_sites||[]).join(' / ') || '无'}`)
            )
        );
        const proxies={};
        const proxyGrid=$('<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-bottom:12px;">');
        for(const site of ['bilibili','youtube','iwara','direct']){
            const labelMap = { bilibili:'B站 (Bilibili) 解析代理', youtube:'YouTube 解析代理', iwara:'Iwara 解析代理', direct:'通用直链解析代理' };
            proxies[site]=field((labelMap[site]||site) + '（留空为直连）',c.parser_proxies[site]||'');
            proxyGrid.append(proxies[site].element);
        }
        row.append(
            proxyGrid,
            $('<p class="gcs-muted" style="margin-bottom:10px;">').text('B站与 Iwara 默认由节点网卡直连解析；YouTube 媒体与解析走相同出口线路。代理配置将在节点空闲时平滑切换。'),
            button('保存并应用代理配置',async()=>{
                await api('/nodes/'+node.id,{parser_proxies:Object.fromEntries(Object.entries(proxies).filter(([,f])=>f.input.val()).map(([k,f])=>[k,f.input.val()]))});
                notice('节点代理配置已更新生效。');
            },'menu_button gcs-primary')
        );
        for(const site of c.selector_sites){
            try{
                const egress=await api('/nodes/'+node.id+'/egress/'+site);
                const select=$('<select class="text_pole">');
                for(const name of egress.choices)select.append($('<option>').val(name).text(name));
                select.val(egress.selected);
                row.append(
                    $('<div style="display:flex;align-items:flex-end;gap:10px;margin-top:12px;">').append(
                        $('<label style="flex:1;margin:0;">').append($('<span>').text(site+' 当前网络出口线路'),select),
                        button('切换 '+site+' 出口',async()=>{await api('/nodes/'+node.id+'/egress/'+site,{name:select.val()});notice(site+' 出口线路已切换。');})
                    )
                );
            }catch(e){row.append($('<p class="danger">').text(site+' 出口获取失败：'+e.message));}
        }
    }
    const days=field('文件自动清理周期（1–30 天，超时清理缓存）',7,'number');
    const actual=$('<pre style="margin-top:10px;">');
    const refresh=async()=>actual.text(JSON.stringify(await api('/policy'),null,2));
    panel.append(
        $('<div style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:16px;">').append(
            $('<h3>').text('全局存储生命周期保留策略'),
            $('<p class="gcs-muted">').text('超过设定保留天数的临时文件与云端转存副本将由系统自动安全回收，避免存储空间过度占用。'),
            days.element,
            $('<div style="display:flex;gap:10px;margin:10px 0;">').append(
                button('保存并更新清理策略',async()=>{const result=await api('/policy',{days:Number(days.input.val())});notice(result.message);await refresh();},'menu_button gcs-primary'),
                button('查询当前生效参数',refresh)
            ),
            actual
        )
    );
    await refresh().catch(e=>actual.text(e.message));
    await new Popup(panel,1,'',{okButton:'关闭'}).show();
}

async function users(){
    const panel=$('<section class="gcs-admin-dialog">').append(
        $('<h2>').text('用户与密码管理')
    );
    const currentPassword=field('修改当前账号登录密码（至少 12 位）','','password');
    panel.append(
        $('<div style="margin-bottom:20px;">').append(
            currentPassword.element,
            button('确认修改密码',async()=>{
                await api('/password',{password:currentPassword.input.val()});
                currentPassword.input.val('');
                notice('登录密码已更新成功。');
            },'menu_button gcs-primary')
        )
    );
    if(session.user.admin){
        panel.append($('<h3 style="border-top:1px solid #e2e8f0;padding-top:16px;">').text('系统用户列表'));
        const list=$('<div style="display:flex;flex-direction:column;gap:8px;margin:10px 0;">');
        panel.append(list);
        async function refresh(){
            list.empty();
            const res=await api('/users');
            for(const u of res.items){
                const row=$('<div class="row" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;">');
                const meta=$('<div>').append(
                    $('<strong>').text(u.handle),
                    $('<div style="display:flex;gap:6px;margin-top:4px;">').append(
                        $('<span class="gcs-storage-label">').text(u.admin?'管理员':'标准用户'),
                        $('<span class="gcs-storage-label">').css('color',u.disabled?'#dc2626':'#059669').text(u.disabled?'已禁用':'正常使用')
                    )
                );
                row.append(meta);
                if(u.handle!==session.user.handle){
                    row.append(button(u.disabled?'恢复启用账号':'禁用账号并撤销全部令牌',async()=>{
                        await api('/users/'+u.handle,{disabled:!u.disabled});
                        notice(u.disabled?'账号已恢复正常使用。':'账号已禁用，其签发的全部插件令牌已撤销。');
                        await refresh();
                    },u.disabled?'menu_button':'menu_button danger'));
                }
                list.append(row);
            }
        }
        await refresh();
        const handle=field('新账号用户名');
        const password=field('初始登录密码','','password');
        const admin=$('<input type="checkbox">');
        panel.append(
            $('<div style="border-top:1px solid #e2e8f0;padding-top:16px;margin-top:16px;">').append(
                $('<h3>').text('添加新用户'),
                $('<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">').append(handle.element,password.element),
                $('<label class="gcs-checkbox" style="margin:8px 0 14px;">').append(admin,' 设为系统管理员'),
                button('创建账号',async()=>{
                    await api('/users',{handle:handle.input.val(),password:password.input.val(),admin:admin.prop('checked')});
                    password.input.val('');
                    handle.input.val('');
                    notice('新用户账号已成功创建。');
                    await refresh();
                },'menu_button gcs-primary')
            )
        );
    }
    await new Popup(panel,1,'',{okButton:'关闭'}).show();
}

async function start(){
    session=await api('/session');
    csrf=session.csrf;
    $('#login').hide();
    $('#account').empty().append(
        $('<span>').text(session.user.handle + (session.user.admin ? ' (管理员)' : '')),
        button('Luker 授权令牌',account),
        button('用户与密码',users)
    );
    if(session.user.admin)$('#account').append(button('节点与策略',nodes));
    $('#account').append(button('退出登录',async()=>{await api('/logout',{});location.reload();},'menu_button gcs-subtle'));
    await showLibrary({
        API,
        context,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        mount:$('#library'),
        createSettingsPanel:(ctx,saved)=>createSettingsPanel(ctx,saved,API)
    });
}

$('#login form').on('submit',async function(e){
    e.preventDefault();
    const status=$(this).find('[role=status]');
    status.empty();
    try{
        await api('/login',{handle:this.handle.value,password:this.password.value});
        this.password.value='';
        await start();
    }catch(e){
        status.text(e.message);
    }
});

const queryParams = new URLSearchParams(location.search);
if (queryParams.get('login') === '1') {
    $('#login').show();
} else {
    start().then(() => {
        const dialog = queryParams.get('dialog');
        if (dialog === 'account') account();
        else if (dialog === 'users') users();
        else if (dialog === 'nodes' && session?.user?.admin) nodes();
    }).catch(()=>$('#login').show());
}
