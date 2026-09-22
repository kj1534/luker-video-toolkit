import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import library
import web_import

class LibraryTest(unittest.TestCase):
    def test_paths_cannot_escape_a_configured_volume(self):
        for path in ['/etc/passwd','../other/file','a/../file','a//b','a\\b','a/./b','a\nfile']:
            with self.subTest(path=path), self.assertRaises(ValueError):library.relative_path(path)
        self.assertEqual(library.relative_path('folder/文件.txt'),'folder/文件.txt')
        with self.assertRaises(ValueError):library.volume({'library_volumes':[]},'unconfigured')

    def test_changed_file_is_not_deleted(self):
        item={'size':20,'modified':200}
        with patch('library.get_file',return_value=item),patch('library.request') as request:
            with self.assertRaises(ValueError):library.delete_file({},'files','report.pdf',10,100)
            request.assert_not_called()

    def test_listing_rejects_external_urls_and_keeps_folder_paths(self):
        root={'id':'files','public_url':'https://media.example/files'}
        class Response:
            def __enter__(self):return self
            def __exit__(self,*args):pass
        for href in ['https://attacker.example/a.mp4','../a.mp4']:
            with patch('library.request',return_value=Response()),patch('library.json.load',return_value={'files':[{'href':href}]}):
                with self.assertRaises(ValueError):library.list_files({'library_volumes':[root]},'files','')
        with patch('library.request',return_value=Response()),patch('library.json.load',return_value={'files':[{'href':'file%20name.pdf?k=fixture','sz':9,'ts':1}]}):
            result=library.list_files({'library_volumes':[root]},'files','folder')
            self.assertEqual(result['items'][0]['path'],'folder/file name.pdf')
            self.assertEqual(result['items'][0]['url'],'https://media.example/files/folder/file%20name.pdf?k=fixture')

    def test_explicit_copy_overrides_size_routing_without_media_probe_for_documents(self):
        for destination,size,expected in [('gcs',5,'ready'),('copyparty',20,'complete')]:
            with tempfile.TemporaryDirectory() as directory:
                file=pathlib.Path(directory)/'report.pdf';file.write_bytes(b'x'*size)
                config={'max_bytes':100,'_destination':destination,'small_video':{'enabled':True,'max_bytes':10,'copyparty':{}}}
                with patch('web_import.subprocess.run') as probe,patch('web_import.copyparty_store.publish',return_value={'url':'https://media.example/report.pdf?k=test'}) as publish:
                    job={};web_import.finish_file(job,file,'report.pdf','application/pdf',config)
                    self.assertEqual(job['status'],expected);probe.assert_not_called()
                    self.assertEqual(publish.called,destination=='copyparty')
