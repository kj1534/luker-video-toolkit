"""Single-file, origin-bound resumable uploads; public tickets never grant library access."""
import copy
import pathlib
import re
import secrets
import shutil
import tempfile
import time
import urllib.parse
import library

CHUNK = 4 * 1024 * 1024


def create(job, body, config):
    size = body.get('size')
    name = body.get('filename', '')
    origin = body.get('origin', '')
    parsed = urllib.parse.urlsplit(origin)
    mode = body.get('mode', 'auto')
    if not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= config['max_bytes']:
        raise ValueError('Invalid size')
    if not isinstance(name, str) or not 0 < len(name) <= 180 or any(c in name for c in '/\\') or any(ord(c)<32 for c in name):
        raise ValueError('Invalid name')
    if parsed.scheme not in ('http','https') or not parsed.netloc or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        raise ValueError('Invalid origin')
    if mode not in ('auto','both','copyparty'):
        raise ValueError('Invalid storage mode')
    target = library.volume(config, body.get('volume'))
    threshold=body.get('threshold')
    if not isinstance(threshold,int) or not 0<threshold<=15000000:raise ValueError('Invalid threshold')
    settings = copy.deepcopy(config)
    settings['small_video']['max_bytes']=threshold
    settings['small_video']['copyparty'] = target
    settings['_destination'] = 'copyparty' if mode=='copyparty' or (mode=='auto' and size<=settings['small_video']['max_bytes']) else 'gcs'
    settings['_sync_copyparty'] = settings['_destination']=='gcs'
    if shutil.disk_usage(config['download_directory']).free < size + 256*1024*1024:raise ValueError('Insufficient disk space')
    directory = tempfile.mkdtemp(prefix='gcs-web-', dir=config['download_directory'])
    suffix = pathlib.Path(name).suffix
    suffix = suffix if re.fullmatch(r'\.[a-zA-Z0-9]{1,12}',suffix) else '.bin'
    file = pathlib.Path(directory)/('upload'+suffix);file.touch(mode=0o600)
    job.update(status='receiving',total=size,done=0,_file=str(file),_directory=directory,
               _upload_token=secrets.token_urlsafe(32),_origin=origin,_upload_expires=time.time()+3600,
               _upload_config=settings,_filename=name,_mime=str(body.get('mime_type','application/octet-stream')))
    return {'id':job['id'],'ticket':job['_upload_token'],'chunk_size':CHUNK,'expires_seconds':3600}


def receive(job, stream, length, content_range):
    if job['status']!='receiving':raise ValueError('Upload is no longer receiving')
    match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content_range)
    if not match or not 0<length<=CHUNK:raise ValueError('Invalid chunk')
    start,end,total=map(int,match.groups())
    file=pathlib.Path(job['_file']);offset=file.stat().st_size
    if start!=offset or end-start+1!=length or total!=job['total'] or end>=total:raise ValueError('Offset mismatch; probe before retry')
    with file.open('r+b') as out:
        out.seek(offset)
        try:
            left=length
            while left:
                block=stream.read(min(left,256*1024))
                if not block:raise ValueError('Incomplete chunk')
                out.write(block);left-=len(block)
        except Exception:
            out.truncate(offset);raise
    job['done']=end+1;job['_upload_expires']=time.time()+3600
    return {'offset':job['done'],'complete':job['done']==job['total']}
