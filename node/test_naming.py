import unittest
import naming
class NamingTest(unittest.TestCase):
    def test_iwara_uses_display_name_title_and_video_id(self):
        name=naming.webpage_name({'id':'video123','title':'测试标题','uploader':'显示昵称','uploader_id':'authorname'},True)
        self.assertEqual(name,'显示昵称 - 测试标题 [video123].mp4')
    def test_multilingual_names_fit_filesystem_and_remove_path_characters(self):
        name=naming.webpage_name({'id':'id','title':'中'*500+'/../bad','uploader_id':'作'*100},True)
        self.assertLess(len(name.encode())+22,255);self.assertNotIn('/',name)
        self.assertEqual(naming.filename('simple.txt','.txt'),'simple.txt')
    def test_bilibili_prefers_readable_author(self):
        self.assertEqual(naming.webpage_name({'id':'BVtest','title':'Title','uploader':'Author','uploader_id':'123'}),'Author - Title [BVtest].mp4')
