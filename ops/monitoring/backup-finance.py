# Reads an owner-only environment backup; no credential is passed in argv/log output.
import os, pathlib, shlex, subprocess, sys, urllib.parse
try:
    source=pathlib.Path(sys.argv[1])
    if source.stat().st_mode & 0o077: raise ValueError('private file required')
    settings={}
    for line in source.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith('#') or '=' not in line: continue
        key,value=line.split('=',1)
        parsed=shlex.split(value,comments=True)
        settings[key.strip()]=parsed[0] if parsed else ''
    uri=urllib.parse.urlsplit(settings['DATABASE_URL'])
    if uri.scheme not in ('postgres','postgresql'): raise ValueError('database protocol')
    env={**os.environ,'PGHOST':uri.hostname,'PGPORT':str(uri.port or 5432),
         'PGDATABASE':urllib.parse.unquote(uri.path[1:]),'PGUSER':urllib.parse.unquote(uri.username),
         'PGPASSWORD':urllib.parse.unquote(uri.password or ''),'PGCONNECT_TIMEOUT':'15',
         'PGOPTIONS':'-c default_transaction_read_only=on -c lock_timeout=5000'}
    options=urllib.parse.parse_qs(uri.query)
    if 'sslmode' in options: env['PGSSLMODE']=options['sslmode'][0]
    dest=pathlib.Path(sys.argv[2])
    subprocess.run(['pg_dump','--format=custom','--schema=finance','--no-owner','--no-acl','--file='+str(dest)],env=env,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    dest.chmod(0o600)
    subprocess.run(['pg_restore','--list',str(dest)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    print('Finance backup archive verified')
except Exception:
    print('Finance backup failed; details withheld',file=sys.stderr)
    sys.exit(1)
