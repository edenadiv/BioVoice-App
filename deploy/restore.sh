#!/usr/bin/env bash
# F7.8 — restore script.
#
# Restores a backup.sh tarball over the current data directory. STOP THE
# BACKEND BEFORE RUNNING THIS — overwriting the SQLite file while
# uvicorn is connected to it will corrupt both copies.
#
# Usage:
#   docker compose stop backend
#   ./deploy/restore.sh /var/backups/biovoice/biovoice-20260509T030000Z.tar.gz
#   docker compose start backend

set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <backup.tar.gz>" >&2
    exit 1
fi

ARCHIVE="$1"
DATA_DIR="${DATA_DIR:-/app/data}"

if [ ! -f "$ARCHIVE" ]; then
    echo "restore: $ARCHIVE does not exist" >&2
    exit 1
fi

# Sanity check: ensure the backup contains the expected SQLite file
# before we touch the live data dir.
TMPDIR="$(mktemp -d)"
tar -xzf "$ARCHIVE" -C "$TMPDIR"
if [ ! -f "$TMPDIR/biovoice.sqlite3" ]; then
    echo "restore: archive is missing biovoice.sqlite3" >&2
    rm -rf "$TMPDIR"
    exit 1
fi

# Move the existing data dir aside (don't delete — operator can roll back).
if [ -d "$DATA_DIR" ]; then
    BACKUP_OF_BACKUP="${DATA_DIR}.pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$DATA_DIR" "$BACKUP_OF_BACKUP"
    echo "restore: moved existing data → $BACKUP_OF_BACKUP"
fi

mkdir -p "$DATA_DIR"
cp -a "$TMPDIR/biovoice.sqlite3" "$DATA_DIR/"
if [ -d "$TMPDIR/reference_samples" ]; then
    cp -a "$TMPDIR/reference_samples" "$DATA_DIR/"
fi
rm -rf "$TMPDIR"

echo "restore: $ARCHIVE → $DATA_DIR"
echo "restore: remember to start the backend now"
