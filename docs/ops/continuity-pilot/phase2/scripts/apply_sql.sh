#!/bin/bash
# Reviewed helper: apply ONE host migration .sql file into a disposable cf1pilot-qN container as a given role.
# usage: apply_sql.sh <cf1pilot-qN> <postgres|supabase_admin> <C:/Dev/df-u18*/src/lib/supabase/migrations/**/<file>.sql>
# The only host-to-container path the isolated pilot child has. Accepts only .sql files under a df-u18* worktree's
# src/lib/supabase/migrations tree (never docs/qa or any file the child wrote), after resolving the real path (symlinks, "..").
export MSYS_NO_PATHCONV=1
set -eu
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG BASH_ENV ENV
C=${1:?container}; U=${2:?role}; F=${3:?file}
case "$C" in cf1pilot-q[0-9]|cf1pilot-q[0-9][0-9]) ;; *) echo "refused: container must be cf1pilot-qN" >&2; exit 2;; esac
case "$U" in postgres|supabase_admin) ;; *) echo "refused: role" >&2; exit 2;; esac
case "$F" in C:/Dev/df-u18*/src/lib/supabase/migrations/*.sql) ;; *) echo "refused: only C:/Dev/df-u18*/src/lib/supabase/migrations/**.sql" >&2; exit 2;; esac
case "$F" in *..*) echo "refused: path traversal" >&2; exit 2;; esac
[ -f "$F" ] || { echo "refused: no such file" >&2; exit 2; }
D=$(cd "$(dirname "$F")" && pwd -P) || { echo "refused: cannot resolve" >&2; exit 2; }
R=$(cygpath -m "$D" 2>/dev/null || echo "$D")/$(basename "$F")
case "$R" in C:/Dev/df-u18*/src/lib/supabase/migrations/*.sql) ;; *) echo "refused: resolved path is outside the migrations tree" >&2; exit 2;; esac
case "$R" in */docs/*|*/.git/*) echo "refused: not a migration file" >&2; exit 2;; esac
sed 's/\r$//' "$F" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$U" -h localhost -d postgres -X -q -v ON_ERROR_STOP=1
