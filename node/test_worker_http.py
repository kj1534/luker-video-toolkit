import importlib.util
import pathlib
import json
import threading
import unittest
import urllib.request
import urllib.error
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('http_worker',pathlib.Path(__file__).with_name('worker.py'))
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class WorkerHttpTest(unittest.TestCase):
    def test_authenticated_two_phase_job_and_no_private_fields_or_replay(self):
        worker.CONFIG={'token':'test-token','bucket':'test-videos'}
        worker.JOBS.clear()
        server=worker.http.server.ThreadingHTTPServer(('127.0.0.1',0),worker.Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def call(path,body=None,token='test-token'):
            request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,data=json.dumps(body).encode()if body is not None else None,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
            try:r=urllib.request.urlopen(request,timeout=3)
            except urllib.error.HTTPError as e:r=e
            with r:return r.status,json.load(r)
        try:
            with patch.object(worker.POOL,'submit') as submit:
                self.assertEqual(call('/jobs',{'source_url':'https://example.org/video.mp4'},'wrong')[0],401)
                code,entry=call('/jobs',{'source_url':'https://example.org/video.mp4'})
                self.assertEqual(code,202);self.assertEqual(submit.call_count,1)
                ident=entry['id'];job=worker.JOBS[ident]
                job.update(status='ready',_file='/private/temp/video.mp4',metadata={'size':12})
                self.assertNotIn('_file',call('/jobs/'+ident)[1])
                self.assertEqual(call('/jobs/'+ident+'/upload',{'session':'https://example.org/upload'})[0],400)
                session='https://storage.googleapis.com/upload/storage/v1/b/test-videos/o?upload_id=test'
                self.assertEqual(call('/jobs/'+ident+'/upload',{'session':session})[0],202)
                self.assertEqual(call('/jobs/'+ident+'/upload',{'session':session})[0],400)
                self.assertEqual(submit.call_count,2)
        finally:server.shutdown();server.server_close();thread.join()
