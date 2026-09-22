import unittest
from unittest.mock import patch
import gcs_read

class PrivateReadTest(unittest.TestCase):
    def test_bucket_signature_and_private_vip_required(self):
        config={'bucket':'test-bucket','gcs_private_endpoint':'199.36.153.8'}
        good='https://storage.googleapis.com/test-bucket/file?X-Goog-Signature=test'
        self.assertEqual(gcs_read.validate(good,config),'199.36.153.8')
        for url in [good.replace('test-bucket','other'),good.replace('storage.googleapis.com','evil.example'),good.split('?')[0],good.replace('/file','/../other/file')]:
            with self.assertRaises(ValueError):gcs_read.validate(url,config)
        with self.assertRaises(ValueError):gcs_read.validate(good,{**config,'gcs_private_endpoint':'8.8.8.8'})

    def test_failure_has_no_public_or_proxy_fallback(self):
        config={'bucket':'test-bucket','gcs_private_endpoint':'199.36.153.8'}
        with patch('gcs_read.socket.create_connection',side_effect=OSError('offline')) as connect:
            with self.assertRaises(Exception):gcs_read.open_read('https://storage.googleapis.com/test-bucket/file?X-Goog-Signature=test',config)
            self.assertEqual(connect.call_count,1)
            self.assertEqual(connect.call_args.args[0],('199.36.153.8',443))
