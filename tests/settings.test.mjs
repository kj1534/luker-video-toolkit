import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { defaults, loadConfig, isAdmin, visibleSettings, prepareSettings, commitSettings } from '../server/settings.mjs';

function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-settings-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    return { directory, file: path.join(directory, 'config.json'), input: {
        upstream: 'https://gateway.example', models: ['gemini-video'], bucket: 'private-video-test',
        max_upload_bytes: 2147483648, https_max_bytes: 14000000, direct_media_origins: ['https://media.example'],
        default_import_worker: 'primary', import_workers: [{ id: 'primary', label: 'Primary', url: 'https://worker.example/import', token: 'a-test-only-token-at-least-24-characters' }],
        credential_json: { type: 'service_account', project_id: 'example-project', client_email: 'test@example-project.iam.gserviceaccount.com', private_key: privateKey },
    } };
}
test('fresh install can open settings; admin check uses authenticated profile only', () => {
    assert.equal(isAdmin({ user: { profile: { admin: true } } }), true);
    for (const request of [{}, {body:{admin:true}}, {user:{profile:{admin:'true'}}}, {user:{profile:{admin:false}}}]) assert.equal(isAdmin(request), false);
    assert.deepEqual(loadConfig('/path/that/does/not/exist'), defaults);
});
test('settings persist restricted secrets but never return them or filesystem paths', t => {
    const {directory,file,input} = fixture(t);
    const prepared = prepareSettings(input, defaults, directory);
    commitSettings(file, prepared);
    const saved = loadConfig(file);
    const visible = visibleSettings(saved);
    assert.equal(visible.credential_configured, true);
    assert.equal(visible.import_workers[0].token_configured, true);
    for (const target of [file, ...prepared.writes.map(([name])=>name)]) assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    const serialized = JSON.stringify(visible);
    assert.equal(serialized.includes(input.import_workers[0].token), false);
    assert.equal(serialized.includes('PRIVATE KEY'), false);
    assert.equal(serialized.includes(directory), false);
    const updated = prepareSettings({...visible, models:['new-model']}, saved, directory);
    assert.equal(updated.writes.length, 0);
    assert.equal(updated.config.credential_file, saved.credential_file);
    assert.equal(updated.config.import_workers[0].token_file, saved.import_workers[0].token_file);
});
test('invalid forms do not write secrets; clients cannot choose credential paths', t => {
    const {directory,input} = fixture(t);
    for (const patch of [{default_import_worker:'missing'}, {import_workers:[{...input.import_workers[0],id:'../escape'}]}, {upstream:'http://example.org'}, {direct_media_origins:['https://media.example/path']}, {credential_json:{type:'service_account'}}, {https_max_bytes:16000000}]) {
        assert.throws(()=>prepareSettings({...input,...patch},defaults,directory));
        assert.deepEqual(fs.readdirSync(directory), []);
    }
    const prepared = prepareSettings({...input,credential_file:'/tmp/attacker-key'},defaults,directory);
    assert.ok(prepared.config.credential_file.startsWith(directory + path.sep));
});
test('local-upload-only setup needs no remote node', t => {
    const {directory,input} = fixture(t);
    const result = prepareSettings({...input,import_workers:[],default_import_worker:''},defaults,directory);
    assert.equal(result.config.import_workers.length,0);
});

test('existing single-model configuration migrates without losing its restriction', t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'video-migration-'));
    t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
    const file=path.join(directory,'config.json');
    fs.writeFileSync(file,JSON.stringify({model:'existing-model',bucket:'existing-bucket'}));
    const config=loadConfig(file);
    assert.deepEqual(config.models,['existing-model']);
    assert.equal('model' in config,false);
    assert.equal(config.bucket,'existing-bucket');
});
