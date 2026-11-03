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
apt-get install -y ca-certificates curl gnupg openssl python3 nginx sqlite3 unzip rsync git
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".").map(Number).reduce((a,b,i)=>a+b*[1e6,1e3,1][i],0)')" -lt 22018000 ]; then
  # NodeSource apt repository with its signing key (no remote script piped into a root shell).
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
apt-get install -y unattended-upgrades
if ! command -v aws >/dev/null; then
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip
  unzip -q -o /tmp/awscli.zip -d /tmp && /tmp/aws/install --update
fi
node -v && python3 --version

echo "==> Creating service user and folders"
id seaport >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin seaport
mkdir -p "$DATA_DIR/files"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude .git --exclude data --exclude node_modules "$SRC_DIR/" "$APP_DIR/"
chown -R seaport:seaport "$DATA_DIR" "$APP_DIR"

echo "==> Application secret (root-only)"
install -d -m 0700 /etc/seaport
if [ ! -f /etc/seaport/seaport.env ]; then
  umask 077
  echo "APP_SECRET=$(openssl rand -hex 32)" > /etc/seaport/seaport.env
  echo "Created /etc/seaport/seaport.env. Back it up securely (e.g. AWS Secrets Manager): without it, MFA secrets cannot be read."
fi
chmod 600 /etc/seaport/seaport.env

echo "==> Installing systemd service"
cp "$APP_DIR/deploy/aws-ec2/seaport.service" /etc/systemd/system/seaport.service
systemctl daemon-reload
systemctl enable --now seaport

echo "==> Configuring nginx"
cp "$APP_DIR/deploy/aws-ec2/nginx-seaport.conf" /etc/nginx/sites-available/seaport
cp "$APP_DIR/deploy/aws-ec2/nginx-proxy.conf" /etc/nginx/seaport-proxy.conf
ln -sf /etc/nginx/sites-available/seaport /etc/nginx/sites-enabled/seaport
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "==> Waiting for the app"
for i in $(seq 1 30); do
  if curl -fs http://127.0.0.1:3000/api/health >/dev/null; then echo "App is up."; break; fi
  sleep 2
done
curl -fs http://127.0.0.1:3000/api/health && echo
echo
echo "Done. Next:"
echo "  1. Point DNS at this server and run: sudo certbot --nginx -d <your domain>   (sign-in needs HTTPS)"
echo "  2. Create the first administrator:  sudo bash deploy/aws-ec2/admin.sh create-user <username> ADMIN \"<Full Name>\" <email>"
echo "  3. Sign in at https://<your domain>/ with the one-time password, choose a password and set up MFA."

