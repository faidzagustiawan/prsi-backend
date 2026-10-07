#!/bin/sh
set -eu
# Run only on the monitoring host. No existing engine is removed automatically.
test "$(hostname)" = VM-20-216-ubuntu
if command -v docker >/dev/null 2>&1; then docker version; exit 0; fi
for package in docker.io containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
    echo 'Conflicting runtime installed; inspect before proceeding.' >&2; exit 1
  fi
done
apt-get update -qq
apt-get install -y ca-certificates curl
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nArchitectures: %s\nSigned-By: /etc/apt/keyrings/docker.asc\n' "$VERSION_CODENAME" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
apt-get update -qq
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker version --format '{{.Server.Version}}'
docker compose version
