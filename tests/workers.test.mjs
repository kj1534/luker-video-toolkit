import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImportWorkers } from '../server/workers.mjs';
test('worker selection uses only server IDs, keeps default explicit and exposes no endpoints', () => {
    const workers = createImportWorkers({ default_import_worker: 'primary', import_workers: [
        { id: 'primary', label: 'Primary', url: 'https://primary.example/gcs-import' },
        { id: 'secondary', label: 'Backup', url: 'https://secondary.example/gcs-import/' },
    ] });
    assert.equal(workers.get().id, 'primary');
    assert.equal(workers.get('secondary').url, 'https://secondary.example/gcs-import');
    for (const input of ['https://attacker.example', '__proto__', '', null, {}, 'kr1']) assert.throws(() => workers.get(input));
    assert.deepEqual(workers.publicList, [{ id: 'primary', label: 'Primary', web_imports: false }, { id: 'secondary', label: 'Backup', web_imports: false }]);
    assert.throws(() => createImportWorkers({ default_import_worker: 'other', import_workers: [] }));
});
