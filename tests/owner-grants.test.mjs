import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync} from 'node:crypto';
import {createStorage} from '../server/storage.mjs';

test('explicit owner grant exposes old objects while new uploads use the new owner', async t => {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'owner-grants-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    const credential_file=path.join(directory,'key.json');
    fs.writeFileSync(credential_file,JSON.stringify({client_email:'fixture@example.iam.gserviceaccount.com',private_key:privateKey}));
    const seen=[];
    const fetchImpl=async (input,options={})=>{
        const url=new URL(input);seen.push({url,options});
        if(url.pathname==='/token')return Response.json({access_token:'fixture',expires_in:3600});
        if(url.pathname.endsWith('/o')&&options.method==='POST')return new Response(null,{status:200,headers:{location:'https://storage.googleapis.com/upload/session'}});
        if(url.pathname.endsWith('/o')){
            const owner=url.searchParams.get('prefix').split('/')[1];
            return Response.json({items:[{name:`videos/${owner}/${owner==='old-admin'?'old':'new'}.pdf`,size:'3',timeCreated:'2026-01-01T00:00:00Z',generation:'1'}]});
        }
        if(decodeURIComponent(url.pathname).endsWith('/videos/old-admin/old.pdf'))return Response.json({name:'videos/old-admin/old.pdf',size:'3',timeCreated:'2026-01-01T00:00:00Z',generation:'1'});
        return new Response(null,{status:404});
    };
    const storage=createStorage({bucket:'private-bucket',credential_file,max_upload_bytes:1000,owner_grants:{'new-admin':['old-admin']}},fetchImpl);
    const first=await storage.list('new-admin');assert.equal(first.items[0].url,'gs://private-bucket/videos/new-admin/new.pdf');assert.ok(first.nextPageToken);
    const second=await storage.list('new-admin',first.nextPageToken);assert.equal(second.items[0].url,'gs://private-bucket/videos/old-admin/old.pdf');
    assert.equal(second.nextPageToken,'');
    assert.equal((await storage.stat(second.items[0].url,'new-admin')).generation,'1');
    await assert.rejects(storage.stat(second.items[0].url,'another-user'));
    const upload=await storage.startUpload({filename:'new.pdf',size:3},'new-admin');
    assert.match(upload.video.url,/^gs:\/\/private-bucket\/videos\/new-admin\//);
    assert.equal(seen.filter(({url})=>url.pathname.endsWith('/o')).length,3);
});
