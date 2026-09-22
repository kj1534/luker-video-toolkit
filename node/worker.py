#!/usr/bin/env python3
"""Private control API for public video URLs and scoped GCS upload sessions."""
import concurrent.futures
import hmac
import http.server
import json
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import argparse
import copy
import gcs_read
import library
from source_fetch import open_source, validate_https, start_proxy
import web_import

CONFIG = {}
JOBS = {}
LOCK = threading.Lock()
WEB_PROXY = None
POOL = concurrent.futures.ThreadPoolExecutor(max_workers=2)
CHUNK = 8 * 1024 * 1024


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def source_url(value):
    validate_https(value)
    return value


def upload_session(value):
    u = urllib.parse.urlsplit(value)
    if u.scheme != 'https' or u.hostname != 'storage.googleapis.com' or u.port not in (None, 443) or u.username or u.password:
        raise ValueError('Invalid GCS upload session')
    if u.path != '/upload/storage/v1/b/' + CONFIG['bucket'] + '/o' or 'upload_id' not in urllib.parse.parse_qs(u.query):
        raise ValueError('Unexpected GCS upload target')
    return value


def request_upload(session, data, content_range):
    req = urllib.request.Request(session, data=data, method='PUT', headers={'Content-Range': content_range, 'Content-Type': 'application/octet-stream'})
    try:
        response = gcs_read.private_open(req, CONFIG) if CONFIG.get('gcs_private_endpoint') else HTTP.open(req, timeout=90)
    except urllib.error.HTTPError as error:
        if error.code != 308:
            raise
        # 308 is a normal resumable-upload acknowledgement. Its traceback
        # otherwise retains this frame and the chunk until cyclic GC runs.
        response = error.with_traceback(None)
    with response:
        status = response.status
        offset = int(response.headers.get('Range', 'bytes=0--1').rsplit('-', 1)[-1]) + 1 if response.headers.get('Range') else 0
        response.read()
    return status, offset


def upload_download(job_id, session):
    job = JOBS[job_id]
    job.update(status='running', done=0)
    try:
        total = job['total']
        done = 0
        failures = 0
        with open(job['_file'], 'rb') as file:
            while done < total:
                try:
                    status, done = request_upload(session, b'', f'bytes */{total}')
                    if status in (200, 201):
                        done = total
                        break
                    if not 0 <= done < total:
                        raise ValueError('Invalid upload offset')
                    file.seek(done)
                    while done < total:
                        data = file.read(min(CHUNK, total - done))
                        if not data:
                            raise ValueError('Unexpected EOF')
                        status, offset = request_upload(session, data, f'bytes {done}-{done + len(data) - 1}/{total}')
                        if status in (200, 201):
                            done = total
                        elif status == 308 and offset == done + len(data):
                            done = offset
                        else:
                            raise ValueError('Invalid upload acknowledgement')
                        job['done'] = done
                        failures = 0
                except Exception:
                    failures += 1
                    if failures > 3:
                        raise
                    time.sleep(failures * 2)
        job.update(status='complete', done=total)
    except Exception:
        job.update(status='failed', error='上传 GCS 失败，请重新导入。')
    finally:
        job['finished'] = time.time()
        web_import.cleanup(job)


def new_job():
    with LOCK:
        for key in list(JOBS):
            if JOBS[key].get('finished', time.time()) < time.time() - 86400:
                del JOBS[key]
        if sum(j['status'] in ('queued', 'downloading', 'publishing', 'ready', 'running') for j in JOBS.values()) >= 8:
            raise ValueError('Import queue is full')
        job_id = uuid.uuid4().hex
        JOBS[job_id] = {'id': job_id, 'status': 'queued', 'done': 0, 'total': 0}
        return job_id


def reap_downloads():
    while True:
        time.sleep(60)
        with LOCK:
            for job in JOBS.values():
                if job['status'] == 'ready' and time.time() - job['ready_at'] > 3600:
                    job.update(status='failed', error='等待上传会话超时，请重新导入。', finished=time.time())
                    web_import.cleanup(job)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log source filekeys or GCS bearer upload sessions.

    def reply(self, code, value):
        body = json.dumps(value).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        supplied = self.headers.get('Authorization', '')
        if not hmac.compare_digest(supplied, 'Bearer ' + CONFIG['token']):
            self.reply(401, {'error': 'Unauthorized'})
            return False
        return True

    def do_GET(self):
        if not self.authorized():
            return
        if self.path == '/library/roots':
            return self.reply(200, {'volumes':library.roots(CONFIG)})
        if self.path == '/healthz':
            return self.reply(200, {'ok': True})
        if self.path.startswith('/jobs/'):
            job = JOBS.get(self.path[6:])
            return self.reply(200 if job else 404, {k: v for k, v in job.items() if not k.startswith('_')} if job else {'error': 'Unknown job'})
        self.reply(404, {'error': 'Not found'})

    def do_POST(self):
        if not self.authorized():
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 16384:
                raise ValueError('Invalid request size')
            body = json.loads(self.rfile.read(length))
            if self.path == '/library/list':
                return self.reply(200, library.list_files(CONFIG, body.get('volume'), body.get('path', '')))
            if self.path == '/library/file':
                return self.reply(200, library.get_file(CONFIG, body.get('volume'), body.get('path', '')))
            if self.path == '/library/delete':
                return self.reply(200, library.delete_file(CONFIG, body.get('volume'), body.get('path', ''), body.get('size'), body.get('modified')))
            if self.path == '/jobs':
                source = source_url(body.get('source_url', ''))
                settings = copy.deepcopy(CONFIG)
                destination = body.get('destination', 'auto')
                if destination not in ('auto', 'gcs', 'copyparty'):
                    raise ValueError('Invalid destination')
                settings['_destination'] = destination
                settings['_sync_copyparty'] = body.get('sync_copyparty') is True
                if settings['_sync_copyparty'] and not settings['small_video']['enabled']:
                    raise ValueError('Copyparty is not configured')
                if body.get('gcs_source') is True:
                    gcs_read.validate(source, settings)
                    settings['_gcs_source'] = True
                if body.get('filename'):
                    filename = body['filename']
                    if not isinstance(filename, str) or len(filename) > 180 or '/' in filename or '\\' in filename:
                        raise ValueError('Invalid filename')
                    settings['_filename'] = filename
                if destination == 'copyparty' and body.get('volume'):
                    settings['small_video']['copyparty'] = library.volume(CONFIG, body['volume'])
                job_id = new_job()
                POOL.submit(web_import.download, JOBS[job_id], source, settings, WEB_PROXY)
                return self.reply(202, {'id': job_id})
            parts = self.path.split('/')
            if len(parts) == 4 and parts[1] == 'jobs' and parts[3] == 'upload':
                session = upload_session(body.get('session', ''))
                job_id = parts[2]
                with LOCK:
                    job = JOBS.get(job_id)
                    if not job or job['status'] != 'ready':
                        raise ValueError('Download not ready or upload already started')
                    job['status'] = 'queued'
                POOL.submit(upload_download, job_id, session)
                return self.reply(202, {'id': job_id})
            self.reply(404, {'error': 'Not found'})
        except Exception:
            self.reply(400, {'error': 'Invalid or inaccessible source/upload target'})


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Video Toolkit import node')
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    CONFIG = json.loads(pathlib.Path(args.config).read_text())
    CONFIG['token'] = pathlib.Path(CONFIG['token_file']).read_text().strip()
    pathlib.Path(CONFIG['download_directory']).mkdir(parents=True, exist_ok=True)
    for old in pathlib.Path(CONFIG['download_directory']).glob('gcs-web-*'):
        web_import.cleanup({'_directory': str(old)})
    _, WEB_PROXY = start_proxy()
    threading.Thread(target=reap_downloads, daemon=True).start()
    http.server.ThreadingHTTPServer(('127.0.0.1', CONFIG['port']), Handler).serve_forever()
