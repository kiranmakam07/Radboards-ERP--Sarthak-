#!/bin/bash
# Database backups. Run by the backup service (compose.prod.yml):
#   backup.sh              one compressed dump a day into /backups, those older than KEEP_DAYS removed
#   backup.sh once LABEL   one dump now and stop (deploy/update.sh takes one before every update: LABEL pre-update)
# Off-site (brief P3): with BACKUP_S3_BUCKET set, each dump and each copy of the attached files also goes
# to that S3 bucket in Mumbai (ap-south-1), stored encrypted by S3, so a lost server does not take the
# backups with it. How long copies are kept there is the bucket's own lifecycle rule (README, "Backups").
# Encrypted (technical review, 26 Oct 2026): with BACKUP_ENCRYPTION_KEY set, every dump and file copy is
# encrypted with it (AES-256, openssl) before it is written, here and off-site, so a stolen backup cannot be
# read without the key. Keep the key somewhere other than the server: without it the backups cannot be restored.
# A failed backup or copy is sent to ALERT_WEBHOOK_URL when set.
# deploy/restore-drill.sh restores the newest one each month and checks the books in it.
set -u
KEEP_DAYS="${KEEP_DAYS:-30}"

alert() {
  echo "$(date -Is) $1" >&2
  [ -n "${ALERT_WEBHOOK_URL:-}" ] || return 0
  local text="RadCore backups: $1"
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    -d "{\"text\": \"${text//\"/\'}\", \"content\": \"${text//\"/\'}\"}" "$ALERT_WEBHOOK_URL" >/dev/null || echo "$(date -Is) the alert could not be sent" >&2
}

# Encrypt a file in place when a key is set: FILE becomes FILE.enc. Prints the name of the file to keep.
seal() {
  if [ -z "${BACKUP_ENCRYPTION_KEY:-}" ]; then echo "$1"; return 0; fi
  if openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_ENCRYPTION_KEY -in "$1" -out "$1.enc.part"; then
    mv "$1.enc.part" "$1.enc" && rm -f "$1" && echo "$1.enc"
  else
    rm -f "$1.enc.part"
    return 1
  fi
}

# Copy one file to the bucket, under db/ or uploads/. A failed copy is reported; the local backup stands.
offsite() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] || return 0
  if aws s3 cp "$1" "s3://${BACKUP_S3_BUCKET}/$2/$(basename "$1")" --region "${AWS_DEFAULT_REGION:-ap-south-1}" --sse AES256 --only-show-errors; then
    echo "$(date -Is) copied off-site: s3://${BACKUP_S3_BUCKET}/$2/$(basename "$1")"
  else
    alert "OFF-SITE COPY FAILED: $1"
  fi
}

# One backup. Returns non-zero when the database dump failed.
backup_once() {
  local label="${1:-}"
  local stamp; stamp="$(date +%Y-%m-%d_%H%M)${label:+_$label}"
  local file="/backups/radcore_${stamp}.dump"
  if ! pg_dump --format=custom --file="${file}.part"; then
    rm -f "${file}.part"
    alert "BACKUP FAILED (pg_dump)"
    return 1
  fi
  mv "${file}.part" "$file"
  if ! file="$(seal "$file")"; then
    rm -f "$file"
    alert "BACKUP FAILED (could not encrypt)"
    return 1
  fi
  echo "$(date -Is) backup written: $file ($(du -h "$file" | cut -f1))"
  offsite "$file" db
  find /backups \( -name 'radcore_*.dump' -o -name 'radcore_*.dump.enc' \) -mtime "+${KEEP_DAYS}" -delete
  # The attached files (resumes, bill photos) are not in the database: copy them too. Files are only
  # ever added, so the three newest copies are enough.
  local up="/backups/uploads_${stamp}.tar.gz"
  if [ -d /uploads ] && tar -czf "${up}.part" -C /uploads .; then
    mv "${up}.part" "$up"
    if up="$(seal "$up")"; then
      offsite "$up" uploads
    else
      alert "COPY OF THE ATTACHED FILES COULD NOT BE ENCRYPTED"
    fi
    ls -1t /backups/uploads_*.tar.gz* 2>/dev/null | tail -n +4 | xargs -r rm -f
  else
    rm -f "${up}.part"
  fi
  return 0
}

if [ "${1:-}" = "once" ]; then
  backup_once "${2:-}"
  exit $?
fi
while true; do
  backup_once
  sleep 86400
done
