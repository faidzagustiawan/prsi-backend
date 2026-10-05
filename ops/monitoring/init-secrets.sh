#!/bin/sh
set -eu
umask 077
install -d -m 0700 /etc/prsi-monitoring/secrets
for name in grafana-password ntfy-password prsi-token; do
  test -s "/etc/prsi-monitoring/secrets/$name" || openssl rand -hex 32 > "/etc/prsi-monitoring/secrets/$name"
done
# Track token must be supplied by its owner. Never substitute the sync-read token.
