#!/usr/bin/env bash
# Consistent online backup of the database + documents. Optionally copies to S3.
#   sudo BACKUP_BUCKET=my-seaport-backups bash /opt/seaport-platform/deploy/aws-ec2/backup.sh
# Schedule nightly with: sudo crontab -e  ->  30 1 * * * BACKUP_BUCKET=my-seaport-backups bash /opt/seaport-platform/deploy/aws-ec2/backup.sh
set -euo pipefail
DATA_DIR=/var/lib/seaport
BACKUP_DIR=/var/backups/seaport   # root-owned: the application user cannot alter or delete backups
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/$STAMP"
umask 077
mkdir -p "$OUT"
# SQLite online backup API: safe while the app is running (WAL mode).
python3 - "$DATA_DIR/seaport.db" "$OUT/seaport.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect(sys.argv[1]); dst = sqlite3.connect(sys.argv[2])
with dst: src.backup(dst)
ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
print("integrity:", ok); sys.exit(0 if ok == "ok" else 1)
PY
tar -czf "$OUT/files.tar.gz" -C "$DATA_DIR" files
echo "Backup written to $OUT"
if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws s3 cp --recursive "$OUT" "s3://$BACKUP_BUCKET/seaport/$STAMP/" --sse aws:kms
  echo "Copied to s3://$BACKUP_BUCKET/seaport/$STAMP/"
fi
# Keep 14 local backups.
ls -1d "$BACKUP_DIR"/*/ | sort | head -n -14 | xargs -r rm -rf
