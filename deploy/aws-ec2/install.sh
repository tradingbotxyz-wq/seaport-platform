#!/usr/bin/env bash
# One-time setup of the Seaport platform on a fresh Ubuntu 24.04 EC2 instance.
# Run from your clone of the repository (e.g. /home/ubuntu/seaport-platform):
#   sudo bash deploy/aws-ec2/install.sh
# The clone stays the source for updates; the app runs from a copy in /opt/seaport-platform.
set -euo pipefail

APP_DIR=/opt/seaport-platform
DATA_DIR=/var/lib/seaport
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Installing Node.js 22, Python 3, nginx, sqlite3 and the AWS CLI"
apt-get update -y
apt-get install -y ca-certificates curl gnupg python3 nginx apache2-utils sqlite3 unzip rsync git
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".").map(Number).reduce((a,b,i)=>a+b*[1e6,1e3,1][i],0)')" -lt 22018000 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip
  unzip -q -o /tmp/awscli.zip -d /tmp && /tmp/aws/install --update
fi
node -v && python3 --version

echo "==> Creating service user and folders"
id seaport >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin seaport
mkdir -p "$DATA_DIR/files" "$DATA_DIR/backups"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude .git --exclude data --exclude node_modules "$SRC_DIR/" "$APP_DIR/"
chown -R seaport:seaport "$DATA_DIR" "$APP_DIR"

echo "==> Installing systemd service"
cp "$APP_DIR/deploy/aws-ec2/seaport.service" /etc/systemd/system/seaport.service
systemctl daemon-reload
systemctl enable --now seaport

echo "==> Configuring nginx"
cp "$APP_DIR/deploy/aws-ec2/nginx-seaport.conf" /etc/nginx/sites-available/seaport
ln -sf /etc/nginx/sites-available/seaport /etc/nginx/sites-enabled/seaport
rm -f /etc/nginx/sites-enabled/default
if [ ! -f /etc/nginx/seaport.htpasswd ]; then
  echo "Create the site password (username: seaport)"
  htpasswd -c /etc/nginx/seaport.htpasswd seaport
fi
nginx -t && systemctl reload nginx

echo "==> Waiting for the app"
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000/api/health >/dev/null; then echo "App is up."; break; fi
  sleep 2
done
curl -fs http://127.0.0.1:3000/api/health && echo
echo "Done. Open http://<this server's public IP or domain>/ (password: the one you just set)."
