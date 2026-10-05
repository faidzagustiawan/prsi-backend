#!/bin/bash
# Usage: sudo /opt/prtrack-staging/app/pilot-e2e/track.sh <A|B|C|D_out|D_in|F|cleanup|bench|bench_cleanup|inspect> [bench_n]
# Mutates ONLY the Track staging copy (guarded). Holds the same lock as the
# PRSI one-shot runner, so a mutation never overlaps a worker run.
set -euo pipefail
exec 9>/run/prsi-pilot-e2e.lock
flock -n 9 || { echo '{"failed":true,"reason":"pilot lock busy"}'; exit 3; }
PILOT_CONFIRM="$(cat /etc/prtrack-staging/instance-id)"
export PILOT_CONFIRM
export PILOT_BENCH_N="${2:-500}"
cd /opt/prtrack-staging/app
/usr/bin/node --env-file=/etc/prtrack-staging/migration.env pilot-e2e/mutate.mjs "$1"
