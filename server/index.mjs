/** Luker host adapter: user-scoped metadata API and native Gemini conversion relay. */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRelay} from './relay.mjs';
import {defaults,allowsModel} from './settings.mjs';
export const info={id:'gcs-video',name:'File Library',description:'Connect a user-scoped independent file library to this turn.'};
const file=path.resolve('config/gcs-video/connection.json');
let relay;
export async function init(router){
    const {default:fetchImpl}=await import('node-fetch');
    const secrets=await import(pathToFileURL(path.resolve('src/endpoints/secrets.js')).href);
    const relayConfig={...defaults};relay=createRelay(relayConfig,fetchImpl);
    await new Promise((resolve,reject)=>{relay.server.once('error',reject);relay.server.listen(relayConfig.port,'127.0.0.1',resolve);});
    const read=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{service_url:'',users:{}};
    const save=data=>{fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);};
    const handle=req=>req.user?.profile?.handle;
    async function call(req,route,body,override){
        const c=read();const token=override||c.users[handle(req)]?.token;
        if(!token)throw Object.assign(Error('请先连接独立文件库。'),{status:401});
        const url=new URL(c.service_url);if(url.protocol!=='https:')throw Error('Invalid service URL');
        const response=await fetchImpl(c.service_url.replace(/\/$/,'')+'/api'+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...(req.headers.origin?{'X-Client-Origin':req.headers.origin}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
        const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(Error(data.error||'独立文件库暂不可用。'),{status:response.status});return data;
    }
    router.use((req,res,next)=>handle(req)?next():res.sendStatus(401));
    router.get('/connection',(req,res)=>res.json({app_url:read().service_url,connected:Boolean(read().users[handle(req)]?.token)}));
    router.post('/connection',async(req,res)=>{try{const token=String(req.body?.token||'');if(!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw Error('令牌格式无效。');const remote=await call(req,'/config',null,token);const c=read();c.users[handle(req)]={token,remote_user:remote.user};save(c);res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
    router.post('/disconnect',(req,res)=>{const c=read();delete c.users[handle(req)];save(c);res.json({ok:true});});
    router.post('/prepare',async(req,res)=>{
        try{const body=req.body||{};const config=await call(req,'/config');Object.assign(relayConfig,config);await call(req,'/authorize',{video:body.video});
            if(!allowsModel(config,body.model)||body.chat_completion_source!=='makersuite'||String(body.upstream||'').replace(/\/$/,'')!==config.upstream)throw Error('请选择允许的 Gemini 连接和模型。');
            const key=typeof body.proxy_password==='string'&&body.proxy_password?body.proxy_password:secrets.readProviderSecret(req,secrets.SECRET_KEYS.MAKERSUITE);
            res.json(relay.prepare(body.video,key,handle(req),body.model));
        }catch(e){res.status(400).json({error:e.message});}
    });
    router.use(async(req,res)=>{try{if(!['GET','POST'].includes(req.method))return res.sendStatus(405);res.set('Cache-Control','no-store').json(await call(req,req.url,req.method==='POST'?req.body:undefined));}catch(e){res.status(e.status||502).json({error:e.message});}});
}
export async function exit(){if(relay)await relay.close();}
