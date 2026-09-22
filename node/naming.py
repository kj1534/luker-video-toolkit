"""Readable, portable media names; source identity is separate from storage uniqueness."""
import re
import pathlib
import unicodedata


def clean(value, budget):
    text=unicodedata.normalize('NFKC',str(value or ''))
    text=re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', '_',text).strip(' .')
    return text.encode('utf-8')[:budget].decode('utf-8','ignore').rstrip(' .')


def webpage_name(info, iwara=False):
    # IwaraDownloadTool AUTHOR maps to user.username, exposed as uploader_id by yt-dlp.
    author=clean((info.get('uploader_id') if iwara else info.get('uploader')) or info.get('uploader') or info.get('uploader_id') or 'unknown-author',48)
    identifier=clean(info.get('id') or 'unknown-id',32)
    title=clean(info.get('title') or identifier,120)
    return f'{author} - {title} [{identifier}].mp4'


def filename(value, extension=''):
    text=str(value or '')
    suffix=extension or pathlib.Path(text).suffix
    if not re.fullmatch(r'\.[a-zA-Z0-9]{1,12}',suffix):suffix=''
    stem=text[:-len(suffix)] if suffix and text.lower().endswith(suffix.lower()) else text
    return (clean(stem,210-len(suffix)) or 'file')+suffix
