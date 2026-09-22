import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadMetadata, userPrefix } from '../server/storage.mjs';
import { uploadResumable } from '../upload.js';

test('uploads are unique and confined to the authenticated user prefix', () => {
    const config = { bucket: 'private-videos', max_upload_bytes: 1000000 };
    const input = { filename: '../test.mp4', size: 200, duration_seconds: 20 };
    const a = uploadMetadata(input, 'default-user', config);
    const b = uploadMetadata(input, 'default-user', config);
    assert.equal(a.object.name.startsWith('videos/default-user/'), true);
    assert.notEqual(a.object.name, b.object.name);
    assert.equal(a.object.contentType, 'video/mp4');
    assert.throws(() => userPrefix('../another-user'));
    assert.throws(() => uploadMetadata({ ...input, size: 1000001 }, 'default-user', config));
    const html = uploadMetadata({ ...input, filename: 'file.html' }, 'default-user', config);
    assert.equal(html.video.attachable, false);
    assert.equal(html.object.contentType, 'application/octet-stream');
});

test('resumes from server-confirmed offset and sends only remaining chunks', async () => {
    const file = new File([new Uint8Array(10)], 'test.mp4');
    const ranges = [];
    const responses = [
        new Response('', { status: 308, headers: { Range: 'bytes=0-3' } }),
        new Response('', { status: 308, headers: { Range: 'bytes=0-7' } }),
        new Response('{}', { status: 200 }),
    ];
    await uploadResumable(file, 'https://storage.googleapis.com/session', { chunkSize: 4, fetchImpl: async (_, options) => { ranges.push(options.headers['Content-Range']); return responses.shift(); } });
    assert.deepEqual(ranges, ['bytes */10', 'bytes 4-7/10', 'bytes 8-9/10']);
});

test('expired sessions fail instead of silently overwriting or restarting files', async () => {
    const file = new File([new Uint8Array(10)], 'test.mp4');
    await assert.rejects(uploadResumable(file, 'https://storage.googleapis.com/session', { fetchImpl: async () => new Response('', { status: 410 }) }), /410/);
});

test('copyparty node upload resumes without sending chunks to Google',async()=>{
    const {uploadToNode}=await import('../upload.js');
    const file=new File(['abcdefgh'],'test.txt');let offset=4;const chunks=[];
    await uploadToNode(file,'https://node.example/upload-data/test',{chunkSize:4,fetchImpl:async(url,options={})=>{
        assert.equal(url,'https://node.example/upload-data/test');assert.equal(options.credentials,'omit');
        if(options.method==='PUT'){chunks.push(options.headers['Content-Range']);assert.equal(await options.body.text(),'efgh');offset=8;}
        return new Response(JSON.stringify({offset,complete:offset===8}),{status:200});
    }});
    assert.deepEqual(chunks,['bytes 4-7/8']);
});
