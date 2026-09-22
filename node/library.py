"""File-only operations within administrator-configured copyparty volumes."""
import base64
import json
import mimetypes
import pathlib
import urllib.parse
import urllib.request
from datetime import datetime, timezone

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None

HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

def relative_path(value):
    if not isinstance(value, str) or '\\' in value or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid path')
    if value.startswith('/') or any(part in ('.', '..', '') for part in value.split('/')) and value:
        raise ValueError('Invalid path')
    return value

def volume(config, identifier):
    for item in config.get('library_volumes', []):
        if item['id'] == identifier:
            return item
    raise ValueError('Unknown volume')

def roots(config):
    return [{'id':item['id'], 'label':item['label'], 'public_url':item['public_url']} for item in config.get('library_volumes', [])]

def request(config, relative='', method='GET', query=''):
    relative_path(relative)
    password = pathlib.Path(config['password_file']).read_text().strip()
    auth = base64.b64encode((config['username'] + ':' + password).encode()).decode()
    url = config['api_url'].rstrip('/') + '/' + urllib.parse.quote(relative, safe='/') + query
    req = urllib.request.Request(url, method=method, headers={'Authorization':'Basic '+auth, 'Accept':'application/json'})
    return HTTP.open(req, timeout=30)

def list_files(config, identifier, directory=''):
    root = volume(config, identifier)
    relative_path(directory)
    folder = directory.rstrip('/')
    with request(root, folder, query=('/' if folder else '')+'?ls') as response:
        listing = json.load(response)
    entries = []
    for key, is_dir in [('dirs', True), ('files', False)]:
        for item in listing.get(key, []):
            href = urllib.parse.urlsplit(item['href'])
            name = urllib.parse.unquote(href.path).rstrip('/')
            if href.scheme or href.netloc or '/' in name:
                raise ValueError('Unexpected file reference')
            relative_path(name)
            target = (folder + '/' if folder else '') + name
            url = root['public_url'].rstrip('/') + '/' + urllib.parse.quote(target, safe='/')
            if href.query:
                url += '?' + href.query
            entries.append({'path':target,'title':name,'is_directory':is_dir,'url':url,
                            'size':int(item.get('sz',0)), 'modified':int(item.get('ts',0)),
                            'created':datetime.fromtimestamp(int(item.get('ts',0)),timezone.utc).isoformat(),
                            'volume':identifier,'storage':'copyparty'})
    return {'items':entries,'path':folder,'volume':identifier}

def get_file(config, identifier, name):
    relative_path(name)
    parent = name.rpartition('/')[0]
    for item in list_files(config, identifier, parent)['items']:
        if item['path'] == name and not item['is_directory']:
            return item
    raise ValueError('File not found')

def delete_file(config, identifier, name, expected_size, expected_modified):
    item = get_file(config, identifier, name)
    if item['size'] != expected_size or item['modified'] != expected_modified:
        raise ValueError('File changed; refresh before deleting')
    with request(volume(config, identifier), name, method='DELETE') as response:
        response.read(65536)
    return {'ok':True}
