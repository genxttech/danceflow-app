#!/usr/bin/env bash
# Portal / Multi-Studio Test Harness -- SQL regression runner (H1).
#
# Runs every test_T_*.sql file against the local Docker Supabase Postgres
# container this repo's regression suites already use elsewhere
# (supabase_db_danceflow-local-staging). Each file wraps its own work in
# BEGIN/ROLLBACK, so this runner performs no cleanup of its own.
#
# The SQL files themselves live OUTSIDE this repo, on the developer's own
# machine, matching this project's established convention for local-only
# regression artifacts (see e2e/README.md and the Package Refund SQL
# regression suite for the same pattern) -- they must never be committed
# here, and this script must never hardcode a developer-specific absolute
# path. Instead, the directory is supplied via PORTAL_LINKAGE_SQL_DIR.
#
# Usage:
#   PORTAL_LINKAGE_SQL_DIR=/path/to/your/local-staging/dir \
#     npm run test:portal-linkage:sql

set -euo pipefail

CONTAINER="supabase_db_danceflow-local-staging"

if [ -z "${PORTAL_LINKAGE_SQL_DIR:-}" ]; then
  echo "PORTAL_LINKAGE_SQL_DIR is not set." >&2
  echo "Set it to the local directory containing test_T_*.sql (this repo intentionally does not hardcode a developer-specific path here)." >&2
  echo "Example (Git Bash / macOS / Linux):" >&2
  echo "  PORTAL_LINKAGE_SQL_DIR=/c/Dev/danceflow-local-staging npm run test:portal-linkage:sql" >&2
  exit 1
fi

if [ ! -d "$PORTAL_LINKAGE_SQL_DIR" ]; then
  echo "PORTAL_LINKAGE_SQL_DIR ($PORTAL_LINKAGE_SQL_DIR) does not exist or is not a directory." >&2
  exit 1
fi

if ! docker ps --filter "name=${CONTAINER}" --format '{{.Names}}' | grep -q "^${CONTAINER}\$"; then
  echo "Local Docker Supabase container '${CONTAINER}' is not running." >&2
  echo "Start your local Docker Supabase staging environment before running this suite." >&2
  exit 1
fi

shopt -s nullglob
files=("$PORTAL_LINKAGE_SQL_DIR"/test_T_*.sql)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "No test_T_*.sql files found in $PORTAL_LINKAGE_SQL_DIR." >&2
  exit 1
fi

status=0
for f in "${files[@]}"; do
  echo "=== Running $(basename "$f") ==="
  if ! docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f"; then
    echo "FAILED: $(basename "$f")" >&2
    status=1
  fi
done

exit $status
