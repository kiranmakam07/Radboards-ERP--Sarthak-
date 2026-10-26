#!/bin/bash
# Least privilege (brief P3): the login the API runs as. It can read and write rows, and nothing else:
# no CREATE, ALTER or DROP. Migrations run as the database owner (POSTGRES_USER, MIGRATION_DATABASE_URL).
#
# Runs by itself the first time the database starts (it is mounted into /docker-entrypoint-initdb.d).
# On a database that already exists, run it once by hand:
#   docker compose --env-file .env.production -f compose.prod.yml exec db bash /docker-entrypoint-initdb.d/20-app-user.sh
# It is safe to run again: it only sets what is missing, and resets the password to APP_DB_PASSWORD.
set -euo pipefail
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env.production}"
OWNER="${POSTGRES_USER:-radcore}"
DB="${POSTGRES_DB:-radcore}"
APP="${APP_DB_USER:-radcore_app}"

psql -v ON_ERROR_STOP=1 --username "$OWNER" --dbname "$DB" \
  -v app="$APP" -v owner="$OWNER" -v db="$DB" -v pw="$APP_DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'app') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app') \gexec
ALTER ROLE :"app" WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD :'pw';
GRANT CONNECT ON DATABASE :"db" TO :"app";
-- Nobody but the owner creates objects in the schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app";
-- Rows: read and write. The ledgers are append-only anyway (their triggers refuse UPDATE and DELETE).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"app";
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO :"app";
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO :"app";
-- And the same on every table, sequence and function the owner's migrations create from now on.
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO :"app";
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO :"app";
SQL
echo "Database login $APP is ready: rows only, no CREATE, ALTER or DROP."
