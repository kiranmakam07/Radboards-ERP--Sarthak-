#!/bin/bash
# Monthly restore drill (brief P3): restore the newest backup into a scratch database and check that the
# books in it are sound (the same check as Books & reports > Integrity). A backup that cannot be restored
# is found out now, not on the day it is needed. Run on the server, from the RadCore folder:
#   ./deploy/restore-drill.sh            the newest backup in ./backups
#   ./deploy/restore-drill.sh --from-s3  the newest copy in the off-site bucket instead
# Monthly, from cron (first day of the month at 03:30):
#   30 3 1 * * cd /opt/radcore && ./deploy/restore-drill.sh >> backups/restore-drill.log 2>&1
# Exits non-zero (and says why) when the restore or the check fails.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --env-file .env.production -f compose.prod.yml)
set -a; . ./.env.production; set +a
SCRATCH=radcore_drill
echo "$(date -Is) restore drill starting"

if [ "${1:-}" = "--from-s3" ]; then
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is not set}"
  key="$("${compose[@]}" run --rm --no-deps -T --entrypoint aws backup s3 ls "s3://${BACKUP_S3_BUCKET}/db/" | sort | tail -1 | awk '{print $4}')"
  [ -n "$key" ] || { echo "No backup found in s3://${BACKUP_S3_BUCKET}/db/"; exit 1; }
  "${compose[@]}" run --rm --no-deps -T --entrypoint aws backup s3 cp "s3://${BACKUP_S3_BUCKET}/db/${key}" "/backups/${key}" --only-show-errors
  dump="backups/${key}"
else
  dump="$(ls -1t backups/radcore_*.dump 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || { echo "No backup found in ./backups"; exit 1; }
fi
echo "Restoring $dump into $SCRATCH"

"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U radcore -d radcore -c "DROP DATABASE IF EXISTS ${SCRATCH}" -c "CREATE DATABASE ${SCRATCH}"
trap '"${compose[@]}" exec -T db psql -U radcore -d radcore -c "DROP DATABASE IF EXISTS '"${SCRATCH}"'" >/dev/null' EXIT
"${compose[@]}" exec -T db pg_restore --exit-on-error --no-owner -U radcore -d "$SCRATCH" < "$dump"

# The books check, run by the API's own code against the scratch copy (src/integrity-cli.ts).
"${compose[@]}" run --rm --no-deps -T api npm run integrity -w @radcore/api -- "postgres://radcore:${POSTGRES_PASSWORD}@db:5432/${SCRATCH}"
echo "$(date -Is) restore drill passed: $dump restores, and its books are sound"
