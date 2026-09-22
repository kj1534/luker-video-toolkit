import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {registerFileLibrary} from '../server/file-library.mjs';
import {fileInfo,createVideoAttachment} from '../media.js';

function fixture(t) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'file-library-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
    const routes=new Map();const calls=[];const jobs=[];
    const shared={storage:'copyparty',url:'https://media.example/report.pdf?k=fixture',title:'report.pdf',size:20000000,volume:'files',path:'report.pdf',modified:1};
    const gcs={storage:'gcs',url:'gs://private-bucket/videos/alice/report.pdf',title:'report.pdf',size:20000000,generation:'1'};
    const copyFile=path.join(dir,'copies.json');
    registerFileLibrary({get:(route,handler)=>routes.set('GET '+route,handler),post:(route,handler)=>routes.set('POST '+route,handler)}, {
        config:{https_max_bytes:14000000,default_import_worker:'primary',gcs_read_worker:'reader',copyparty_worker:'primary',copyparty_volume:'files',import_workers:[{id:'primary',library_enabled:true,label:'Primary'},{id:'reader',url:'https://reader.example/gcs-import'}]},
        storage:()=>({list:async()=>({items:[gcs],nextPageToken:''}),stat:async()=>gcs,access:async()=>({url:'https://storage.googleapis.com/signed-fixture',file:gcs}),remove:async()=>({ok:true})}),
        worker:async(id,route,body)=>{calls.push({id,route,body});return route==='/downloads'?{ticket:'a'.repeat(43),expires_seconds:300}:route==='/library/roots'?{volumes:[{id:'files',label:'Files'}]}:route==='/library/list'?{items:[shared]}:shared;},
        startJob:async(user,id,url,options)=>{jobs.push({user,id,url,options});return{id:'job'};},catalog:()=>[],copyFile,forgetCatalog:()=>{},
    });
    async function request(method,route,body={},admin=false,query={}){let result,status=200;const response={set(){return this;},status(code){status=code;return this;},sendStatus(code){status=code;},json(value){result=value;}};await routes.get(method+' '+route)({user:{profile:{handle:'alice',admin}},body,query},response);return{status,result};}
    return {request,calls,jobs,shared,gcs,copyFile};
}
test('ordinary users cannot enumerate or mutate shared folders',async t=>{
    const f=fixture(t);
    assert.equal((await f.request('GET','/file-sources')).result.items.length,1);
    for(const route of ['/file-delete','/file-access','/file-attach'])assert.equal((await f.request('POST',route,{file:{...f.shared,worker_id:'primary'}})).status,403);
    assert.equal((await f.request('GET','/files',{},false,{storage:'copyparty',worker_id:'primary',volume:'files'})).status,403);
    assert.equal(f.calls.length,0);
});
test('large shared attachments promote once; small files use their existing direct URL',async t=>{
    const f=fixture(t);const file={...f.shared,worker_id:'primary'};
    assert.ok((await f.request('POST','/file-attach',{file},true)).result.job);
    assert.equal(f.jobs[0].options.destination,'gcs');assert.equal(f.jobs[0].id,'primary');
    fs.writeFileSync(f.copyFile,JSON.stringify({[f.jobs[0].options.copyKey]:f.gcs.url}));
    const repeat=await f.request('POST','/file-attach',{file},true);assert.equal(repeat.result.reused,true);assert.equal(f.jobs.length,1);
    f.shared.size=1000;const small=await f.request('POST','/file-attach',{file},true);assert.equal(small.result.file.url,f.shared.url);assert.equal(f.jobs.length,1);
});
test('GCS copies use the configured private reader, independent of destination',async t=>{
    const f=fixture(t);const result=await f.request('POST','/file-transfer',{file:f.gcs,destination:'copyparty',target:{worker_id:'primary',volume:'files'}},true);
    assert.equal(result.status,200);assert.equal(f.jobs[0].id,'reader');assert.equal(f.jobs[0].options.copyWorker,'primary');assert.equal(f.jobs[0].options.gcs_source,true);assert.equal(f.jobs[0].url,'https://storage.googleapis.com/signed-fixture');assert.equal(f.jobs[0].options.destination,'copyparty');assert.equal(f.jobs[0].options.originGcs,f.gcs.url);assert.equal(f.jobs[0].options.copyVolume,'files');
});
test('PDF, images, audio and text use native fileData MIME types; arbitrary files remain storage-only',()=>{
    for(const [name,type] of [['report.pdf','application/pdf'],['image.png','image/png'],['audio.mp3','audio/mpeg'],['notes.md','text/plain']])assert.equal(createVideoAttachment('gs://private-bucket/videos/alice/'+name).mime_type,type);
    assert.equal(fileInfo('archive.zip').attachable,false);assert.throws(()=>createVideoAttachment('gs://private-bucket/archive.zip'));
});

test('GCS preview and download both stage through reader into copyparty',async t=>{
 const f=fixture(t);
 for(const download of [false,true]) {
  const result=await f.request('POST','/file-access',{file:f.gcs,download},true);
  assert.equal(result.status,200);assert.ok(result.result.job);assert.equal(result.result.url,undefined);
 }
 for(const job of f.jobs){assert.equal(job.id,'reader');assert.equal(job.options.copyWorker,'primary');assert.equal(job.options.gcs_source,true);}
 assert.equal((await f.request('POST','/file-access',{file:f.gcs,download:true})).status,403);
});
