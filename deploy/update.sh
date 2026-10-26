#!/bin/bash
# Update RadCore on the server to the newest version, with a way back (technical review, 26 Oct 2026: "a
# software update can change the live database with no way back"). Run from the RadCore folder:
#   ./deploy/update.sh
# 1. A backup of the database is taken first (backups/radcore_<date>_pre-update.dump[.enc]). If it fails,
#    nothing is updated.
# 2. The new version is fetched and built, and the API starts. Any database changes in it are applied as the API
#    starts, all of them in one transaction: if one fails, none is applied and the API does not start.
# 3. The API is asked whether it is up. If it is not within two minutes, the way back is printed: the previous
#    version, and the backup from step 1.
set -euo pipefail
cd "$(dirname "$0")/.."
compose=(docker compose --env-file .env.production -f compose.prod.yml)

echo "1. Backing up the database before the update"
"${compose[@]}" exec -T backup /bin/bash /backup.sh once pre-update
backup="$(ls -1t backups/radcore_*_pre-update.dump* | head -1)"
before="$(git rev-parse --short HEAD)"

echo "2. Fetching and building the new version (now at ${before})"
git pull --ff-only
"${compose[@]}" up -d --build

echo "3. Waiting for the API"
for _ in $(seq 1 40); do
  if "${compose[@]}" exec -T api node -e "fetch('http://localhost:' + (process.env.PORT || 4000) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; then
    echo "Updated to $(git rev-parse --short HEAD). The backup taken before it: ${backup}"
    exit 0
  fi
  sleep 3
done

cat >&2 <<EOF
The API did not come up after the update. See why:
  docker compose --env-file .env.production -f compose.prod.yml logs --tail 100 api
To go back to the version before (${before}):
  git checkout ${before} && docker compose --env-file .env.production -f compose.prod.yml up -d --build
If the database was changed and must go back too, restore the backup taken just now (${backup}):
see "Restoring a backup" in README.md.
EOF
exit 1
