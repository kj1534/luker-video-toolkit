"""Bounded signed GCS reads through Google's private API VIP, never a proxy."""
import http.client
import socket
import ssl
import urllib.parse
import urllib.request

VIPS = {'199.36.153.8', '199.36.153.9', '199.36.153.10', '199.36.153.11'}


def validate(url, config):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.netloc != 'storage.googleapis.com' or not u.path.startswith('/' + config['bucket'] + '/'):
        raise ValueError('Unexpected GCS read target')
    if any(part in ('.','..') for part in urllib.parse.unquote(u.path).split('/')):
        raise ValueError('Invalid object path')
    q = urllib.parse.parse_qs(u.query)
    if not q.get('X-Goog-Signature') or u.fragment:
        raise ValueError('Signed GCS URL required')
    vip = config.get('gcs_private_endpoint')
    if vip not in VIPS:
        raise ValueError('Configure a private Google API VIP before reading GCS')
    return vip


def private_open(request, config):
    vip = config.get('gcs_private_endpoint')
    if vip not in VIPS: raise ValueError('Private Google API VIP required')
    class Connection(http.client.HTTPSConnection):
        def connect(self):
            raw = socket.create_connection((vip, 443), self.timeout)
            self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname='storage.googleapis.com')
    class HTTPS(urllib.request.HTTPSHandler):
        def https_open(self, request):
            return self.do_open(Connection, request)
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), HTTPS(), NoRedirect())
    return opener.open(request, timeout=60)


def open_read(url, config):
    validate(url, config)
    return private_open(urllib.request.Request(url), config)
