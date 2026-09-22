#!/usr/bin/env python3
"""Root-owned timer: apply only validated lifetime numbers to a fixed copyparty unit."""
import argparse
import fcntl
import json
import os
import pathlib
import re
import subprocess
p=argparse.ArgumentParser();p.add_argument('--worker-config',required=True);p.add_argument('--unit',default='/etc/systemd/system/copyparty.service');a=p.parse_args()
c=json.loads(pathlib.Path(a.worker_config).read_text());state=pathlib.Path(c['download_directory']).parent;runtime=state/'runtime.json'
desired=json.loads(runtime.read_text()).get('retention_seconds',604800) if runtime.exists() else 604800
if type(desired) is not int or not 86400<=desired<=2592000:raise SystemExit('Invalid retention')
lock=open(c['egress_lock_file'],'a')
try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:raise SystemExit(0)
# Complete current transfers before restarting copyparty.
jobs=json.loads((state/'jobs.json').read_text()) if (state/'jobs.json').exists() else {}
if any(j['status'] not in ('complete','failed','cancelled','expired') for j in jobs.values()):raise SystemExit(0)
unit=pathlib.Path(a.unit);before=unit.read_text();after=re.sub(r'lifetime=\d+',f'lifetime={desired}',before)
if before!=after:
    unit.with_suffix('.service.before-library-policy').write_text(before)
    unit.write_text(after)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','restart','copyparty.service'],check=True)
actual=subprocess.check_output(['systemctl','show','copyparty.service','-p','ExecStart'],text=True)
values=[int(v) for v in re.findall(r'lifetime=(\d+)',actual)]
if not values or any(v!=desired for v in values):raise SystemExit('Retention not applied')
file=state/'policy-applied.json';temp=file.with_suffix('.tmp');temp.write_text(json.dumps({'seconds':desired,'volumes':len(values)}));os.chmod(temp,0o644);temp.replace(file)
