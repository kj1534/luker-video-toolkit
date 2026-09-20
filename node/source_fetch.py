"""Outbound HTTPS guard: DNS is checked and the connection pins a public address."""
import http.client
import http.server
import ipaddress
import select
import socket
import ssl
import threading
import urllib.parse


def public_addresses(host):
    addresses = list(dict.fromkeys(x[4][0] for x in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
    if not addresses or any(not ipaddress.ip_address(a).is_global for a in addresses):
        raise ValueError('Only public Internet destinations are allowed')
    return addresses


def validate_https(url):
    u = urllib.parse.urlsplit(url)
    if (u.scheme != 'https' or not u.hostname or u.port not in (None, 443)
            or u.username or u.password or u.fragment or any(ord(c) < 33 for c in url)):
        raise ValueError('Use a public HTTPS URL without credentials')
    return u


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        address = public_addresses(self.host)[0]
        raw = socket.create_connection((address, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


class Response:
    def __init__(self, response, connection, url):
        self.response, self.connection, self.url = response, connection, url
        self.status, self.headers = response.status, response.headers
    def read(self, count=-1):
        return self.response.read(count)
    def __enter__(self):
        return self
    def __exit__(self, *args):
        self.response.close()
        self.connection.close()


def open_source(url, method='GET', headers=None, timeout=45):
    for _ in range(6):
        u = validate_https(url)
        c = PinnedHTTPS(u.hostname, 443, timeout=timeout, context=ssl.create_default_context())
        try:
            c.request(method, urllib.parse.urlunsplit(('', '', u.path or '/', u.query, '')), headers={'Accept-Encoding': 'identity', **(headers or {})})
            r = c.getresponse()
        except BaseException:
            c.close()
            raise
        if r.status in (301, 302, 303, 307, 308):
            location = r.getheader('Location')
            r.close(); c.close()
            if not location:
                raise ValueError('Missing redirect location')
            url = urllib.parse.urljoin(url, location)
            continue
        if r.status not in (200, 206):
            r.close(); c.close()
            raise ValueError('Source returned an unsuccessful status')
        return Response(r, c, url)
    raise ValueError('Too many redirects')


class ConnectHandler(http.server.BaseHTTPRequestHandler):
    """yt-dlp uses this proxy; all redirects/API/CDN requests retain the IP guard."""
    def log_message(self, *args):
        pass
    def do_CONNECT(self):
        try:
            u = validate_https('https://' + self.path)
            if u.path or u.query:
                raise ValueError('Invalid CONNECT target')
            upstream = socket.create_connection((public_addresses(u.hostname)[0], 443), timeout=30)
        except Exception:
            self.send_error(403, 'Destination denied or unavailable')
            return
        self.send_response(200, 'Connection Established'); self.end_headers()
        try:
            streams = [self.connection, upstream]
            while True:
                ready, _, _ = select.select(streams, [], [], 90)
                if not ready:
                    break
                for source in ready:
                    data = source.recv(65536)
                    if not data:
                        return
                    (upstream if source is self.connection else self.connection).sendall(data)
        except OSError:
            pass
        finally:
            upstream.close()
            self.close_connection = True
    def do_GET(self):
        self.send_error(403, 'HTTPS only')
    do_POST = do_GET


def start_proxy():
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), ConnectHandler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'
