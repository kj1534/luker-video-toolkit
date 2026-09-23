# Independent application and operations

Run Node 24+ with `node app/main.mjs --config /var/lib/file-library/config.json`. Configuration is a private project JSON file; there is no parallel environment-variable configuration. Bind is loopback only. Set `public_url` to the final HTTPS application path (for example `https://files.example/library/`), and `app_port` to the private listener.

Serve the path unchanged through your existing trusted reverse proxy. The application accepts only small JSON control requests (256 KiB). Upload sessions send bytes to the worker or Google directly. The login cookie is HttpOnly, Secure, SameSite=Strict and scoped to the application path; mutations require the session CSRF value and exact origin. Do not expose the loopback service directly.

## Identity and API

`POST /api/login` creates a session. `GET /api/session` returns the user and CSRF token. Use `X-CSRF-Token` for session mutations. Accounts use scrypt password hashes. Administrators create or disable users; disabling invalidates sessions and all their plugin tokens. Users change their own password and issue/revoke their own tokens under Account and connections.

A plugin token is bound to its issuing user. Shared-library access requires explicit administrator authorization when issuing that token. It never authorizes user administration, credential/configuration access, library deletion or storage-policy changes. The server stores only a token hash. Token authentication is `Authorization: Bearer …` and is independent of Luker. Tokens must stay in the integration's server-side per-user connection store.

Supported connector endpoints are `/config`, `/files`, `/file-sources`, `/metadata`, `/uploads`, `/local-uploads`, `/local-uploads/finish`, `/imports`, `/imports/:id`, `/tasks`, `/tasks/:id/cancel`, `/tasks/:id/retry`, `/file-attach`, `/file-access`, and `/authorize`. `X-Client-Origin` binds browser upload tickets to the caller's real origin. GCS objects are checked against the authenticated user's prefix and any owner prefixes explicitly granted to that user in private `config.json`, for example `"owner_grants":{"new-admin":["old-admin"]}`. Grants only affect reading and managing existing objects; new uploads always use the new user's own prefix. The same grant exposes the old user's unexpired direct-link catalog entries. Keep grants in the private server configuration and record the intended identity transfer. Never map multiple host users to a shared legacy account.

## Tasks and restarts

The application atomically persists `jobs.json`, direct references and copy indexes in its private state directory. Polling continues after the browser or Luker closes. Restarting the application reconciles each pinned node/job ID and reuses an already-issued GCS session. Repeating the same upload command is idempotent.

Workers persist task metadata and private upload sessions under the parent of `download_directory`. They resume GCS uploads at the acknowledged offset and restart recoverable source jobs. Browser upload tickets intentionally expire on a worker restart; the task reports `expired` and the user must select the local file again. A disconnected worker remains visibly disconnected; missing node records or tasks unreconciled for seven days become expired. Cancellation is cooperative; a current network request may take its timeout before stopping. Finished copies are retained until explicitly removed or expired. Retry is explicit and can redownload a source; expired local uploads need a new session.

## Node configuration and proxy selectors

The administrator UI shows actual node capabilities, active tasks, parser proxy URLs, the default import/read/storage nodes, thresholds, and connection health. Runtime node settings are validated and persisted to `runtime.json`; active jobs prevent configuration changes. Private credentials remain in server-side files.

An optional node `egress_control` object configures a trusted HTTP controller: `url`, optional `token_file`, and `groups` mapping site IDs to selector names. Only reading choices and selecting a listed choice are supported; the API does not execute commands. Configure `egress_lock_file` on a private writable path. All downloads hold a shared file lock; selection takes an exclusive nonblocking lock. Any external automatic selector must also use `flock -n -E 0 <lock-file> <fixed-selector-command>`. Deployment-specific controller/proxy implementations are not part of the public package.

GCS reads retain the configured private Google API endpoint, TLS Host/SNI and no-public-fallback behavior. Native up2k replaces whole-file PUT for both remote import synchronization and private GCS readback. The service's 2 GiB upload bound keeps up2k requests below 8 MiB. The receiving copyparty location must support its native handshake/chunk protocol; no new worker byte endpoint or public origin bypass is needed.

## Retention and recovery

Default retention is seven days in both copyparty volumes and GCS. The policy page distinguishes desired values, GCS lifecycle, node metadata retention, and `policy-applied.json`. Changing a GCS lifecycle requires bucket-scoped `storage.buckets.get` and `storage.buckets.update`; object-only credentials do not grant these. The application never deploys an Owner credential. Granting additional cloud permissions is a separate deployment decision.

The root-owned `scripts/apply-retention.py` reconciles a validated 1–30-day value into a fixed copyparty systemd unit only while idle. Run it from a fixed systemd timer, not from an arbitrary shell management endpoint. It preserves unrelated unit settings and verifies both effective lifetimes. A partially applied policy is reported as an error and should be reconciled from the actual-state display before retrying.

Back up the private configuration, accounts, jobs, indexes, referenced credentials, and node runtime/task records before upgrades. Keep previous code and systemd/proxy configurations. Roll back the code first; preserve newly created metadata and merge indexes rather than overwriting them with an older backup. Existing objects/URIs are never renamed or reuploaded during migration.
