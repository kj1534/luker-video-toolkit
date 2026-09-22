"""Native up2k uploads: each verified chunk is a separate, resumable HTTP request."""
import base64
import hashlib
import json
import pathlib
import time
import urllib.parse
import urllib.request
import naming
from datetime import datetime, timedelta, timezone

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args): return None

def chunksize(size):
    chunk, step = 1024*1024, 512*1024
    while True:
        for mul in (1, 2):
            count = (size+chunk-1)//chunk
            if count<=256 or (chunk>=32*1024*1024 and count<=4096): return chunk
            chunk += step; step *= mul

def upload(file, name, config, cancelled=lambda:False):
    file=pathlib.Path(file);size=file.stat().st_size;chunk=chunksize(size)
    # This service accepts <= 2 GiB files; native chunks stay far below Tunnel limits.
    if chunk>8*1024*1024: raise ValueError('File exceeds configured chunk transport limit')
    password=pathlib.Path(config['password_file']).read_text().strip()
    auth='Basic '+base64.b64encode((config['username']+':'+password).encode()).decode()
    base=config['api_url'].rstrip('/')+'/'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    hashes={};sequence=[]
    with file.open('rb') as source:
        offset=0
        while offset<size:
            data=source.read(chunk);digest=base64.urlsafe_b64encode(hashlib.sha512(data).digest()[:33]).decode()
            sequence.append(digest);hashes[digest]=(offset,len(data));offset+=len(data)
    def request(data,headers):
        if cancelled():raise ValueError('Task cancelled')
        req=urllib.request.Request(base,data=data,method='POST',headers={'Authorization':auth,'User-Agent':'FileLibrary/1.0 (copyparty up2k)',**headers})
        with opener.open(req,timeout=90) as response:return response.read(1024*1024)
    failures=0
    while True:
        try:
            body={'name':name,'size':size,'lmod':int(time.time()),'hash':sequence}
            answer=json.loads(request(json.dumps(body).encode(),{'Content-Type':'application/json'}))
            actual=answer['name']
            if pathlib.PurePosixPath(actual).name!=actual:raise ValueError('Invalid upload name')
            name=actual
            if not answer['hash']:return actual
            with file.open('rb') as source:
                for digest in answer['hash']:
                    offset,length=hashes[digest];source.seek(offset)
                    request(source.read(length),{'Content-Type':'application/octet-stream','X-Up2k-Hash':digest,'X-Up2k-Wark':answer['wark']})
                    failures=0
        except Exception:
            if cancelled():raise ValueError('Task cancelled')
            failures+=1
            if failures>5:raise
            time.sleep(min(15,failures*2))

def publish(file, metadata, config, cancelled=lambda:False):
    public=config['public_url'].rstrip('/')+'/'
    if urllib.parse.urlsplit(public).scheme!='https':raise ValueError('Copyparty public URL must use HTTPS')
    name=upload(file,naming.filename(pathlib.Path(metadata['filename']).name),config,cancelled)
    password=pathlib.Path(config['password_file']).read_text().strip()
    auth='Basic '+base64.b64encode((config['username']+':'+password).encode()).decode()
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    listing=urllib.request.Request(config['api_url'].rstrip('/')+'/?ls',headers={'Authorization':auth,'User-Agent':'FileLibrary/1.0 (copyparty up2k)','Accept':'application/json'})
    with opener.open(listing,timeout=30) as response:data=json.load(response)
    for item in data.get('files',[]):
        parsed=urllib.parse.urlsplit(item.get('href',''))
        if urllib.parse.unquote(parsed.path).rsplit('/',1)[-1]!=name:continue
        if parsed.scheme or parsed.netloc or parsed.fragment or not urllib.parse.parse_qs(parsed.query).get('k'):raise ValueError('Missing protected file reference')
        now=datetime.now(timezone.utc)
        return {'source_id':metadata.get('source_id',''),'url':public+urllib.parse.quote(name,safe='')+'?'+parsed.query,'title':metadata['filename'],'size':metadata['size'],'mime_type':metadata['mime_type'],'duration_seconds':metadata.get('duration_seconds'),'created':now.isoformat(),'expires':(now+timedelta(seconds=config['retention_seconds'])).isoformat(),'storage':'https','send_scope':'turn'}
    raise ValueError('Uploaded file not found')
