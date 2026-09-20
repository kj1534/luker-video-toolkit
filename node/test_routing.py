import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import web_import

class RoutingTest(unittest.TestCase):
    def test_small_video_is_published_and_large_video_waits_for_gcs(self):
        for size,expected in [(10,'complete'),(11,'ready')]:
            with tempfile.TemporaryDirectory() as directory:
                file=pathlib.Path(directory)/'video.mp4';file.write_bytes(b'x'*size)
                job={}
                config={'max_bytes':100,'ffprobe':'ffprobe','small_video':{'enabled':True,'max_bytes':10,'copyparty':{}}}
                output=type('Probe',(),{'stdout':json.dumps({'streams':[{'codec_type':'video'}],'format':{'duration':'4'}}).encode()})()
                with patch('web_import.subprocess.run',return_value=output),patch('web_import.copyparty_store.publish',return_value={'url':'https://media.example/imports/video.mp4?k=test'}) as publish:
                    web_import.finish_file(job,file,'video.mp4','video/mp4',config)
                    self.assertEqual(job['status'],expected)
                    self.assertEqual(publish.called,size<=10)
                    if size>10:self.assertEqual(job['_file'],str(file))
    def test_gcs_only_mode_does_not_publish_small_videos(self):
        with tempfile.TemporaryDirectory() as directory:
            file=pathlib.Path(directory)/'video.mp4';file.write_bytes(b'test')
            job={};config={'max_bytes':100,'ffprobe':'ffprobe','small_video':{'enabled':False}}
            output=type('Probe',(),{'stdout':b'{"streams":[{"codec_type":"video"}],"format":{"duration":"4"}}'})()
            with patch('web_import.subprocess.run',return_value=output),patch('web_import.copyparty_store.publish') as publish:
                web_import.finish_file(job,file,'video.mp4','video/mp4',config)
                self.assertEqual(job['status'],'ready');publish.assert_not_called()
