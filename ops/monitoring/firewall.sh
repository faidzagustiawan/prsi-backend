#!/bin/sh
set -eu
test "$(hostname)" = VM-20-216-ubuntu
# Host networking is intentional: Docker-published ports bypass UFW.
# No compose service publishes ports through Docker NAT.
ufw allow 22/tcp comment 'SSH recovery'
ufw default deny incoming
ufw default allow outgoing
tmp=$(mktemp -d)
trap 'rm -f "$tmp/v4" "$tmp/v6"; rmdir "$tmp"' EXIT
curl -fsSL https://www.cloudflare.com/ips-v4/ > "$tmp/v4"
curl -fsSL https://www.cloudflare.com/ips-v6/ > "$tmp/v6"
test "$(wc -l < "$tmp/v4")" -ge 10
test "$(wc -l < "$tmp/v6")" -ge 5
while read -r network || test -n "$network"; do
  ufw allow proto tcp from "$network" to any port 80,443 comment 'Cloudflare origin'
done < "$tmp/v4"
while read -r network || test -n "$network"; do
  ufw allow proto tcp from "$network" to any port 80,443 comment 'Cloudflare origin'
done < "$tmp/v6"
for port in 80 443 8090; do
  ufw --force delete allow "$port/tcp"
done
# Caller verifies a SECOND SSH connection before invoking ufw --force enable.
# First schedule rollback: systemd-run --unit=prsi-ufw-recovery --on-active=180 /usr/sbin/ufw disable
# After enabling, verify a new SSH connection then stop prsi-ufw-recovery.timer.
