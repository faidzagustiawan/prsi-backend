#!/bin/sh
set -eu
umask 077
test "$(hostname)" = VM-20-216-ubuntu
cd /opt/prsi-monitoring
destination=/var/backups/prsi-monitoring/$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 0700 "$destination"
trap 'docker compose start >/dev/null' EXIT
docker compose stop
tar -czf "$destination/config-secrets.tgz" /opt/prsi-monitoring /etc/prsi-monitoring 2>/dev/null
for volume in prometheus alertmanager grafana ntfy caddy-data caddy-config checker-state; do
  docker volume inspect "prsi-monitoring_$volume" >/dev/null 2>&1 || continue
  mount=$(docker volume inspect "prsi-monitoring_$volume" --format '{{.Mountpoint}}')
  test -d "$mount"
  tar -C "$mount" -czf "$destination/$volume.tgz" .
done
for archive in "$destination"/*.tgz; do tar -tzf "$archive" >/dev/null; done
sha256sum "$destination"/*.tgz > "$destination/SHA256SUMS"
printf '%s\n' "$destination"
