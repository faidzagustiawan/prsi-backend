#!/bin/bash
# Deploy a reviewed candidate directory. Full volume backup is made separately first.
set -euo pipefail
umask 077
test "$(hostname)" = VM-20-216-ubuntu
candidate=$(realpath "${1:?candidate directory required}")
active=/opt/prsi-monitoring
test "$candidate" != "$active"
test -f "$candidate/compose.yaml"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous=/opt/prsi-monitoring.prev-$stamp
cd "$candidate"
docker compose config --quiet
docker compose run --rm --no-deps --entrypoint /bin/promtool prometheus check config /etc/prometheus/prometheus.yml
docker compose run --rm --no-deps --entrypoint /bin/amtool alertmanager check-config /etc/alertmanager/config.yml
moved=false
rollback() {
  code=$?
  if [ "$code" -ne 0 ] && [ "$moved" = true ]; then
    mv "$active" "/opt/prsi-monitoring.failed-$stamp"
    mv "$previous" "$active"
    cd "$active"
    docker compose up -d --force-recreate
    echo 'Previous monitoring configuration restored.'
  fi
  exit "$code"
}
trap rollback EXIT
mv "$active" "$previous"
if ! mv "$candidate" "$active"; then mv "$previous" "$active"; exit 1; fi
moved=true
cd "$active"
docker compose up -d --force-recreate
# A deterministic failure hook is restricted to this monitoring host, for rollback rehearsal.
if [ "${MONITOR_ROLLBACK_TEST:-false}" = true ]; then false; fi
for port in 9090 9093; do
  ready=false
  for attempt in $(seq 1 30); do
    if curl --silent --fail --max-time 2 "http://127.0.0.1:$port/-/ready" >/dev/null; then ready=true; break; fi
    sleep 1
  done
  test "$ready" = true
done
curl --silent --fail --max-time 10 http://127.0.0.1:3000/api/health >/dev/null
printf 'Previous configuration: %s\n' "$previous"
