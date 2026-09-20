import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('worker', pathlib.Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
worker.CONFIG = {'bucket': 'private-videos'}


class ImportBoundaryTest(unittest.TestCase):
    def test_accepts_generic_https_sources_but_not_local_protocols(self):
        self.assertEqual(worker.source_url('https://example.org/video.mp4'), 'https://example.org/video.mp4')
        for url in ['http://example.org/video.mp4', 'file:///etc/passwd', 'https://user:pass@example.org/video.mp4']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                worker.source_url(url)

    def test_only_scoped_google_upload_session(self):
        url = 'https://storage.googleapis.com/upload/storage/v1/b/private-videos/o?upload_id=test'
        self.assertEqual(worker.upload_session(url), url)
        for bad in [url.replace('private-videos', 'other-bucket'), url.replace('storage.googleapis.com', 'example.org'), url.replace('https:', 'http:'), url.split('?')[0]]:
            with self.subTest(url=bad), self.assertRaises(ValueError):
                worker.upload_session(bad)


if __name__ == '__main__':
    unittest.main()
