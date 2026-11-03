#!/usr/bin/env bash
# Run the admin CLI on the server as the service user, with the production settings.
#   sudo bash deploy/aws-ec2/admin.sh create-user <username> ADMIN "<Full Name>" <email>
#   sudo bash deploy/aws-ec2/admin.sh reset-password <username>
#   sudo bash deploy/aws-ec2/admin.sh reset-mfa <username>
#   sudo bash deploy/aws-ec2/admin.sh unlock <username>
#   sudo bash deploy/aws-ec2/admin.sh list-users
set -euo pipefail
set -a; . /etc/seaport/seaport.env; set +a
exec sudo -u seaport --preserve-env=APP_SECRET env NODE_ENV=production DB_PATH=/var/lib/seaport/seaport.db FILES_DIR=/var/lib/seaport/files \
  node --disable-warning=ExperimentalWarning /opt/seaport-platform/src/admin.ts "$@"
