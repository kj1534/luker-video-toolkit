import io
import pathlib
import tempfile
import unittest
import local_upload

class LocalUploadTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config={'max_bytes':100,'download_directory':self.temp.name,'small_video':{'enabled':True,'max_bytes':4,'copyparty':{}},'library_volumes':[{'id':'imports','api_url':'http://127.0.0.1/imports/'}]}
        self.body={'filename':'test.txt','size':8,'origin':'https://ui.example','mode':'auto','threshold':4,'volume':'imports','mime_type':'text/plain'}
    def create(self,**kwargs):
        job={'id':'test'};result=local_upload.create(job,{**self.body,**kwargs},self.config);return job,result
    def test_modes_single_upload_then_local_copy(self):
        for mode,size,destination in [('auto',8,'gcs'),('auto',4,'copyparty'),('both',4,'gcs'),('copyparty',8,'copyparty')]:
            job,ticket=self.create(mode=mode,size=size)
            self.assertEqual(job['_upload_config']['_destination'],destination)
            self.assertEqual(job['_upload_config']['_sync_copyparty'],destination=='gcs')
            self.assertNotIn('_file',ticket);self.assertGreater(len(ticket['ticket']),32)
    def test_resume_rejects_duplicates_and_rolls_back_incomplete_chunk(self):
        job,_=self.create()
        self.assertEqual(local_upload.receive(job,io.BytesIO(b'abcd'),4,'bytes 0-3/8')['offset'],4)
        with self.assertRaises(ValueError):local_upload.receive(job,io.BytesIO(b'abcd'),4,'bytes 0-3/8')
        with self.assertRaises(ValueError):local_upload.receive(job,io.BytesIO(b'e'),4,'bytes 4-7/8')
        self.assertEqual(pathlib.Path(job['_file']).read_bytes(),b'abcd')
        self.assertTrue(local_upload.receive(job,io.BytesIO(b'efgh'),4,'bytes 4-7/8')['complete'])
        self.assertEqual(pathlib.Path(job['_file']).read_bytes(),b'abcdefgh')
    def test_paths_origins_modes_and_limits(self):
        for changes in [{'filename':'../file'},{'size':101},{'mode':'gcs'},{'origin':'https://user:password@example.org'},{'origin':'null'},{'volume':'other'}]:
            with self.assertRaises(ValueError):self.create(**changes)

class LocalUploadHTTPTest(LocalUploadTest):
    def test_origin_bound_ticket_cors_and_finalization(self):
        import worker,threading,json,urllib.request,urllib.error
        from unittest.mock import patch
        previous=worker.CONFIG;worker.CONFIG={**self.config,'token':'test-token'}
        server=worker.http.server.ThreadingHTTPServer(('127.0.0.1',0),worker.Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        base='http://127.0.0.1:'+str(server.server_port)
        def request(path,body=None,method=None,headers={}):
            return urllib.request.urlopen(urllib.request.Request(base+path,data=body,method=method,headers=headers))
        try:
            payload=json.dumps(self.body).encode()
            with self.assertRaises(urllib.error.HTTPError) as error:request('/local-uploads',payload)
            self.assertEqual(error.exception.code,401)
            with request('/local-uploads',payload,headers={'Authorization':'Bearer test-token'}) as response:ticket=json.load(response)
            target='/upload-data/'+ticket['ticket']
            with self.assertRaises(urllib.error.HTTPError) as error:request(target,headers={'Origin':'https://other.example'})
            self.assertEqual(error.exception.code,403)
            with request(target,method='OPTIONS',headers={'Origin':self.body['origin']}) as response:self.assertEqual(response.headers['Access-Control-Allow-Origin'],self.body['origin'])
            with request(target,b'abcdefgh','PUT',{'Origin':self.body['origin'],'Content-Range':'bytes 0-7/8'}) as response:self.assertTrue(json.load(response)['complete'])
            with request(target,headers={'Origin':self.body['origin']}) as response:self.assertEqual(json.load(response)['offset'],8)
            with patch('worker.web_import.finish_file') as finish:
                with request('/local-uploads/'+ticket['id']+'/finish',b'{}',headers={'Authorization':'Bearer test-token'}) as response:self.assertEqual(response.status,202)
                import time
                for _ in range(20):
                    if finish.called:break
                    time.sleep(.01)
                self.assertTrue(finish.called)
        finally:
            server.shutdown();server.server_close();worker.CONFIG=previous
