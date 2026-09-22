"""Validated runtime settings and optional HTTP proxy selector; never executes shell."""
import copy
import fcntl
import hashlib
import json
import pathlib
import urllib.parse
import urllib.request

KEYS=('parser_proxies','max_bytes','retention_seconds','https_max_bytes')
def runtime_file(config):return pathlib.Path(config['download_directory']).parent/'runtime.json'
def atomic(file,value):
    file=pathlib.Path(file);temporary=file.with_suffix('.tmp');temporary.write_text(json.dumps(value));temporary.chmod(0o600);temporary.replace(file)
def apply(config,data):
    if 'parser_proxies' in data:config['parser_proxies']=data['parser_proxies']
    if 'max_bytes' in data:config['max_bytes']=data['max_bytes']
    if 'https_max_bytes' in data:config['small_video']['max_bytes']=data['https_max_bytes']
    if 'retention_seconds' in data:
        config['small_video']['copyparty']['retention_seconds']=data['retention_seconds']
        for volume in config.get('library_volumes',[]):volume['retention_seconds']=data['retention_seconds']
def load(config):
    file=runtime_file(config)
    if file.exists():apply(config,json.loads(file.read_text()))
def visible(config):
    data={'parser_proxies':config.get('parser_proxies',{}),'max_bytes':config['max_bytes'],'https_max_bytes':config['small_video']['max_bytes'],'retention_seconds':config['small_video']['copyparty']['retention_seconds']}
    state=runtime_file(config).parent/'policy-applied.json'
    data['retention_applied']=json.loads(state.read_text()) if state.exists() else None
    data['available_sites']=[site for site in ('iwara','bilibili','youtube') if site not in config.get('required_proxy_sites',[]) or config.get('parser_proxies',{}).get(site) or config.get('parser_proxy')]
    data['private_gcs_read']=bool(config.get('gcs_private_endpoint'))
    data['selector_sites']=list(config.get('egress_control',{}).get('groups',{}))
    return data

def save(config,body,jobs):
    if any(j['status'] in ('queued','downloading','publishing','ready','running','receiving') for j in jobs.values()):raise ValueError('请等待活跃任务完成再修改节点配置。')
    data={k:body[k] for k in KEYS if k in body}
    for key,lo,hi in [('max_bytes',1,2147483648),('retention_seconds',86400,2592000),('https_max_bytes',1,15000000)]:
        if key in data and (type(data[key]) is not int or not lo<=data[key]<=hi):raise ValueError('配置数值无效。')
    if 'parser_proxies' in data:
        if not isinstance(data['parser_proxies'],dict) or set(data['parser_proxies'])-{'iwara','bilibili','youtube','direct'}:raise ValueError('站点配置无效。')
        for url in data['parser_proxies'].values():
            p=urllib.parse.urlsplit(url)
            if p.scheme!='http' or not p.hostname or not p.port or p.username or p.password or p.path not in ('','/') or p.query or p.fragment:raise ValueError('请使用无密码的可信 HTTP 代理入口。')
    current=json.loads(runtime_file(config).read_text()) if runtime_file(config).exists() else {}
    current.update(data);atomic(runtime_file(config),current);apply(config,current)
    return visible(config)

def selector(config,site,name=None):
    ctl=config.get('egress_control',{});group=ctl.get('groups',{}).get(site)
    if not group:raise ValueError('此节点未配置该站点的出口选择器。')
    headers={}
    if ctl.get('token_file'):headers['Authorization']='Bearer '+pathlib.Path(ctl['token_file']).read_text().strip()
    url=ctl['url'].rstrip('/')+'/proxies/'+urllib.parse.quote(group,safe='')
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def call(method='GET',body=None):
        req=urllib.request.Request(url,data=json.dumps(body).encode() if body else None,method=method,headers={**headers,'Content-Type':'application/json'})
        with opener.open(req,timeout=15) as response:return json.loads(response.read() or '{}')
    if name is None:
        data=call();return {'selected':data.get('now'),'choices':data.get('all',[])}
    if not config.get('egress_lock_file'):raise ValueError('出口锁未配置。')
    with open(config['egress_lock_file'],'a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise ValueError('下载任务正在使用出口，请完成或取消后切换。')
        if name not in call().get('all',[]):raise ValueError('未知出口。')
        call('PUT',{'name':name})
    return {'ok':True}
