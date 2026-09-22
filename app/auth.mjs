import fs from 'node:fs';
import {randomBytes,scryptSync,timingSafeEqual,createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
export function passwordHash(password){if(typeof password!=='string'||password.length<12||password.length>256)throw Error('密码需为 12–256 个字符。');const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(password,salt,32).toString('hex');}
export function createAuth(file,{public_url}){
    const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{users:[],tokens:[],sessions:[]};
    function save(){fs.writeFileSync(file+'.tmp',JSON.stringify(data),{mode:0o600});fs.renameSync(file+'.tmp',file);}
    const expose=user=>({handle:user.handle,admin:user.admin,disabled:!!user.disabled});
    const origin=new URL(public_url).origin;
    const cookiePath=new URL(public_url).pathname;
    const rates=new Map();
    function user(handle){return data.users.find(u=>u.handle===handle&&!u.disabled);}
    function mint(handle,label,shared=false){const token=randomBytes(32).toString('base64url');const entry={id:randomBytes(12).toString('hex'),hash:hash(token),handle,label:String(label||'插件').slice(0,80),shared:shared&&user(handle)?.admin===true,created:Date.now()};data.tokens.push(entry);save();return {token,id:entry.id};}
    function authenticate(req,res,next){
        const bearer=req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
        let record;
        if(bearer){record=data.tokens.find(t=>t.hash===hash(bearer));req.pluginToken=record;if(!record)return res.sendStatus(401);}
        else {const sid=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('library_session='))?.slice(16);record=sid&&data.sessions.find(s=>s.hash===hash(sid)&&s.expires>Date.now());req.session=record;if(!record)return res.sendStatus(401);}
        const current=user(record.handle);if(!current)return res.sendStatus(401);
        req.user={profile:{handle:current.handle,admin:current.admin===true&&(!bearer||record.shared===true)}};
        req.account=current;
        if(!bearer&&!['GET','HEAD','OPTIONS'].includes(req.method)&&(req.headers.origin!==origin||req.headers['x-csrf-token']!==record.csrf))return res.sendStatus(403);
        if(bearer){
            // Plugin tokens cannot administer identities, credentials, deletion or configuration.
            const allowed=/^\/(config|files|file-sources|videos|metadata|uploads|local-uploads(?:\/finish)?|imports(?:\/[^/]+)?|tasks(?:\/[^/]+\/(?:cancel|retry))?|file-attach|file-access|authorize)$/;
            if(!allowed.test(req.path))return res.sendStatus(403);
            const incoming=req.headers['x-client-origin'];
            if(incoming){try{const p=new URL(incoming);if(!['https:','http:'].includes(p.protocol)||p.origin!==incoming)throw Error();req.clientOrigin=incoming;}catch{return res.sendStatus(400);}}
        }
        next();
    }
    function admin(req,res,next){if(req.pluginToken||!req.account.admin)return res.sendStatus(403);next();}
    function register(router){
        router.post('/login',(req,res)=>{
            if(req.headers.origin!==origin)return res.sendStatus(403);
            const key=req.ip;const attempts=(rates.get(key)||[]).filter(t=>t>Date.now()-900000);rates.set(key,attempts);
            if(attempts.length>=15)return res.status(429).json({error:'尝试过多，请 15 分钟后重试。'});attempts.push(Date.now());
            const current=user(req.body?.handle);let valid=false;
            if(current&&typeof req.body.password==='string'&&req.body.password.length<=256){const [salt,wanted]=current.password.split(':');valid=timingSafeEqual(scryptSync(req.body.password,salt,32),Buffer.from(wanted,'hex'));}
            if(!valid)return res.status(401).json({error:'账号或密码错误。'});
            const sid=randomBytes(32).toString('base64url');const csrf=randomBytes(24).toString('hex');
            data.sessions=data.sessions.filter(s=>s.expires>Date.now());data.sessions.push({hash:hash(sid),handle:current.handle,csrf,expires:Date.now()+12*3600000});save();
            res.set('Set-Cookie',`library_session=${sid}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`).json({ok:true});
        });
        router.use(authenticate);
        router.get('/session',(req,res)=>res.json({user:expose(req.account),csrf:req.session.csrf}));
        router.post('/logout',(req,res)=>{data.sessions=data.sessions.filter(s=>s!==req.session);save();res.set('Set-Cookie',`library_session=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`).json({ok:true});});
        router.post('/password',(req,res)=>{try{req.account.password=passwordHash(req.body.password);data.sessions=data.sessions.filter(s=>s.handle!==req.account.handle||s===req.session);save();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
        router.get('/tokens',(req,res)=>res.json({items:data.tokens.filter(t=>t.handle===req.account.handle).map(({hash,...t})=>t)}));
        router.post('/tokens',(req,res)=>res.json(mint(req.account.handle,req.body.label,req.body.shared===true)));
        router.post('/tokens/:id/revoke',(req,res)=>{data.tokens=data.tokens.filter(t=>t.id!==req.params.id||t.handle!==req.account.handle);save();res.json({ok:true});});
        router.get('/users',admin,(req,res)=>res.json({items:data.users.map(expose)}));
        router.post('/users',admin,(req,res)=>{try{const {handle,password,admin:role}=req.body;if(!/^[a-zA-Z0-9_-]{1,64}$/.test(handle)||data.users.some(u=>u.handle===handle))throw Error('用户名已存在或格式无效。');data.users.push({handle,password:passwordHash(password),admin:role===true});save();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
        router.post('/users/:handle',admin,(req,res)=>{try{const target=data.users.find(u=>u.handle===req.params.handle);if(!target||target.handle===req.account.handle)throw Error('不能在此修改当前账号。');if(req.body.password)target.password=passwordHash(req.body.password);if(typeof req.body.disabled==='boolean')target.disabled=req.body.disabled;data.sessions=data.sessions.filter(s=>s.handle!==target.handle);data.tokens=data.tokens.filter(t=>t.handle!==target.handle);save();res.json({ok:true});}catch(e){res.status(400).json({error:e.message});}});
    }
    return {register,admin,mint};
}
