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
paths = ['VERSION', 'LICENSE', 'README.md', 'node', 'scripts/install-node.py', 'docs/node-nginx.example.conf', 'docs/installation.md', 'docs/file-library.md']
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
# One release ships the independent application and the worker package.
app_asset=destination/f'file-library-app-{version}.tar.gz'
app_paths=['VERSION','LICENSE','README.md','package.json','package-lock.json','app','server','media.js','upload.js','library-ui.js','settings.js','style.css','scripts/install-app.py','scripts/create-account.mjs','scripts/apply-retention.py','docs']
with app_asset.open('wb') as raw,gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed,tarfile.open(fileobj=compressed,mode='w') as archive:
    for name in app_paths:
        source=root/name
        for file in sorted(source.rglob('*')) if source.is_dir() else [source]:
            if file.is_file() and '__pycache__' not in file.parts:
                archive.add(file,arcname='file-library-app-'+version+'/'+str(file.relative_to(root)),filter=metadata)
with (destination/'SHA256SUMS').open('a') as out:out.write(hashlib.sha256(app_asset.read_bytes()).hexdigest()+'  '+app_asset.name+'\n')
print(app_asset.name)
