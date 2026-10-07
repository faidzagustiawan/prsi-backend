#!/usr/bin/env python3
"""Secrets stay in root-only files and stdin; never print subprocess output."""
import os
import pathlib
import re
import subprocess

os.umask(0o077)
root = pathlib.Path('/etc/prsi-monitoring/secrets')
password = (root / 'ntfy-password').read_text().strip()
command = ['docker', 'compose', 'exec', '-T', 'ntfy', 'sh', '-c',
           'read -r NTFY_PASSWORD; export NTFY_PASSWORD; exec ntfy user add --ignore-exists --role=admin owner']
result = subprocess.run(command, input=password+'\n', text=True, capture_output=True)
if result.returncode:
    raise SystemExit('ntfy user initialization failed; output suppressed')
if not (root / 'ntfy-token').exists():
    result = subprocess.run(['docker','compose','exec','-T','ntfy','ntfy','token','add','--label=prsi-monitoring','owner'], text=True, capture_output=True)
    match = re.search(r'\btk_[a-zA-Z0-9]{29}\b', result.stdout + result.stderr)
    if result.returncode or not match:
        raise SystemExit('ntfy token initialization failed; output suppressed')
    (root / 'ntfy-token').write_text(match.group(0)+'\n')
print('ntfy owner and token ready; secret files remain root-only')
