import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {createAuth,passwordHash} from '../app/auth.mjs';
test('sessions require CSRF; plugin tokens cannot manage accounts and revoke immediately',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'library-auth-'));const file=path.join(dir,'accounts.json');
 fs.writeFileSync(file,JSON.stringify({users:[{handle:'owner',admin:true,password:passwordHash('A-strong-test-password')}],tokens:[],sessions:[]}));
 const app=express();app.use(express.json());const router=express.Router();const auth=createAuth(file,{public_url:'https://library.example/library/'});auth.register(router);router.get('/config',(req,res)=>res.json(req.user.profile));app.use(router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 try {
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://library.example',...headers},body:JSON.stringify(body)});
  const login=await post('/login',{handle:'owner',password:'A-strong-test-password'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const session=await(await fetch(base+'/session',{headers:{cookie}})).json();assert.equal(session.user.handle,'owner');
  assert.equal((await post('/tokens',{label:'test'},{cookie})).status,403);
  const token=await(await post('/tokens',{label:'test',shared:true},{cookie,'x-csrf-token':session.csrf})).json();const headers={Authorization:'Bearer '+token.token};
  assert.equal((await fetch(base+'/users',{headers})).status,403);assert.equal((await fetch(base+'/config',{headers})).status,200);
  await post('/tokens/'+token.id+'/revoke',{}, {cookie,'x-csrf-token':session.csrf});assert.equal((await fetch(base+'/config',{headers})).status,401);
  assert.ok(!fs.readFileSync(file,'utf8').includes(token.token));
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true});}
});
