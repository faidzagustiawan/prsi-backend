#!/bin/bash
# Usage: sudo /opt/prsi-pilot-e2e/e2e/prsi.sh <status|cycle|reconcile|replay|migrate> <label> [fixture_ids_csv] [replay_after_seq] [v1|v2]
# One-shot only (no service, no timer). Holds the pilot lock so no Track
# mutation can run at the same time. The read token is read here as root and
# passed through the environment only, never on a command line.
set -euo pipefail
mode="$1"; label="$2"; fixtures="${3:-}"; replay_after="${4:-}"; protocol="${5:-v2}"
[ "$(systemctl is-active prtrack-staging-api.service)" = active ] || { echo '{"failed":true,"reason":"staging api inactive"}'; exit 2; }
exec 9>/run/prsi-pilot-e2e.lock
flock -n 9 || { echo '{"failed":true,"reason":"pilot lock busy"}'; exit 3; }
TRACK_SYNC_TOKEN="$(cat /etc/prtrack-staging/read-token)"
export TRACK_SYNC_TOKEN
export TRACK_API_URL=http://127.0.0.1:3201 TRACK_SCHEDULE_TOKEN= SYNC_WRITE_ENABLED=false SYNC_ENABLED=false \
  ALLOW_UNSAFE_DB_ROLE=false NODE_ENV=development SYNC_GAP_TIMEOUT_SEC="${PILOT_GAP_TIMEOUT_SEC:-60}" \
  PILOT_LABEL="$label" PILOT_FIXTURES="$fixtures" PILOT_CONFIRM=prsi-pilot-e2e PILOT_REPLAY_AFTER_SEQ="$replay_after" SYNC_PROTOCOL="$protocol"
cd /opt/prsi-pilot-e2e
runuser -u podorukun-si -- /usr/bin/node --env-file=/opt/podorukun-si/app/.env e2e/run.mjs "$mode"
