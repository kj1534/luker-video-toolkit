"""Readable, portable media names; source identity is separate from storage uniqueness."""
import re
import pathlib
import unicodedata


def clean(value, budget):
    text=unicodedata.normalize('NFKC',str(value or ''))
    text=re.sub(r'[\\/:*?"<>|\x00-\x1f\x7f]', '_',text).strip(' .')
    return text.encode('utf-8')[:budget].decode('utf-8','ignore').rstrip(' .')


def webpage_name(info, iwara=False):
    # Prefer IwaraDownloadTool ALIAS (user.name); retain username only when display name is absent.
    author=clean(info.get('uploader') or info.get('uploader_id') or 'unknown-author',48)
    identifier=clean(info.get('id') or 'unknown-id',32)
    overhead=len(f'{author} - .mp4'.encode('utf-8'))
    title=clean(info.get('title') or identifier,min(120,175-overhead))
    return f'{author} - {title}.mp4'


def filename(value, extension=''):
    text=str(value or '')
    suffix=extension or pathlib.Path(text).suffix
    if not re.fullmatch(r'\.[a-zA-Z0-9]{1,12}',suffix):suffix=''
    stem=text[:-len(suffix)] if suffix and text.lower().endswith(suffix.lower()) else text
    return (clean(stem,210-len(suffix)) or 'file')+suffix
