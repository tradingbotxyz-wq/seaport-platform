#!/usr/bin/env bash
# Deploy the latest code from GitHub. Run from your clone on the server:
#   sudo bash deploy/aws-ec2/update.sh
set -euo pipefail
APP_DIR=/opt/seaport-platform
SRC_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
OWNER="${SUDO_USER:-$(stat -c %U "$SRC_DIR")}"

bash "$SRC_DIR/deploy/aws-ec2/backup.sh" || echo "WARNING: backup failed - continuing"
sudo -u "$OWNER" git -C "$SRC_DIR" pull --ff-only
rsync -a --delete --exclude .git --exclude data --exclude node_modules "$SRC_DIR/" "$APP_DIR/"
chown -R seaport:seaport "$APP_DIR"
cp "$APP_DIR/deploy/aws-ec2/seaport.service" /etc/systemd/system/seaport.service
systemctl daemon-reload
systemctl restart seaport     # database migrations run automatically on start
for i in $(seq 1 30); do curl -fs http://127.0.0.1:3000/api/health >/dev/null && break; sleep 2; done
curl -fs http://127.0.0.1:3000/api/health && echo " - deployed $(git -C "$SRC_DIR" rev-parse --short HEAD)"
