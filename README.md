# File Library

Independent file management and background transfers, with a small Luker connector for turn-scoped Gemini attachments. The application manages metadata and authorization; file bytes move directly between the browser, workers, copyparty and GCS.

## Included capabilities

- Independent accounts, administrator controls, CSRF-protected sessions, separately revocable per-user plugin tokens, and isolated GCS prefixes.
- One library for GCS and copyparty: directories, search, type filters, pagination, preview, download, conditional deletion, and validated copy reuse.
- Browser resumable uploads: automatic placement, copyparty only, both stores, or direct GCS. Automatic placement sends the browser file once to copyparty; the worker creates GCS copies above the configured threshold (14,000,000 bytes by default).
- Public HTTPS file imports and Iwara, Bilibili and YouTube pages, including ordinary HTTPS redirects and official short links. Unknown HTML and private network destinations are rejected.
- Durable control-plane and worker task records, status reconciliation, explicit retry/cancel, and resumable GCS and native copyparty up2k uploads. Each up2k chunk is an independent HTTP request below common Tunnel limits.
- Per-site parser proxy configuration and optional generic HTTP selector integration. A shared task lease prevents scheduled or manual egress switching during downloads.
- GCS previews/downloads stage through a configured private GCS reader and copyparty. Browsers never stream the GCS object directly. Existing valid copies are reused.
- Luker keeps native text/image attachments, streaming, model selection, and message-local attachment state. Regeneration uses that turn's attachment; later messages do not resend it automatically. Supported video, audio, images, PDF and UTF-8 text can be attached; other files remain storage-only. Images use a conservative 7 MB HTTPS threshold.

## Components

| Component | Responsibility |
|---|---|
| `app/`, `server/library-core.mjs` | Login, users, credentials, unified configuration, durable jobs and copy indexes |
| `node/` | Guarded HTTPS parsing/download, resumable upload, copyparty and private Google access |
| `index.js`, `server/index.mjs` | Luker file picker/upload/import/task UI and native model adapter |
| `library-ui.js` | Shared file UI; full management is available in the independent application |

The Luker integration requires both official frontend-extension and server-plugin installation from this same repository. The server component holds only user plugin connections and the Gemini loopback adapter, not the GCS key or node credentials. Other hosts can use the same scoped HTTP API without importing Luker internals.

See [installation and migration](docs/installation.md), [file behavior](docs/file-library.md), and [API and operations](docs/independent-app.md). Deployments and real proxy topology are private and are not distributed here.

License: AGPL-3.0-only.
