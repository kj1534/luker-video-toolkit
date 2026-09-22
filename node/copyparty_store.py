"""Publish small videos into a configured copyparty volume; credentials stay on the node."""
import base64
import json
import pathlib
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone


def publish(file, metadata, config):
    password = pathlib.Path(config['password_file']).read_text().strip()
    authorization = 'Basic ' + base64.b64encode((config['username'] + ':' + password).encode()).decode()
    base = config['api_url'].rstrip('/') + '/'
    public = config['public_url'].rstrip('/') + '/'
    if urllib.parse.urlsplit(public).scheme != 'https':
        raise ValueError('Copyparty public URL must use HTTPS')
    name = uuid.uuid4().hex + '-' + pathlib.Path(metadata['filename']).name
    target = urllib.parse.urljoin(base, urllib.parse.quote(name, safe=''))
    source = pathlib.Path(file).open('rb')
    request = urllib.request.Request(target, data=source, method='PUT', headers={'Authorization': authorization, 'Content-Type': 'application/octet-stream', 'Content-Length': str(pathlib.Path(file).stat().st_size), 'Accept': 'application/json'})
    # Never forward upload credentials across redirects to another server.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args): return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=90) as response:
            response.read(65536)
    finally:
        source.close()
    listing = urllib.request.Request(base + '?ls', headers={'Authorization': authorization, 'Accept': 'application/json'})
    with opener.open(listing, timeout=30) as response:
        data = json.load(response)
    for item in data.get('files', []):
        href = item.get('href', '')
        parsed = urllib.parse.urlsplit(href)
        if urllib.parse.unquote(parsed.path).rsplit('/', 1)[-1] != name:
            continue
        if parsed.scheme or parsed.netloc or parsed.fragment or not urllib.parse.parse_qs(parsed.query).get('k'):
            raise ValueError('Copyparty did not return a protected file reference')
        url = public + urllib.parse.quote(name, safe='') + '?' + parsed.query
        now = datetime.now(timezone.utc)
        return {'url': url, 'title': metadata['filename'], 'size': metadata['size'], 'mime_type': metadata['mime_type'], 'duration_seconds': metadata.get('duration_seconds'), 'created': now.isoformat(), 'expires': (now + timedelta(seconds=config['retention_seconds'])).isoformat(), 'storage': 'https', 'type': 'video', 'send_scope': 'turn'}
    raise ValueError('Uploaded video not found in copyparty listing')
