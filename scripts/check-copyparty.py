#!/usr/bin/env python3
"""Disposable copyparty protocol test. Never uses existing volumes or credentials."""
import argparse
import hashlib
import pathlib
import secrets
import socket
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'node'))
import library
import copyparty_store

parser = argparse.ArgumentParser()
parser.add_argument('--binary', required=True, help='Path to copyparty-sfx.py')
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix='file-library-test-') as tmp:
    root = pathlib.Path(tmp)
    data = root / 'data'; data.mkdir()
    password = secrets.token_urlsafe(24)
    credential = root / 'password'; credential.write_text(password); credential.chmod(0o600)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    log = (root / 'server.log').open('wb')
    process = subprocess.Popen([sys.executable, args.binary, '--http-only', '--usernames', '--wram', '-i', '127.0.0.1', '-p', str(port), '-a', 'test:'+password, '-v', str(data)+':/files:g:rwd,test:c,e2d:c,fk=16', '--no-ansi'], cwd=root, stdout=log, stderr=log)
    config = {'id':'files','label':'Test files','api_url':f'http://127.0.0.1:{port}/files/','public_url':'https://media.example/files/','username':'test','password_file':str(credential),'retention_seconds':259200}
    try:
        for _ in range(60):
            if process.poll() is not None: raise RuntimeError('Disposable copyparty failed to start')
            try:
                library.list_files({'library_volumes':[config]},'files');break
            except Exception:time.sleep(.25)
        else:raise RuntimeError('Disposable server timed out')
        source = root/'sample.bin'
        with source.open('wb') as stream:
            for _ in range(32):stream.write(b'x'*1048576)
        result = copyparty_store.publish(source, {'filename':'sample.bin','size':source.stat().st_size,'mime_type':'application/octet-stream'}, config)
        assert '?k=' in result['url']
        listing = library.list_files({'library_volumes':[config]},'files')
        assert len(listing['items']) == 1
        item = listing['items'][0]
        uploaded = data / item['path']
        def digest(file):
            with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
        assert digest(source) == digest(uploaded)
        try:
            library.delete_file({'library_volumes':[config]},'files',item['path'],1,item['modified'])
        except ValueError:pass
        else:raise AssertionError('Changed-file guard failed')
        assert uploaded.exists()
        library.delete_file({'library_volumes':[config]},'files',item['path'],item['size'],item['modified'])
        assert not uploaded.exists()
        print('PASS: real copyparty streaming PUT, protected links, live listing, conditional file deletion; disposable data only.')
    except Exception:
        log.flush()
        lines=(root/'server.log').read_text(errors='replace').replace(password,'<redacted>').splitlines()
        for line in lines[-20:]:
            if any(word in line.lower() for word in ['403','400','error','denied','password','write']):print(line[:300])
        raise
    finally:
        process.terminate()
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:process.kill();process.wait()
        log.close()
