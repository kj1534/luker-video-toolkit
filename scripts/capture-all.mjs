import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    next();
});

let mockUsers = [
    { handle: 'accx', admin: true, disabled: false },
    { handle: 'editor_bob', admin: false, disabled: false },
    { handle: 'guest_viewer', admin: false, disabled: true },
];
let mockTokens = [
    { id: 'tok_1', label: 'Luker-Desktop-Workstation', created: '2026-09-20T10:15:30Z' },
    { id: 'tok_2', label: 'Luker-Laptop-Mobile', created: '2026-09-22T18:40:00Z' },
];
let mockTasks = [
    { id: 'task-abc-123', worker_id: 'GPU-Node-01', status: 'running', done: 45000000, total: 120000000, video: { title: 'youtube_live_recording_stream_1080p.mp4' } },
    { id: 'task-def-456', worker_id: 'GPU-Node-01', status: 'complete', video: { title: 'bilibili_dance_practice_4k.mp4' } },
    { id: 'task-ghi-789', worker_id: 'CPU-Node-02', status: 'failed', error: '远程连接超时，上游服务器重置连接 (504 Gateway Timeout)' },
];

const mockConfig = {
    user: 'accx',
    admin: true,
    configured: true,
    management: true,
    bucket: 'luker-bucket-prod',
    https_max_bytes: 10000000,
    max_upload_bytes: 2147483648,
    copyparty_label: 'copyparty',
    local_upload_available: true,
    default_import_worker: 'worker-1',
    import_workers: [
        { id: 'worker-1', label: 'GPU-Node-01', online: true, sites: ['iwara', 'bilibili', 'youtube'] },
        { id: 'worker-2', label: 'CPU-Node-02', online: false, sites: ['direct'] },
    ],
    models: ['gemini-2.0-flash-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    direct_media_origins: ['https://media.example.com', 'https://storage.googleapis.com'],
};

const api = express.Router();
api.get('/session', (req, res) => res.json({ user: { handle: 'accx', admin: true }, csrf: 'mock-csrf' }));
api.post('/login', (req, res) => res.json({ ok: true }));
api.post('/logout', (req, res) => res.json({ ok: true }));
api.get('/config', (req, res) => res.json(mockConfig));
api.get('/file-sources', (req, res) => {
    res.json({
        items: [
            { id: 'all', label: '全部来源' },
            { id: 'gcs', label: '我的 GCS', storage: 'gcs' },
            { id: 'worker-1:imports', label: 'GPU-Node-01 · imports', storage: 'copyparty', worker_id: 'worker-1', volume: 'imports' },
            { id: 'worker-1:public', label: 'GPU-Node-01 · public', storage: 'copyparty', worker_id: 'worker-1', volume: 'public' },
        ],
        errors: [],
    });
});

api.get('/files', (req, res) => {
    res.json({
        items: [
            { url: 'gs://luker-bucket-prod/videos/accx/project_showcase_final_render_4k_hdr_with_audio_track_v2_2026.mp4', title: 'project_showcase_final_render_4k_hdr_with_audio_track_v2_2026.mp4', storage: 'gcs', size: 142589000, type: 'video', duration_seconds: 184.5, created: '2026-09-21T08:30:00Z', source_label: 'GCS', attachable: true },
            { url: 'https://media.example.com/imports/sample_podcast_episode_42_interview_with_guest.mp3', title: 'sample_podcast_episode_42_interview_with_guest.mp3', storage: 'copyparty', size: 34500000, type: 'audio', duration_seconds: 1420.0, created: '2026-09-20T14:15:00Z', source_label: 'copyparty', attachable: true },
            { url: 'https://media.example.com/imports/architecture_diagram_ultra_highres_vector_export.png', title: 'architecture_diagram_ultra_highres_vector_export.png', storage: 'copyparty', size: 4200000, type: 'image', created: '2026-09-19T10:00:00Z', source_label: 'copyparty', attachable: true },
            { url: 'gs://luker-bucket-prod/videos/accx/annual_financial_report_q3_final_signed_and_approved.pdf', title: 'annual_financial_report_q3_final_signed_and_approved.pdf', storage: 'gcs', size: 8900000, type: 'pdf', created: '2026-09-18T16:20:00Z', source_label: 'GCS', attachable: true },
            { url: 'https://media.example.com/imports/model_training_instructions_and_dataset_notes.md', title: 'model_training_instructions_and_dataset_notes.md', storage: 'copyparty', size: 45000, type: 'text', created: '2026-09-17T09:10:00Z', source_label: 'copyparty', attachable: true },
            { url: 'https://media.example.com/imports/backup_archive_database_dump_20260901.tar.gz', title: 'backup_archive_database_dump_20260901.tar.gz', storage: 'copyparty', size: 950000000, type: 'file', created: '2026-09-15T12:00:00Z', source_label: 'copyparty', attachable: false },
            { url: 'https://media.example.com/imports/archive_2026/', title: 'archive_2026', is_directory: true, worker_id: 'worker-1', volume: 'imports', path: 'archive_2026', source_label: 'GPU-Node-01 · imports', created: '2026-09-14T08:00:00Z' },
        ],
        nextPageToken: '',
    });
});

api.get('/tasks', (req, res) => res.json({ items: mockTasks }));
api.get('/tokens', (req, res) => res.json({ items: mockTokens }));
api.get('/users', (req, res) => res.json({ items: mockUsers }));
api.get('/settings', (req, res) => {
    res.json({
        upstream: 'https://generativelanguage.googleapis.com',
        models: ['gemini-2.0-flash-exp', 'gemini-1.5-pro'],
        bucket: 'luker-bucket-prod',
        credential_configured: true,
        max_upload_bytes: 2147483648,
        https_max_bytes: 10000000,
        direct_media_origins: ['https://media.example.com', 'https://storage.googleapis.com'],
        import_workers: [
            { id: 'worker-1', label: 'GPU-Node-01', url: 'https://gpu.example.internal:8443', token_configured: true, library_enabled: true },
            { id: 'worker-2', label: 'CPU-Node-02', url: 'https://cpu.example.internal:8443', token_configured: true, library_enabled: false }
        ],
        default_import_worker: 'worker-1',
        gcs_read_worker: 'worker-1',
        copyparty_worker: 'worker-1',
        copyparty_volume: 'imports'
    });
});
api.get('/nodes/:id', (req, res) => {
    res.json({
        version: '1.0.3',
        active: 1,
        capabilities: {
            private_gcs_read: true,
            available_sites: ['iwara', 'bilibili', 'youtube', 'direct'],
            selector_sites: ['youtube'],
            parser_proxies: { iwara: '', bilibili: '', youtube: 'socks5://127.0.0.1:1080', direct: '' }
        }
    });
});
api.get('/nodes/:id/egress/:site', (req, res) => res.json({ choices: ['direct', 'warp-sg', 'hk-relay'], selected: 'warp-sg' }));
api.get('/policy', (req, res) => res.json({ desired_days: 7, gcs: { retention_days: 7 }, nodes: [{ id: 'worker-1', retention_seconds: 604800 }] }));

app.use('/api', api);

const assets = ['library-ui.js', 'settings.js', 'media.js', 'upload.js', 'style.css'];
for (const name of assets) {
    app.get('/' + name, (req, res) => res.sendFile(path.join(root, name)));
}
app.get('/jquery.js', (req, res) => res.sendFile(path.join(root, 'node_modules/jquery/dist/jquery.min.js')));
app.get('/luker', (req, res) => res.sendFile(path.join(root, 'scripts/preview/luker-preview.html')));
app.use('/', express.static(path.join(root, 'app/public'), { index: 'index.html' }));

const server = app.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    console.log(`Server listening on port ${port}, taking screenshots...`);

    const shots = [
        { name: 'desktop-01-files.png', url: `http://127.0.0.1:${port}/?tab=library`, width: 1280, height: 800 },
        { name: 'desktop-02-upload.png', url: `http://127.0.0.1:${port}/?tab=upload`, width: 1280, height: 800 },
        { name: 'desktop-03-import.png', url: `http://127.0.0.1:${port}/?tab=import`, width: 1280, height: 800 },
        { name: 'desktop-04-tasks.png', url: `http://127.0.0.1:${port}/?tab=tasks`, width: 1280, height: 800 },
        { name: 'desktop-05-settings.png', url: `http://127.0.0.1:${port}/?tab=settings`, width: 1280, height: 800 },
        { name: 'desktop-06-tokens.png', url: `http://127.0.0.1:${port}/?dialog=account`, width: 1280, height: 800 },
        { name: 'desktop-07-users.png', url: `http://127.0.0.1:${port}/?dialog=users`, width: 1280, height: 800 },
        { name: 'desktop-08-nodes.png', url: `http://127.0.0.1:${port}/?dialog=nodes`, width: 1280, height: 800 },
        { name: 'desktop-09-login.png', url: `http://127.0.0.1:${port}/?login=1`, width: 1280, height: 800 },
        { name: 'mobile-01-files.png', url: `http://127.0.0.1:${port}/?tab=library`, width: 390, height: 844, mobile: true },
        { name: 'mobile-02-upload.png', url: `http://127.0.0.1:${port}/?tab=upload`, width: 390, height: 844, mobile: true },
        { name: 'luker-01-interface.png', url: `http://127.0.0.1:${port}/luker`, width: 1280, height: 800 }
    ];

    const outDir = path.join(root, 'docs/screenshots');

    for (const s of shots) {
        const dest = path.join(outDir, s.name);
        const chromeArgs = [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--hide-scrollbars',
            `--window-size=${s.width},${s.height}`,
            '--virtual-time-budget=2000'
        ];
        if (s.mobile) {
            chromeArgs.push('--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
        }
        chromeArgs.push(`--screenshot=${dest}`, s.url);
        try {
            await execFileAsync('google-chrome-stable', chromeArgs);
            const artifactDir = '/home/accx/.gemini/antigravity-ide/brain/d866d033-ccfd-4924-ba7e-9c8d5eb45a84/screenshots';
            if (fs.existsSync(artifactDir)) {
                try { fs.copyFileSync(dest, path.join(artifactDir, s.name)); } catch {}
            }
            console.log(`Captured: ${s.name} (${s.width}x${s.height})`);
        } catch (err) {
            console.error(`Failed ${s.name}:`, err.message);
        }
    }

    server.close(() => {
        console.log('All screenshots captured successfully.');
        process.exit(0);
    });
});
