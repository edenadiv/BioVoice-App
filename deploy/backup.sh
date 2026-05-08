#!/usr/bin/env bash
# F7.8 — backup script.
#
# Snapshots the SQLite database + the reference-samples directory + the
# audit log into a single tar.gz under $BACKUP_DIR.
#
# Usage:
#   BACKUP_DIR=/var/backups/biovoice ./deploy/backup.sh
#
# Cron suggestion (daily at 02:30 UTC):
#   30 2 * * * /opt/biovoice/deploy/backup.sh
#
# F7.1 follow-up: when the Postgres path lands, swap the SQLite copy for
# `pg_dump --format=custom` and check $DATABASE_URL to choose between
# them. Until then, SQLite is the only persistent store.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/biovoice}"
DATA_DIR="${DATA_DIR:-/app/data}"
DB_FILE="${DB_FILE:-${DATA_DIR}/biovoice.sqlite3}"
REFS_DIR="${REFS_DIR:-${DATA_DIR}/reference_samples}"

if [ ! -f "$DB_FILE" ]; then
    echo "backup: $DB_FILE not found" >&2
    exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/biovoice-$TS.tar.gz"
WORKDIR="$(mktemp -d)"

# SQLite online backup — atomic + safe with WAL active.
sqlite3 "$DB_FILE" ".backup '$WORKDIR/biovoice.sqlite3'"

# Reference samples directory.
if [ -d "$REFS_DIR" ]; then
    cp -a "$REFS_DIR" "$WORKDIR/reference_samples"
fi

tar -czf "$TARGET" -C "$WORKDIR" .
rm -rf "$WORKDIR"

# Retention — keep the most recent 30 backups.
ls -1t "$BACKUP_DIR"/biovoice-*.tar.gz | tail -n +31 | xargs -r rm

echo "backup: wrote $TARGET ($(du -h "$TARGET" | cut -f1))"
