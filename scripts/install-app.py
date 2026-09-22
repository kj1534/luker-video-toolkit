#!/usr/bin/env python3
"""Install the standalone service; Node 24+, private config and npm ci are prerequisites."""
import argparse
import pathlib
import subprocess
p=argparse.ArgumentParser();p.add_argument('--source',required=True);p.add_argument('--config',required=True);p.add_argument('--node',required=True);p.add_argument('--user',default='file-library');a=p.parse_args()
for value in [a.source,a.config,a.node]:
    if not value.startswith('/') or any(c in value for c in '\n\r \t'):raise SystemExit('Absolute paths without whitespace required')
unit=f'''[Unit]
Description=Independent File Library
After=network-online.target
Wants=network-online.target
[Service]
User={a.user}
Group={a.user}
WorkingDirectory={a.source}
ExecStart={a.node} {a.source}/app/main.mjs --config {a.config}
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={pathlib.Path(a.config).parent}
MemoryHigh=256M
MemoryMax=384M
[Install]
WantedBy=multi-user.target
'''
pathlib.Path('/etc/systemd/system/file-library.service').write_text(unit)
subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','enable','--now','file-library.service'],check=True)
