#!/bin/bash
# Monthly restore drill (brief P3): restore the newest backup into a scratch database and check that the
# books in it are sound (the same check as Books & reports > Integrity). A backup that cannot be restored
# is found out now, not on the day it is needed. Run on the server, from the RadCore folder:
#   ./deploy/restore-drill.sh            the newest backup in ./backups
#   ./deploy/restore-drill.sh --from-s3  the newest copy in the off-site bucket instead
# Monthly, from cron (first day of the month at 03:30):
#   30 3 1 * * cd /opt/radcore && ./deploy/restore-drill.sh >> backups/restore-drill.log 2>&1
# An encrypted backup (BACKUP_ENCRYPTION_KEY, see deploy/backup.sh) is decrypted into a scratch file first,
# which also proves the key still opens it. Exits non-zero (and says why) when the restore or the check
# fails, and sends that to ALERT_WEBHOOK_URL when set.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --env-file .env.production -f compose.prod.yml)
set -a; . ./.env.production; set +a
SCRATCH=radcore_drill

alert() {
  echo "$(date -Is) $1" >&2
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "{\"text\": \"RadCore: $1\", \"content\": \"RadCore: $1\"}" "$ALERT_WEBHOOK_URL" >/dev/null || true
}
trap 'alert "RESTORE DRILL FAILED (line $LINENO). The newest backup could not be restored and checked."' ERR
echo "$(date -Is) restore drill starting"

if [ "${1:-}" = "--from-s3" ]; then
  : "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is not set}"
  key="$("${compose[@]}" run --rm --no-deps -T --entrypoint aws backup s3 ls "s3://${BACKUP_S3_BUCKET}/db/" | sort | tail -1 | awk '{print $4}')"
  [ -n "$key" ] || { alert "RESTORE DRILL: no backup found in s3://${BACKUP_S3_BUCKET}/db/"; exit 1; }
  "${compose[@]}" run --rm --no-deps -T --entrypoint aws backup s3 cp "s3://${BACKUP_S3_BUCKET}/db/${key}" "/backups/${key}" --only-show-errors
  dump="backups/${key}"
else
  dump="$(ls -1t backups/radcore_*.dump backups/radcore_*.dump.enc 2>/dev/null | head -1 || true)"
  [ -n "$dump" ] || { alert "RESTORE DRILL: no backup found in ./backups"; exit 1; }
fi

plain="$dump"
if [[ "$dump" == *.enc ]]; then
  : "${BACKUP_ENCRYPTION_KEY:?the backup is encrypted and BACKUP_ENCRYPTION_KEY is not set}"
  plain="backups/drill-decrypted.dump"
  "${compose[@]}" run --rm --no-deps -T --entrypoint openssl backup enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
    -pass env:BACKUP_ENCRYPTION_KEY -in "/backups/$(basename "$dump")" -out "/backups/$(basename "$plain")"
fi
echo "Restoring $dump into $SCRATCH"

"${compose[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U radcore -d radcore -c "DROP DATABASE IF EXISTS ${SCRATCH}" -c "CREATE DATABASE ${SCRATCH}"
trap '"${compose[@]}" exec -T db psql -U radcore -d radcore -c "DROP DATABASE IF EXISTS '"${SCRATCH}"'" >/dev/null; rm -f backups/drill-decrypted.dump' EXIT
"${compose[@]}" exec -T db pg_restore --exit-on-error --no-owner -U radcore -d "$SCRATCH" < "$plain"

# The books check, run by the API's own code against the scratch copy (src/integrity-cli.ts).
"${compose[@]}" run --rm --no-deps -T api npm run integrity -w @radcore/api -- "postgres://radcore:${POSTGRES_PASSWORD}@db:5432/${SCRATCH}"
echo "$(date -Is) restore drill passed: $dump restores, and its books are sound"
