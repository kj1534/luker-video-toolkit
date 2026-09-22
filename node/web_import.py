"""Anonymous Iwara/Bilibili/YouTube downloads with per-site proxy routing."""
import json
import mimetypes
import copyparty_store
import gcs_read
import naming
import math
import urllib.parse
import os
import pathlib
import re
import shutil
import signal
import subprocess
import tempfile
import time
from source_fetch import validate_https, open_source

ALLOWED = {
    'iwara.tv', 'www.iwara.tv',
    'bilibili.com', 'www.bilibili.com', 'm.bilibili.com', 'b23.tv',
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be',
}


def source_site(url):
    host = validate_https(url).hostname
    if host.endswith('iwara.tv'):
        return 'iwara'
    if host.endswith('bilibili.com') or host == 'b23.tv':
        return 'bilibili'
    if host.endswith('youtube.com') or host == 'youtu.be':
        return 'youtube'
    return 'direct'


def parser_proxy(config, fallback, site):
    per_site = config.get('parser_proxies', {})
    if isinstance(per_site, dict) and per_site.get(site):
        return per_site[site]
    return config.get('parser_proxy') or fallback


def page_url(value):
    u = validate_https(value)
    if u.hostname not in ALLOWED:
        raise ValueError('Only Iwara, Bilibili and YouTube video pages are supported')
    if u.hostname.endswith('iwara.tv') and not re.match(r'^/(?:[a-z]{2}/)?video/', u.path):
        raise ValueError('Use a single Iwara video page')
    if u.hostname.endswith('bilibili.com') and not u.path.startswith('/video/'):
        raise ValueError('Use a single Bilibili video page')
    if u.hostname.endswith('youtube.com') and u.path != '/watch' and not u.path.startswith(('/shorts/', '/live/')):
        raise ValueError('Use a single YouTube video page')
    if u.hostname == 'youtu.be' and not u.path.strip('/'):
        raise ValueError('Use a single YouTube video page')
    return value


def cleanup(job):
    if job.get('_directory'):
        shutil.rmtree(job.pop('_directory'), ignore_errors=True)
    job.pop('_file', None)


def finish_file(job, file, title, mime, config):
    size = file.stat().st_size
    if not 0 < size <= config['max_bytes']:
        raise ValueError('文件超过 2 GiB 上限或内容为空。')
    duration = None
    if mime.startswith(('video/', 'audio/')):
        info = subprocess.run([config['ffprobe'], '-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', str(file)], capture_output=True, check=True, timeout=30)
        media = json.loads(info.stdout)
        duration = float(media['format']['duration'])
        if not media.get('streams') or not math.isfinite(duration) or duration <= 0:
            raise ValueError('文件不包含可识别的音视频或有效时长。')
    title = naming.filename(title,file.suffix)
    metadata = {'filename': title, 'size': size, 'mime_type': mime, 'duration_seconds': duration}
    if config.get('_source_id'):metadata['source_id']=config['_source_id']
    job.update(total=size, done=size, metadata=metadata)
    small = config['small_video']
    if config.get('_destination') == 'copyparty' or (config.get('_destination', 'auto') == 'auto' and small['enabled'] and size <= small['max_bytes']):
        job['status'] = 'publishing'
        video = copyparty_store.publish(file, metadata, small['copyparty'])
        job.update(status='complete', video=video, finished=time.time())
        cleanup(job)
    else:
        if config.get('_sync_copyparty'):
            job['status'] = 'publishing'
            try:
                job['sync_video'] = copyparty_store.publish(file, metadata, small['copyparty'])
            except Exception:
                job['warning'] = 'copyparty 同步失败，GCS 上传将继续；完成后可重试复制。'
        job.update(status='ready', ready_at=time.time(), _file=str(file))


def direct_download(job, url, directory, config):
    types = {'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/mpeg': '.mpeg', 'video/x-msvideo': '.avi', 'video/avi': '.avi', 'video/x-ms-wmv': '.wmv', 'video/wmv': '.wmv', 'video/3gpp': '.3gp', 'video/x-flv': '.flv'}
    with (gcs_read.open_read(url, config) if config.get('_gcs_source') else open_source(url)) as response:
        mime = response.headers.get('Content-Type', '').split(';')[0].lower()
        title = response.headers.get_filename() or urllib.parse.unquote(urllib.parse.urlsplit(response.url).path.rsplit('/', 1)[-1]) or 'video'
        title = config.get('_filename') or title
        extension = pathlib.Path(title).suffix.lower()
        if not re.fullmatch(r'\.[a-z0-9]{1,12}', extension):
            extension = types.get(mime) or mimetypes.guess_extension(mime) or '.bin'
        if mime in ('application/octet-stream', ''):
            mime = types.get(mime) or mimetypes.guess_type(title)[0] or 'application/octet-stream'
        if mime == 'text/html' and not config.get('_filename'):
            raise ValueError('播放页目前仅支持 Iwara 和 B站；其他来源请提供文件直链。')
        total = int(response.headers.get('Content-Length', '0'))
        if total > config['max_bytes']:
            raise ValueError('视频超过 2 GiB 上限。')
        job['total'] = total
        file = pathlib.Path(directory) / ('video' + extension)
        deadline = time.monotonic() + config['download_timeout_seconds']
        with file.open('wb') as target:
            done = 0
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                done += len(block)
                if done > config['max_bytes'] or time.monotonic() > deadline or shutil.disk_usage(directory).free < 256 * 1024 * 1024:
                    raise ValueError('下载超时、文件过大或节点空间不足。')
                target.write(block)
                job['done'] = done
            if total and done != total:
                raise ValueError('视频下载不完整，请重试。')
    finish_file(job, file, title, mime, config)


def download(job, url, config, proxy):
    job.update(status='downloading', done=0, total=0)
    directory = tempfile.mkdtemp(prefix='gcs-web-', dir=config['download_directory'])
    job['_directory'] = directory
    process = None
    try:
        if shutil.disk_usage(directory).free < config['max_bytes'] * 3:
            raise ValueError('下载节点磁盘空间不足，请稍后再试。')
        if validate_https(url).hostname not in ALLOWED:
            job['kind'] = 'direct'
            direct_download(job, url, directory, config)
            return
        job['kind'] = 'webpage'
        page_url(url)
        if validate_https(url).hostname == 'b23.tv':
            with open_source(url, method='HEAD') as response:
                url = page_url(response.url)
        url = url.replace('https://m.bilibili.com/', 'https://www.bilibili.com/')
        url = re.sub(r'^(https://(?:www\.)?iwara\.tv)/[a-z]{2}/video/', r'\1/video/', url)
        site = source_site(url)
        parse_proxy = parser_proxy(config, proxy, site)
        extract = [config['yt_dlp'], '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
                   '--no-warnings', '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2',
                   '--proxy', parse_proxy, '--use-extractors', 'Iwara$,BiliBili$,Youtube$',
                   '--skip-download', '--dump-single-json', '--', page_url(url)]
        # Expiring URLs stay in this private directory. Iwara and Bilibili media
        # are fetched from the node directly; YouTube keeps the parser exit.
        with open(directory + '/info.json', 'wb') as info, open(directory + '/error.log', 'wb') as errors:
            process = subprocess.Popen(extract, stdout=info, stderr=errors, start_new_session=True)
            process.wait(timeout=min(180, config['download_timeout_seconds']))
        if process.returncode:
            raise ValueError('网站解析失败；当前解析出口可能已失效，请稍后重试。')
        download_proxy = parse_proxy if site == 'youtube' else proxy
        command = [config['yt_dlp'], '--ignore-config', '--no-cache-dir', '--no-playlist', '--no-progress',
                   '--no-warnings', '--socket-timeout', '30', '--retries', '2', '--fragment-retries', '2',
                   '--proxy', download_proxy,
                   '--max-filesize', str(config['max_bytes']), '--match-filter', '!is_live',
                   '--format', 'bv*[protocol=https]+ba[protocol=https]/b[protocol=https]',
                   '--merge-output-format', 'mp4', '--remux-video', 'mp4',
                   '--output', directory + '/video.%(ext)s', '--load-info-json', directory + '/info.json']
        # Logs may contain expiring URLs; keep only in this private temporary directory.
        with open(directory + '/output.log', 'wb') as output, open(directory + '/error.log', 'wb') as errors:
            process = subprocess.Popen(command, stdout=output, stderr=errors, start_new_session=True)
            deadline = time.monotonic() + config['download_timeout_seconds']
            while process.poll() is None:
                time.sleep(1)
                size = sum(p.stat().st_size for p in pathlib.Path(directory).iterdir() if p.is_file())
                job['done'] = size
                if time.monotonic() > deadline or size > config['max_bytes'] * 2 + 16 * 1024 * 1024 or shutil.disk_usage(directory).free < 256 * 1024 * 1024:
                    raise ValueError('下载超时、文件过大或节点磁盘空间不足。')
        if process.returncode:
            error = pathlib.Path(directory + '/error.log').read_text(errors='replace')[-8000:].lower()
            if any(word in error for word in ['login', 'log in', 'sign in', 'cookies', 'private video', 'premium', '403', '412']):
                raise ValueError('网站要求登录、限制服务器访问或视频不可公开下载；未使用浏览器登录凭据。')
            raise ValueError('网站解析或下载失败；此链接可能不可公开访问，或解析器需要更新。')
        file = pathlib.Path(directory + '/video.mp4')
        info = json.loads(pathlib.Path(directory + '/info.json').read_text(errors='replace'))
        config['_source_id']=str(info.get('id') or '')[:100]
        title = naming.webpage_name(info,validate_https(url).hostname.endswith('iwara.tv'))
        finish_file(job, file, title, 'video/mp4', config)
    except Exception as error:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        job.update(status='failed', error=str(error) if isinstance(error, ValueError) else '视频下载或合并失败。', finished=time.time())
        cleanup(job)
    finally:
        if process and process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
