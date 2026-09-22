import {showLibrary} from './library-ui.js';
import {createSettingsPanel} from './settings.js';
const API=new URL('api',location.href).pathname;
let csrf='';let session;
const context=()=>({getRequestHeaders:()=>({'Content-Type':'application/json','X-CSRF-Token':csrf})});
async function api(route,body){const r=await fetch(API+route,{headers:context().getRequestHeaders(),...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await r.json().catch(()=>({error:'请求失败，请重新登录。'}));if(!r.ok)throw Error(data.error);return data;}
let noticeTimer;function notice(text){$('#notice').text(text);clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('#notice').empty(),6000);}
globalThis.toastr={error:notice,warning:notice,success:notice};
const POPUP_TYPE={TEXT:1,CONFIRM:2},POPUP_RESULT={AFFIRMATIVE:1};
class Popup{constructor(body,type,unused,options={}){Object.assign(this,{body,type,options});}show(){return new Promise(resolve=>{const dialog=$('<dialog>').append(this.body).appendTo('body');const end=value=>{dialog[0].close();dialog.remove();resolve(value);};const footer=$('<footer>').append($('<button>').text(this.options.okButton||'关闭').on('click',()=>end(1)));if(this.type===2)footer.prepend($('<button>').text('取消').on('click',()=>end(0)));dialog.append(footer).on('cancel',e=>{e.preventDefault();end(0);});dialog[0].showModal();});}}
const field=(label,value='',type='text')=>{const input=$('<input>').attr('type',type).val(value);return {input,element:$('<label>').append($('<span>').text(label),input)};};const button=(label,action)=>$('<button type="button">').text(label).on('click',async()=>{try{await action();}catch(e){notice(e.message);}});
async function account(){
    const panel=$('<section>').append($('<h2>').text('账号与插件连接'));
    const label=field('令牌名称','Luker');const shared=$('<input type="checkbox">');
    panel.append(label.element);if(session.user.admin)panel.append($('<label>').append(shared,' 授权插件浏览共享目录、上传和导入（不含管理、删除和配置权限）'));
    const tokenOutput=$('<div>');panel.append(button('生成专用令牌',async()=>{const result=await api('/tokens',{label:label.input.val(),shared:shared.prop('checked')});tokenOutput.empty().append($('<p>').text('仅显示一次。复制到 Luker 的“连接文件库”。'),$('<input readonly class="token">').val(result.token));await tokens();}),tokenOutput);
    const rows=$('<div>');panel.append(rows);
    async function tokens(){rows.empty();for(const t of (await api('/tokens')).items)rows.append($('<p>').text(t.label+' · '+new Date(t.created).toLocaleString()+' ').append(button('撤销',async()=>{await api('/tokens/'+t.id+'/revoke',{});await tokens();})));}await tokens();
    const password=field('修改独立登录密码（至少 12 字符）','','password');panel.append(password.element,button('更新密码',async()=>{await api('/password',{password:password.input.val()});password.input.val('');notice('密码已更新。');}));
    await new Popup(panel,1).show();
}
async function nodes(){
    const panel=$('<section>').append($('<h2>').text('节点与存储策略'));const settings=await api('/settings');
    for(const node of settings.import_workers){const row=$('<div class="row">').append($('<h3>').text(node.label));panel.append(row);let health;try{health=await api('/nodes/'+node.id);}catch(e){row.append($('<p>').text(e.message));continue;}
        const c=health.capabilities;row.append($('<p>').text(`版本 ${health.version} · 活跃任务 ${health.active} · 私有 GCS 读取 ${c.private_gcs_read?'可用':'未配置'} · 可解析 ${(c.available_sites||[]).join('、')}`));
        const proxies={};for(const site of ['iwara','bilibili','youtube','direct']){proxies[site]=field(site+' 解析代理（空为节点直连）',c.parser_proxies[site]||'');row.append(proxies[site].element);}
        row.append($('<p>').text('Iwara/B站媒体由节点直连；YouTube 使用同一解析和媒体出口。代理切换会在任务空闲时进行。'),button('校验并应用代理',async()=>{await api('/nodes/'+node.id,{parser_proxies:Object.fromEntries(Object.entries(proxies).filter(([,f])=>f.input.val()).map(([k,f])=>[k,f.input.val()]))});notice('节点已应用。');}));
        for(const site of c.selector_sites){try{const egress=await api('/nodes/'+node.id+'/egress/'+site);const select=$('<select>');for(const name of egress.choices)select.append($('<option>').val(name).text(name));select.val(egress.selected);row.append($('<label>').append($('<span>').text(site+' 当前出口'),select),button('切换 '+site+' 出口',async()=>{await api('/nodes/'+node.id+'/egress/'+site,{name:select.val()});notice('出口已切换。');}));}catch(e){row.append($('<p>').text(site+'：'+e.message));}}
    }
    const days=field('统一保留天数（1–30）',7,'number');const actual=$('<pre>');const refresh=async()=>actual.text(JSON.stringify(await api('/policy'),null,2));panel.append(days.element,button('应用存储保留策略',async()=>{const result=await api('/policy',{days:Number(days.input.val())});notice(result.message);await refresh();}),button('核对实际生效策略',refresh),actual);await refresh().catch(e=>actual.text(e.message));await new Popup(panel,1).show();
}
async function users(){const panel=$('<section>').append($('<h2>').text('用户管理'));const list=$('<div>');panel.append(list);async function refresh(){list.empty();for(const u of (await api('/users')).items){const row=$('<p>').text(`${u.handle} · ${u.admin?'管理员':'用户'} · ${u.disabled?'停用':'启用'} `);if(u.handle!==session.user.handle)row.append(button(u.disabled?'启用':'停用并撤销全部令牌',async()=>{await api('/users/'+u.handle,{disabled:!u.disabled});await refresh();}));list.append(row);}}await refresh();const handle=field('新用户名'),password=field('初始密码','','password'),admin=$('<input type="checkbox">');panel.append(handle.element,password.element,$('<label>').append(admin,' 管理员'),button('创建用户',async()=>{await api('/users',{handle:handle.input.val(),password:password.input.val(),admin:admin.prop('checked')});password.input.val('');await refresh();}));await new Popup(panel,1).show();}
async function start(){session=await api('/session');csrf=session.csrf;$('#login').hide();$('#account').empty().append($('<span>').text(session.user.handle),button('账号与令牌',account));if(session.user.admin)$('#account').append(button('节点与策略',nodes),button('用户',users));$('#account').append(button('退出',async()=>{await api('/logout',{});location.reload();}));await showLibrary({API,context,Popup,POPUP_TYPE,POPUP_RESULT,mount:$('#library'),createSettingsPanel:(ctx,saved)=>createSettingsPanel(ctx,saved,API)});}
$('#login form').on('submit',async function(e){e.preventDefault();try{await api('/login',{handle:this.handle.value,password:this.password.value});this.password.value='';await start();}catch(e){$(this).find('[role=status]').text(e.message);}});
start().catch(()=>$('#login').show());
