#!/usr/bin/env python3
"""Install/upgrade an extracted release. All runtime settings and secrets remain outside the code."""
import argparse
import grp
import json
import os
import pathlib
import pwd
import re
import shutil
import subprocess


def safe_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in pathlib.PurePosixPath(value).parts:
        raise ValueError('Use absolute Linux paths without whitespace or parent traversal')
    return pathlib.Path(value)


def install(config_path, source):
    if os.geteuid() != 0:
        raise SystemExit('Run as root (sudo).')
    config = json.loads(config_path.read_text())
    prefix = safe_path(config['install_directory'])
    download = safe_path(config['download_directory'])
    user = config['service_user']
    service = config['service_name']
    if not re.fullmatch(r'[a-z][a-z0-9-]*', user) or not re.fullmatch(r'[a-z][a-z0-9-]*', service):
        raise ValueError('Invalid service user/name')
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise SystemExit('Install ffmpeg and python3-venv first.')
    try:
        pwd.getpwnam(user)
    except KeyError:
        subprocess.run(['useradd', '--system', '--user-group', '--no-create-home', '--shell', '/usr/sbin/nologin', user], check=True)
    prefix.mkdir(parents=True, exist_ok=True)
    version = (source / 'VERSION').read_text().strip()
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid release version')
    backup = prefix / 'previous'
    backup.mkdir(exist_ok=True)
    names = ['VERSION', 'worker.py', 'source_fetch.py', 'web_import.py', 'copyparty_store.py', 'library.py', 'gcs_read.py', 'local_upload.py', 'naming.py', 'control.py', 'requirements.lock.txt']
    for name in names:
        if (prefix / name).exists():
            shutil.copy2(prefix / name, backup / name)
        shutil.copy2(source / name if name == 'VERSION' else source / 'node' / name, prefix / name)
    venv = prefix / 'venv'
    if not venv.exists():
        subprocess.run(['/usr/bin/python3', '-m', 'venv', str(venv)], check=True)
    if pathlib.Path(config['yt_dlp']) != venv / 'bin/yt-dlp':
        raise ValueError('yt_dlp must point to install_directory/venv/bin/yt-dlp')
    subprocess.run([str(venv / 'bin/pip'), 'install', '--disable-pip-version-check', '-r', str(prefix / 'requirements.lock.txt')], check=True)
    download.mkdir(parents=True, exist_ok=True)
    shutil.chown(download.parent,user=user,group=user)
    shutil.chown(download, user=user, group=user)
    download.chmod(0o700)
    config_path.chmod(0o640); shutil.chown(config_path, user='root', group=user)
    credentials = [safe_path(config['token_file'])]
    if config['small_video']['enabled']:
        credentials.append(safe_path(config['small_video']['copyparty']['password_file']))
    credentials += [safe_path(v['password_file']) for v in config.get('library_volumes', [])]
    for file in credentials:
        file.chmod(0o640); shutil.chown(file, user='root', group=user)
    limits = config['resources']
    for key in ['memory_high', 'memory_max']:
        if not re.fullmatch(r'[1-9][0-9]*[MG]', limits[key]): raise ValueError('Invalid memory limit')
    if not re.fullmatch(r'[1-9][0-9]*%', limits['cpu_quota']): raise ValueError('Invalid CPU quota')
    unit = f'''[Unit]
Description=Video Toolkit parser and uploader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={user}
Group={user}
ExecStart=/usr/bin/python3 {prefix}/worker.py --config {config_path}
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={download.parent}
UMask=0077
MemoryHigh={limits['memory_high']}
MemoryMax={limits['memory_max']}
CPUQuota={limits['cpu_quota']}
Nice=10
TasksMax=128

[Install]
WantedBy=multi-user.target
'''
    (pathlib.Path('/etc/systemd/system') / (service + '.service')).write_text(unit)
    (prefix / 'VERSION').write_text(version + '\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', service], check=True)
    subprocess.run(['systemctl', 'restart', service], check=True)
    print(f'Installed Video Toolkit node {version}; configuration preserved at {config_path}.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=safe_path)
    parser.add_argument('--source', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    install(args.config, args.source)
