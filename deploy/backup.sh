#!/bin/bash
# Daily database backup. One compressed dump per day into /backups, older than KEEP_DAYS removed.
# Off-site (brief P3): with BACKUP_S3_BUCKET set, each dump and each copy of the attached files also goes
# to that S3 bucket in Mumbai (ap-south-1), so a lost server does not take the backups with it. How long
# copies are kept there is the bucket's own lifecycle rule (see "Backups" in README.md).
# deploy/restore-drill.sh restores the newest one each month and checks the books in it.
set -u
KEEP_DAYS="${KEEP_DAYS:-30}"

# Copy one file to the bucket, under db/ or uploads/. A failed copy is logged loudly; the local backup stands.
offsite() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] || return 0
  if aws s3 cp "$1" "s3://${BACKUP_S3_BUCKET}/$2/$(basename "$1")" --region "${AWS_DEFAULT_REGION:-ap-south-1}" --only-show-errors; then
    echo "$(date -Is) copied off-site: s3://${BACKUP_S3_BUCKET}/$2/$(basename "$1")"
  else
    echo "$(date -Is) OFF-SITE COPY FAILED: $1" >&2
  fi
}
while true; do
  stamp="$(date +%Y-%m-%d_%H%M)"
  file="/backups/radcore_${stamp}.dump"
  if pg_dump --format=custom --file="${file}.part"; then
    mv "${file}.part" "$file"
    echo "$(date -Is) backup written: $file ($(du -h "$file" | cut -f1))"
    offsite "$file" db
    find /backups -name 'radcore_*.dump' -mtime "+${KEEP_DAYS}" -delete
    # The attached files (resumes, bill photos) are not in the database: copy them too. Files are only
    # ever added, so the three newest copies are enough.
    if [ -d /uploads ] && tar -czf "/backups/uploads_${stamp}.tar.gz.part" -C /uploads .; then
      mv "/backups/uploads_${stamp}.tar.gz.part" "/backups/uploads_${stamp}.tar.gz"
      offsite "/backups/uploads_${stamp}.tar.gz" uploads
      ls -1t /backups/uploads_*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
    else
      rm -f "/backups/uploads_${stamp}.tar.gz.part"
    fi
  else
    rm -f "${file}.part"
    echo "$(date -Is) BACKUP FAILED" >&2
  fi
  sleep 86400
done
