#!/bin/bash
# Root-only daily finance/config/attachment backup. No credentials in argv.
set -euo pipefail
umask 077
test "$(hostname)" = VM-26-196-ubuntu
root=/var/backups/podorukun-si/daily
install -d -m 0700 "$root"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$root/$stamp"
install -d -m 0700 "$dest"
python3 /opt/prsi-backup/backup-finance.py /opt/podorukun-si/app/.env "$dest/finance.dump"
tar -czf "$dest/files.tgz" -C / opt/podorukun-si/app/.env opt/prsi-backup etc/nginx etc/systemd/system/podorukun-si-api.service etc/systemd/system/prsi-backup.service etc/systemd/system/prsi-backup.timer etc/systemd/system/prsi-ops-firewall.service var/lib/podorukun-si/lampiran
tar -tzf "$dest/files.tgz" >/dev/null
(cd "$dest" && sha256sum finance.dump files.tgz > SHA256SUMS && sha256sum --check --status SHA256SUMS)
touch "$dest/COMPLETE"
install -d -o root -g podorukun-si -m 0750 /var/lib/prsi-monitoring
date +%s > /var/lib/prsi-monitoring/backup.timestamp.next
chown root:podorukun-si /var/lib/prsi-monitoring/backup.timestamp.next
chmod 0640 /var/lib/prsi-monitoring/backup.timestamp.next
mv /var/lib/prsi-monitoring/backup.timestamp.next /var/lib/prsi-monitoring/backup.timestamp
# Retention runs only after successful validation. Never follow symlinks.
find "$root" -mindepth 1 -maxdepth 1 -type d -name '20??????T??????Z' -mmin +10080 -exec rm -rf -- '{}' +
printf 'Daily backup verified: %s\n' "$dest"
