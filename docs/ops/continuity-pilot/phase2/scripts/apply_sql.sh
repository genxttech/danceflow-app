#!/bin/bash
# Reviewed helper: apply ONE host .sql file into a disposable cf1pilot-qN container as a given role.
# usage: apply_sql.sh <cf1pilot-qN> <postgres|supabase_admin> <C:/Dev/<worktree>/.../file.sql>
# The only host-to-container path the isolated pilot child has. Refuses anything but a .sql file under C:/Dev/<dir>/ and any ".." segment.
set -eu
C=${1:?container}; U=${2:?role}; F=${3:?file}
case "$C" in cf1pilot-q[0-9]*) ;; *) echo "refused: container must be cf1pilot-qN" >&2; exit 2;; esac
case "$U" in postgres|supabase_admin) ;; *) echo "refused: role" >&2; exit 2;; esac
case "$F" in C:/Dev/*/*.sql) ;; *) echo "refused: file must be a .sql under C:/Dev/<dir>/" >&2; exit 2;; esac
case "$F" in *..*) echo "refused: path traversal" >&2; exit 2;; esac
[ -f "$F" ] || { echo "refused: no such file" >&2; exit 2; }
sed 's/\r$//' "$F" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$U" -h localhost -d postgres -q -v ON_ERROR_STOP=1
