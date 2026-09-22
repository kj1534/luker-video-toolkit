import socket
import unittest
from unittest.mock import patch
from source_fetch import validate_https, public_addresses, open_source
from web_import import page_url

class SourceGuardTest(unittest.TestCase):
    def test_https_only_no_embedded_credentials_or_alternate_ports(self):
        for url in ['http://example.org/v.mp4', 'file:///etc/passwd', 'https://user:pass@example.org/v', 'https://example.org:8443/v', 'https://example.org/v\nInjected:yes']:
            with self.subTest(url=url), self.assertRaises(ValueError):validate_https(url)
    def test_dns_blocks_private_metadata_loopback_and_mixed_answers(self):
        for answers in [['127.0.0.1'], ['169.254.169.254'], ['10.0.0.1'], ['::1'], ['fc00::1'], ['8.8.8.8','192.168.1.1']]:
            records=[(socket.AF_INET,socket.SOCK_STREAM,6,'',(a,443)) for a in answers]
            with patch('socket.getaddrinfo',return_value=records), self.subTest(answers=answers), self.assertRaises(ValueError):public_addresses('source.example')
    def test_private_redirect_is_revalidated_before_connect(self):
        class Reply:
            status=302
            def getheader(self,name):return 'https://127.0.0.1/private'
            def close(self):pass
        class First:
            def __init__(self,*args,**kwargs):pass
            def request(self,*args,**kwargs):pass
            def getresponse(self):return Reply()
            def close(self):pass
        from source_fetch import PinnedHTTPS
        def connection(host,*args,**kwargs):
            return First() if host=='public.example' else PinnedHTTPS(host,*args,**kwargs)
        with patch('source_fetch.PinnedHTTPS',side_effect=connection), patch('socket.getaddrinfo',return_value=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]), self.assertRaises(ValueError):
            open_source('https://public.example/file.mp4')
    def test_webpage_platform_scope(self):
        for url in ['https://www.iwara.tv/video/example/title','https://www.bilibili.com/video/BV1xx','https://b23.tv/example','https://youtube.com/watch?v=a','https://youtu.be/a']:
            self.assertEqual(page_url(url),url)
        for url in ['https://www.iwara.tv/users/example','https://www.bilibili.com/space/1','https://www.bilibili.com.evil.example/video/a','https://youtube.com/channel/a','https://youtu.be/']:
            with self.subTest(url=url), self.assertRaises(ValueError):page_url(url)
