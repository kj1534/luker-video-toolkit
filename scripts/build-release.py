#!/usr/bin/env python3
import hashlib
import gzip
import pathlib
import tarfile

root = pathlib.Path(__file__).resolve().parents[1]
version = (root / 'VERSION').read_text().strip()
destination = root / 'dist'
destination.mkdir(exist_ok=True)
asset = destination / f'video-toolkit-node-{version}.tar.gz'
paths = ['VERSION', 'LICENSE', 'README.md', 'node', 'scripts/install-node.py', 'docs/node-nginx.example.conf', 'docs/installation.md']
def metadata(item):
    item.uid = item.gid = 0
    item.uname = item.gname = ''
    item.mtime = 0
    return item

with asset.open('wb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as archive:
    for name in paths:
        source = root / name
        files = sorted(source.rglob('*')) if source.is_dir() else [source]
        for file in files:
            if file.is_file() and '__pycache__' not in file.parts and not file.name.startswith('test_'):
                archive.add(file, arcname='video-toolkit-node-' + version + '/' + str(file.relative_to(root)), filter=metadata)
checksum = hashlib.sha256(asset.read_bytes()).hexdigest()
(destination / 'SHA256SUMS').write_text(checksum + '  ' + asset.name + '\n')
print(asset.name)
