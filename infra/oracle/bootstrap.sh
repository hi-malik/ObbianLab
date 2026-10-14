#!/bin/bash
# Run on the new Ubuntu 24.04 VM: sudo bash bootstrap.sh PUBLIC_HOSTNAME
set -euo pipefail
test "$(id -u)" = 0 || { echo 'Run with sudo'; exit 1; }
hostname=${1:?public DNS hostname required}
case "$hostname" in *[!a-z0-9.-]*|'') echo 'Invalid hostname'; exit 1;; esac
. /etc/os-release
test "$ID" = ubuntu || { echo 'Ubuntu is required'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git python3 python3-yaml
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
if test ! -d /opt/obbianlab/.git; then
    git clone https://github.com/hi-malik/ObbianLab.git /opt/obbianlab
fi
cd /opt/obbianlab
python3 scripts/prepare-oracle.py --hostname "$hostname"
COMPOSE_PARALLEL_LIMIT=1 docker compose -f .deploy/compose.yaml up --build -d --wait --wait-timeout 300
docker compose -f .deploy/compose.yaml ps
echo 'Deployment started. Verify public HTTPS before sharing. Customer token: /opt/obbianlab/.deploy/customer-access-token.txt'
