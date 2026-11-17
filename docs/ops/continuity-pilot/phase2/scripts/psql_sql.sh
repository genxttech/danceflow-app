#!/bin/bash
# Reviewed helper: run ONE SQL command inside a disposable cf1pilot-qN container as a given role. The isolated pilot child has no
# direct psql access: this script is its only SQL path, and it refuses what a `psql -c` string could abuse.
# usage: psql_sql.sh <cf1pilot-qN> <postgres|supabase_admin> "<one SQL command>"
# Refused: any backslash (psql meta-commands such as \! \o \i \copy), COPY ... PROGRAM, server-side file and large-object functions,
# dblink/fdw, anything over 4000 characters, extra arguments. The container has no network (see run_u18s2.sh).
export MSYS_NO_PATHCONV=1
set -eu
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG BASH_ENV ENV
[ "$#" -eq 3 ] || { echo "refused: usage psql_sql.sh <cf1pilot-qN> <role> <sql>" >&2; exit 2; }
C=$1; U=$2; SQL=$3
case "$C" in cf1pilot-q[0-9]|cf1pilot-q[0-9][0-9]) ;; *) echo "refused: container must be cf1pilot-qN" >&2; exit 2;; esac
case "$U" in postgres|supabase_admin) ;; *) echo "refused: role" >&2; exit 2;; esac
[ -n "$SQL" ] || { echo "refused: empty SQL" >&2; exit 2; }
[ "${#SQL}" -le 4000 ] || { echo "refused: SQL too long" >&2; exit 2; }
case "$SQL" in *\\*) echo "refused: backslash (psql meta-command) not allowed" >&2; exit 2;; esac
LOWER=$(printf '%s' "$SQL" | tr 'A-Z' 'a-z')
case "$LOWER" in
  *program*|*pg_read_file*|*pg_read_binary_file*|*pg_ls_dir*|*pg_stat_file*|*lo_import*|*lo_export*|*dblink*|*postgres_fdw*|*pg_execute_server_program*)
    echo "refused: server-side program/file/network feature" >&2; exit 2;;
esac
exec docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$U" -h localhost -d postgres -X -v ON_ERROR_STOP=1 -c "$SQL"
