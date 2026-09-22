import pathlib
import tempfile
import unittest
from unittest.mock import patch
import web_import

class DownloadLimitTest(unittest.TestCase):
    def test_page_sources_and_per_site_proxies(self):
        config = {'parser_proxy': 'http://fallback', 'parser_proxies': {
            'iwara': 'http://iwara', 'bilibili': 'http://bilibili', 'youtube': 'http://youtube'}}
        cases = [
            ('https://www.iwara.tv/video/abc123', 'iwara', 'http://iwara'),
            ('https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili', 'http://bilibili'),
            ('https://youtu.be/jNQXAC9IVRw', 'youtube', 'http://youtube'),
        ]
        for url, site, expected in cases:
            self.assertEqual(web_import.page_url(url), url)
            self.assertEqual(web_import.source_site(url), site)
            self.assertEqual(web_import.parser_proxy(config, 'http://guard', site), expected)

    def test_parser_proxy_falls_back_compatibly(self):
        self.assertEqual(web_import.parser_proxy({'parser_proxy': 'http://old'}, 'http://guard', 'iwara'), 'http://old')
        self.assertEqual(web_import.parser_proxy({}, 'http://guard', 'iwara'), 'http://guard')

    def test_unknown_content_length_still_enforces_byte_limit_and_cleans_temp_file(self):
        class Headers(dict):
            def get_filename(self):return 'video.mp4'
        class Source:
            headers=Headers({'Content-Type':'video/mp4'})
            url='https://example.org/video.mp4'
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def read(self,*args):return b'x'*20
        with tempfile.TemporaryDirectory() as temp, patch('web_import.open_source',return_value=Source()):
            job={};web_import.download(job,'https://example.org/video.mp4',{'download_directory':temp,'max_bytes':10,'download_timeout_seconds':10},'')
            self.assertEqual(job['status'],'failed')
            self.assertNotIn('_file',job)
            self.assertEqual(list(pathlib.Path(temp).iterdir()),[])

    def test_html_page_is_not_saved_as_a_video(self):
        class Headers(dict):
            def get_filename(self):return 'fake.mp4'
        class Source:
            headers=Headers({'Content-Type':'text/html'})
            url='https://example.org/fake.mp4'
            def __enter__(self):return self
            def __exit__(self,*args):pass
        with tempfile.TemporaryDirectory() as temp, patch('web_import.open_source',return_value=Source()):
            job={};web_import.download(job,'https://example.org/fake.mp4',{'download_directory':temp,'max_bytes':100,'download_timeout_seconds':10},'')
            self.assertEqual(job['status'],'failed')
            self.assertIn('播放页',job['error'])
            self.assertEqual(list(pathlib.Path(temp).iterdir()),[])

    def test_sync_reuses_local_file_and_keeps_it_for_gcs(self):
        with tempfile.TemporaryDirectory() as temp:
            file=pathlib.Path(temp)/'file.txt';file.write_bytes(b'test file')
            config={'max_bytes':100,'_sync_copyparty':True,'small_video':{'enabled':True,'max_bytes':2,'copyparty':{}}}
            job={}
            with patch('web_import.copyparty_store.publish',return_value={'url':'https://media.example/copy.txt'}) as publish:
                web_import.finish_file(job,file,'file.txt','text/plain',config)
                publish.assert_called_once();self.assertEqual(publish.call_args.args[0],file)
            self.assertEqual(job['status'],'ready');self.assertTrue(file.exists());self.assertIn('sync_video',job)

    def test_small_file_sync_does_not_publish_twice(self):
        with tempfile.TemporaryDirectory() as temp:
            file=pathlib.Path(temp)/'file.txt';file.write_bytes(b'test')
            config={'max_bytes':100,'_sync_copyparty':True,'small_video':{'enabled':True,'max_bytes':20,'copyparty':{}}}
            job={}
            with patch('web_import.copyparty_store.publish',return_value={'url':'https://media.example/copy.txt'}) as publish:
                web_import.finish_file(job,file,'file.txt','text/plain',config)
                publish.assert_called_once()
            self.assertEqual(job['status'],'complete')

    def test_failed_optional_sync_does_not_block_gcs(self):
        with tempfile.TemporaryDirectory() as temp:
            file=pathlib.Path(temp)/'file.txt';file.write_bytes(b'test')
            config={'max_bytes':100,'_sync_copyparty':True,'small_video':{'enabled':True,'max_bytes':2,'copyparty':{}}}
            job={}
            with patch('web_import.copyparty_store.publish',side_effect=OSError):
                web_import.finish_file(job,file,'file.txt','text/plain',config)
            self.assertEqual(job['status'],'ready');self.assertIn('warning',job)
