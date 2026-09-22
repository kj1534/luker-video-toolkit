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
    return sorted(addresses, key=lambda address: ipaddress.ip_address(address).version)


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


def open_source(url, method='GET', headers=None, timeout=45, proxy=None, route_proxy=None):
    seen=set()
    for _ in range(6):
        if url in seen: raise ValueError('Redirect loop')
        seen.add(url)
        u = validate_https(url)
        selected=route_proxy(url) if route_proxy else proxy
        if selected:
            p=urllib.parse.urlsplit(selected)
            if p.scheme!='http' or p.username or p.password:raise ValueError('Use a trusted HTTP proxy endpoint')
            # CONNECT an already validated public IP; TLS continues to verify the original host.
            address=public_addresses(u.hostname)[0]
            c=http.client.HTTPSConnection(u.hostname,443,timeout=timeout,context=ssl.create_default_context())
            c._create_connection=lambda *args, **kwargs: socket.create_connection((p.hostname,p.port or 80),timeout)
            c.set_tunnel(address,443)
            original=c._tunnel
            def tunnel():
                original();c._tunnel_host=u.hostname
            c._tunnel=tunnel
        else:
            c = PinnedHTTPS(u.hostname, 443, timeout=timeout, context=ssl.create_default_context())
        try:
            c.request(method, urllib.parse.urlunsplit(('', '', u.path or '/', u.query, '')), headers={'User-Agent':'FileLibrary/1.0','Host':u.hostname,'Accept-Encoding': 'identity', **(headers or {})})
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
            address=public_addresses(u.hostname)[0]
            proxy=getattr(self,'proxy_url',None)
            if proxy:
                p=urllib.parse.urlsplit(proxy)
                if p.scheme!='http' or p.username or p.password:raise ValueError('Invalid proxy')
                connection=http.client.HTTPConnection(p.hostname,p.port or 80,timeout=30)
                connection.set_tunnel(address,443);connection.connect();upstream=connection.sock
            else:
                upstream = socket.create_connection((address, 443), timeout=30)
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


def start_proxy(upstream=None):
    handler=type('RoutedConnectHandler',(ConnectHandler,),{'proxy_url':upstream})
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f'http://127.0.0.1:{server.server_port}'
