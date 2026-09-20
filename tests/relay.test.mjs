import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay, injectVideo, validateVideo } from '../server/relay.mjs';
import { createVideoAttachment, getTurnVideo, appendVideoMarker } from '../media.js';

const config = { models: ['example-video-model'], bucket: 'test-video-bucket', prepare_ttl_ms: 120000, request_timeout_ms: 3000 };
const video = createVideoAttachment('gs://test-video-bucket/clip.mp4', 20);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

test('stored video is included for regeneration, excluded after a new user message and reusable', () => {
    const chat = JSON.parse(JSON.stringify([{ is_user: true, extra: { gcs_video: video } }, { is_user: false, mes: 'Saved analysis' }]));
    assert.deepEqual(getTurnVideo(chat), video);
    chat.push({ is_user: true, mes: 'Discuss the answer' });
    assert.equal(getTurnVideo(chat), null);
    chat[2].extra = { gcs_video: video };
    assert.deepEqual(getTurnVideo(chat), video);
    chat[2].is_system = true;
    assert.equal(getTurnVideo(chat), null);
});

test('video marker survives the unmodified Luker Gemini converter', { skip: !existsSync(path.join(process.cwd(), 'src/prompt-converters.js')) }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'gcs-plugin-test-'));
    const file = path.join(directory, 'config.yaml');
    await writeFile(file, '{}\n');
    const { setConfigFilePath } = await import(pathToFileURL(path.join(process.cwd(), 'src/util.js')));
    setConfigFilePath(file);
    const { convertGooglePrompt } = await import(pathToFileURL(path.join(process.cwd(), 'src/prompt-converters.js')));
    const original = [{ role: 'user', content: 'Describe it' }];
    const messages = appendVideoMarker(original, '[test-marker]');
    assert.deepEqual(original, [{ role: 'user', content: 'Describe it' }]);
    const converted = convertGooglePrompt(messages, config.models[0], true, { charName: '', userName: '', startsWithGroupName: () => false });
    const body = { contents: converted.contents, generationConfig: { thinkingConfig: { thinkingLevel: 'low' } }, tools: [{ googleSearch: {} }] };
    const result = injectVideo(body, '[test-marker]', video);
    assert.deepEqual(result.contents[0].parts[1], { fileData: { mimeType: 'video/mp4', fileUri: video.url } });
    assert.deepEqual(result.generationConfig, body.generationConfig);
    assert.deepEqual(result.tools, body.tools);
    assert.equal(JSON.stringify(body).includes('[test-marker]'), true);
    assert.equal(JSON.stringify(result).includes('[test-marker]'), false);
});

test('wrong bucket, invalid durations, missing or duplicate markers are rejected', () => {
    assert.throws(() => validateVideo({ ...video, url: 'gs://other-project/clip.mp4' }, config));
    assert.throws(() => createVideoAttachment(video.url, 0));
    assert.throws(() => injectVideo({ contents: [] }, 'marker', video));
    assert.throws(() => injectVideo({ contents: [{ role: 'user', parts: [{ text: 'marker marker' }] }] }, 'marker', video));
    assert.throws(() => injectVideo({ contents: [{ role: 'model', parts: [{ text: 'marker' }] }] }, 'marker', video));
});

test('mixed text attachments, images, tools and signatures remain intact', () => {
    const text = { text: 'Extracted text from report.txt: quarterly results.' };
    const image = { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } };
    const previous = { role: 'model', parts: [{ text: 'Earlier answer', thoughtSignature: 'signature' }] };
    const input = { contents: [previous, { role: 'user', parts: [text, image, { text: 'Analyze this video. marker' }] }], tools: [{ functionDeclarations: [{ name: 'lookup' }] }], systemInstruction: { parts: [{ text: 'System instruction' }] } };
    const output = injectVideo(input, 'marker', video);
    assert.deepEqual(output.contents[0], previous);
    assert.deepEqual(output.contents[1].parts.slice(0, 2), [text, image]);
    assert.deepEqual(output.tools, input.tools);
    assert.deepEqual(output.systemInstruction, input.systemInstruction);
});

test('private relay preserves native payload, streaming and errors; rejects replay and wrong model', async () => {
    const received = [];
    const upstream = http.createServer(async (request, response) => {
        let body = '';
        for await (const chunk of request) body += chunk;
        received.push({ body: JSON.parse(body), key: request.headers['x-goog-api-key'] });
        if (request.url.includes('streamGenerateContent')) {
            response.writeHead(200, { 'Content-Type': 'text/event-stream' });
            response.end('data: {"candidates":[]}\n\n');
        } else {
            response.writeHead(404, { 'Content-Type': 'application/json' });
            response.end('{"error":{"message":"Object was deleted"}}');
        }
    });
    await listen(upstream);
    const relay = createRelay({ ...config, upstream: `http://127.0.0.1:${upstream.address().port}` }, fetch);
    await listen(relay.server);
    try {
        for (const action of ['generateContent', 'streamGenerateContent']) {
            const job = relay.prepare(video, 'test-secret', 'user-a');
            assert.equal(JSON.stringify(job).includes('test-secret'), false);
            const url = `${job.reverse_proxy}/v1beta/models/${config.models[0]}:${action}?key=${job.proxy_password}`;
            const body = { contents: [{ role: 'user', parts: [{ text: job.marker }] }], systemInstruction: { parts: [{ text: 'Keep this' }] } };
            const wrongModel = await fetch(url.replace(config.models[0], 'ordinary-model'), { method: 'POST', body: JSON.stringify(body) });
            assert.equal(wrongModel.status, 403);
            const result = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
            assert.equal(result.status, action === 'generateContent' ? 404 : 200);
            assert.match(await result.text(), action === 'generateContent' ? /Object was deleted/ : /^data:/);
            const replay = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
            assert.equal(replay.status, 403);
        }
        assert.equal(received.length, 2);
        assert.equal(received[0].key, 'test-secret');
        assert.deepEqual(received[0].body.contents[0].parts, [{ fileData: { mimeType: 'video/mp4', fileUri: video.url } }]);
        assert.deepEqual(received[0].body.systemInstruction, { parts: [{ text: 'Keep this' }] });
    } finally { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
});

test('HTTPS references preserve signed queries and reject unconfigured origins or oversized files', () => {
    const directConfig = { ...config, direct_media_origins: ['https://media.example'], https_max_bytes: 14000000 };
    const direct = { ...createVideoAttachment('https://media.example/imports/clip.mp4?k=test-key', 4), size: 1000 };
    assert.equal(validateVideo(direct, directConfig).url, direct.url);
    assert.throws(() => validateVideo({ ...direct, size: 15000001 }, directConfig));
    assert.throws(() => validateVideo({ ...direct, url: 'https://other.example/clip.mp4' }, directConfig));
    assert.throws(() => createVideoAttachment('https://user:pass@media.example/clip.mp4', 4));
    const body = injectVideo({ contents: [{ role: 'user', parts: [{ text: 'marker' }] }] }, 'marker', direct);
    assert.equal(body.contents[0].parts[0].fileData.fileUri, direct.url);
});

test('duration may be unknown; every prepared request pins its selected model and upstream', async () => {
    const unknown = createVideoAttachment('gs://test-video-bucket/unknown.mp4');
    assert.equal(unknown.duration_seconds, null);
    assert.equal(createVideoAttachment(unknown.url, '').duration_seconds, null);
    assert.throws(() => createVideoAttachment(unknown.url, -2));
    const received = [];
    const upstream = http.createServer(async (request, response) => {
        for await (const chunk of request) { /* Drain the body. */ }
        received.push(request.url); response.end('{}');
    });
    await listen(upstream);
    const settings = { ...config, models: ['first', 'second'], upstream: `http://127.0.0.1:${upstream.address().port}` };
    const relay = createRelay(settings, fetch); await listen(relay.server);
    try {
        assert.throws(() => relay.prepare(unknown, 'key', 'user', 'third'));
        const job = relay.prepare(unknown, 'key', 'user', 'second');
        settings.upstream = 'http://127.0.0.1:1';
        const url = `${job.reverse_proxy}/v1beta/models/second:generateContent?key=${job.proxy_password}`;
        const body = JSON.stringify({ contents:[{role:'user',parts:[{text:job.marker}]}] });
        assert.equal((await fetch(url.replace('/second:', '/first:'), {method:'POST',body})).status,403);
        assert.equal((await fetch(url,{method:'POST',body})).status,200);
        assert.deepEqual(received,['/v1beta/models/second:generateContent']);
    } finally { await relay.close(); upstream.closeAllConnections(); await new Promise(resolve=>upstream.close(resolve)); }
});
