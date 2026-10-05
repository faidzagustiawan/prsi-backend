#!/bin/bash
# Run only with an archive of a commit verified as merged into origin/main.
# Usage: sudo bash deploy-app.sh /absolute/release.tar /absolute/monitor-token
set -euo pipefail
umask 077
test "$(hostname)" = VM-26-196-ubuntu
archive=$(realpath "$1")
token=$(realpath "$2")
test -f "$archive" && test -s "$token"
# Operator must fetch main and verify the archive commit is merged before setting this.
test -n "${MERGED_COMMIT_CONFIRMED:-}"
test "$(git get-tar-commit-id < "$archive")" = "$MERGED_COMMIT_CONFIRMED"
# Reject path traversal/symlinks before extracting an archive as root.
python3 - "$archive" <<'PY_ARCHIVE'
import pathlib, sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    for item in archive:
        path=pathlib.PurePosixPath(item.name)
        if path.is_absolute() or '..' in path.parts or item.issym() or item.islnk() or not (item.isfile() or item.isdir()):
            raise SystemExit('Unsafe release archive entry')
        if path.name.startswith('.env') and path.name not in ('.env.example','.env.production.example'):
            raise SystemExit('Release archive must not contain credentials')
PY_ARCHIVE
grep -Fq 'location ^~ /internal/' /etc/nginx/sites-available/podorukun-si
grep -Fq 'location = /internal' /etc/nginx/sites-available/podorukun-si
nginx -t
base=/opt/podorukun-si
stamp=$(date -u +%Y%m%dT%H%M%SZ)
next="$base/app.monitor-$stamp"
previous="$base/app.prev-$stamp"
backup="/var/backups/podorukun-si/pre-monitoring-$stamp"
install -d -m 0700 "$backup"
tar --exclude=node_modules -C "$base" -czf "$backup/app.tgz" app
cp -a /etc/nginx/sites-available/podorukun-si "$backup/nginx.conf"
systemctl cat podorukun-si-api > "$backup/service.txt"
# No migration is run by this deployment. Back up finance before application swap.
cp -a "$base/app/.env" "$backup/runtime.env"
chmod 0600 "$backup/runtime.env"
python3 "$(dirname "$0")/backup-finance.py" "$backup/runtime.env" "$backup/finance.dump"
tar -tzf "$backup/app.tgz" >/dev/null
install -d "$next"
tar -xf "$archive" -C "$next"
cp -a "$base/app/.env" "$next/.env"
# Refuse any deployment that would change the required safety gates.
python3 - "$next/.env" "$token" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); text=p.read_text()
settings=dict(line.split('=',1) for line in text.splitlines() if '=' in line and not line.lstrip().startswith('#'))
for key in ('ALLOW_UNSAFE_DB_ROLE','SYNC_ENABLED','SYNC_WRITE_ENABLED'):
    if settings.get(key,'').strip().strip('"\'') != 'false': raise SystemExit('Required safety gate is not false')
value=pathlib.Path(sys.argv[2]).read_text().strip()
if len(value)<32 or not value.isalnum(): raise SystemExit('Invalid monitor token file')
lines=[line for line in text.splitlines() if not line.startswith('PRSI_MONITOR_TOKEN=')]
p.write_text('\n'.join(lines)+ '\nPRSI_MONITOR_TOKEN='+value+'\n');p.chmod(0o600)
PY
cd "$next"
npm ci --omit=dev --no-audit --no-fund
find src -name '*.js' -exec node --check '{}' \;
chown -R podorukun-si:podorukun-si "$next"
smoke_unit="prsi-monitor-smoke-$stamp"
swapped=false
rollback() {
  code=$?
  trap - EXIT
  systemctl stop "$smoke_unit" >/dev/null 2>&1 || true
  if [ "$code" -ne 0 ] && [ "$swapped" = true ]; then
    mv "$base/app" "$base/app.failed-$stamp"
    mv "$previous" "$base/app"
    systemctl restart podorukun-si-api
    recovered=false
    for attempt in $(seq 1 30); do
      if curl --silent --fail --max-time 3 http://127.0.0.1:3100/health >/dev/null; then recovered=true; break; fi
      sleep 2
    done
    test "$recovered" = true || echo 'Rollback health failed; operator intervention required' >&2
  fi
  exit "$code"
}
trap rollback EXIT
systemd-run --unit="$smoke_unit" --uid=podorukun-si --working-directory="$next" --setenv=PORT=3199 /usr/bin/node src/server.js
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3199/health >/dev/null; then healthy=true; break; fi
  sleep 2
done
test "$healthy" = true
python3 "$next/ops/monitoring/smoke-app.py" 3199 "$token"
systemctl stop "$smoke_unit"
mv "$base/app" "$previous"
if ! mv "$next" "$base/app"; then mv "$previous" "$base/app"; exit 1; fi
swapped=true
systemctl restart podorukun-si-api
healthy=false
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:3100/health >/dev/null; then healthy=true; break; fi
  sleep 2
done
test "$healthy" = true
python3 "$base/app/ops/monitoring/smoke-app.py" 3100 "$token"
curl --fail --max-time 15 https://podorukunsi.my.id/health >/dev/null
for path in /internal /internal/metrics /internal/checksum/companies; do
  test "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 15 "https://podorukunsi.my.id$path")" = 404
done
printf 'Backup: %s\nPrevious release: %s\n' "$backup" "$previous"
