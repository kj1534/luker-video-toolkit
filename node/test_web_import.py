import pathlib
import tempfile
import unittest
from unittest.mock import patch
import web_import

class DownloadLimitTest(unittest.TestCase):
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
