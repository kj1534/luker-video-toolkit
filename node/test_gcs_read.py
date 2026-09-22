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

class DownloadTicketTest(unittest.TestCase):
    def test_authenticated_creation_single_use_and_attachment_only(self):
        import worker, threading, urllib.request, urllib.error, json, io
        old=worker.CONFIG
        worker.CONFIG={'token':'test-token','bucket':'test-bucket','gcs_private_endpoint':'199.36.153.8','max_bytes':100}
        server=worker.http.server.ThreadingHTTPServer(('127.0.0.1',0),worker.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        root='http://127.0.0.1:'+str(server.server_port)
        try:
            body=json.dumps({'url':'https://storage.googleapis.com/test-bucket/file?X-Goog-Signature=test','filename':'file.txt'}).encode()
            with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(urllib.request.Request(root+'/downloads',data=body))
            self.assertEqual(caught.exception.code,401)
            request=urllib.request.Request(root+'/downloads',data=body,headers={'Authorization':'Bearer test-token'})
            ticket=json.load(urllib.request.urlopen(request))['ticket']
            source=io.BytesIO(b'hello');source.headers={'Content-Length':'5'}
            with patch('worker.gcs_read.open_read',return_value=source):
                with urllib.request.urlopen(root+'/downloads/'+ticket) as response:
                    self.assertTrue(response.headers['Content-Disposition'].startswith('attachment;'))
                    self.assertEqual(response.read(),b'hello')
            with self.assertRaises(urllib.error.HTTPError) as caught:urllib.request.urlopen(root+'/downloads/'+ticket)
            self.assertEqual(caught.exception.code,404)
        finally:
            server.shutdown();server.server_close();worker.CONFIG=old
