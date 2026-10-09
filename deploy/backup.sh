#!/bin/bash
# Daily database backup. One compressed dump per day into /backups, older than KEEP_DAYS removed.
# These files sit on the same server as the database: also copy the backups folder off the
# server (provider snapshot or object storage), or a disk failure takes both.
set -u
KEEP_DAYS="${KEEP_DAYS:-30}"
while true; do
  stamp="$(date +%Y-%m-%d_%H%M)"
  file="/backups/radcore_${stamp}.dump"
  if pg_dump --format=custom --file="${file}.part"; then
    mv "${file}.part" "$file"
    echo "$(date -Is) backup written: $file ($(du -h "$file" | cut -f1))"
    find /backups -name 'radcore_*.dump' -mtime "+${KEEP_DAYS}" -delete
  else
    rm -f "${file}.part"
    echo "$(date -Is) BACKUP FAILED" >&2
  fi
  sleep 86400
done
