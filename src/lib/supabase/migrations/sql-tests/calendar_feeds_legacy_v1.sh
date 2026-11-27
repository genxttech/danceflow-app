#!/usr/bin/env bash
# Legacy instructor-token migration (20270223120000) -- SQL suite on a DISPOSABLE Postgres.
# HEAVY JOB (docker): take C:\dfr\heavy.lock first (see C:\dfr\HEAVY_LOCK_RULES.md); this script does not take it for you.
#
# Usage: bash src/lib/supabase/migrations/sql-tests/calendar_feeds_legacy_v1.sh
# The v1 token migration is read from the working tree; if absent it is read from git ref CF_V1_REF (default
# origin/claude/calendar-feeds-pr1-tokens) so this suite can run before that migration has merged.
set -uo pipefail
export MSYS_NO_PATHCONV=1  # Git Bash must not rewrite /tmp paths passed to docker
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../../../../.." && pwd -W 2>/dev/null || pwd)"
V1_REL="src/lib/supabase/migrations/20270223090000_calendar_feeds_tokens_v1.sql"
MIG="$DIR/../20270223120000_calendar_feeds_legacy_instructor_tokens_v1.sql"
RB="$DIR/../rollback/20270223120000_calendar_feeds_legacy_instructor_tokens_v1_rollback.sql"
TESTS="$DIR/calendar_feeds_legacy_v1.sql"
NAME=${CF_QA_CONTAINER:-df-cf-legacy-qa-pg}
IMAGE=${CF_QA_IMAGE:-postgres:17}
TMP="$(mktemp -d)"
cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ -f "$ROOT/$V1_REL" ]; then cp "$ROOT/$V1_REL" "$TMP/v1.sql"; else git -C "$ROOT" show "${CF_V1_REF:-origin/claude/calendar-feeds-pr1-tokens}:$V1_REL" > "$TMP/v1.sql" || { echo "cannot read v1 migration" >&2; exit 2; }; fi
for f in "$TMP/v1.sql" "$MIG" "$RB" "$TESTS"; do
  [ -s "$f" ] || { echo "missing $f" >&2; exit 2; }
  if [ "$(tr -cd '\r' < "$f" | wc -c)" -ne 0 ]; then echo "CR line endings in $f" >&2; exit 2; fi
done

cleanup; TMP="$(mktemp -d)"
if [ -f "$ROOT/$V1_REL" ]; then cp "$ROOT/$V1_REL" "$TMP/v1.sql"; else git -C "$ROOT" show "${CF_V1_REF:-origin/claude/calendar-feeds-pr1-tokens}:$V1_REL" > "$TMP/v1.sql"; fi
docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=x "$IMAGE" >/dev/null || { echo "docker run failed" >&2; exit 2; }
psql_in() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
for i in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 6

psql_in <<'SQL' || { echo "stub setup failed" >&2; exit 2; }
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
create table public.studios (id uuid primary key);
create table public.instructors (id uuid primary key, studio_id uuid not null references public.studios(id), user_id uuid, active boolean not null default true);
create table public.user_studio_roles (user_id uuid not null, studio_id uuid not null, active boolean not null default true, role text not null);
create table public.instructor_calendar_feeds (id uuid primary key default gen_random_uuid(), studio_id uuid not null references public.studios(id), instructor_id uuid not null references public.instructors(id), token text not null unique, active boolean not null default true);
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
SQL

fail=0
# Everything goes through stdin: no docker cp and no container paths (Git Bash path rewriting breaks those).
awk -v mig="$MIG" '$0 == "\\i :migration" { while ((getline line < mig) > 0) print line; close(mig); next } { print }' "$TESTS" > "$TMP/combined.sql"
echo "== apply v1"; psql_in < "$TMP/v1.sql" || fail=1
echo "== checks"
out=$(psql_in < "$TMP/combined.sql" 2>&1); rc=$?
echo "$out" | grep -E "PASS|FAIL|ERROR|ALL LEGACY" | sed 's/^psql:.*NOTICE: *//'
[ $rc -eq 0 ] || fail=1
echo "$out" | grep -q "ALL LEGACY MIGRATION SQL CHECKS PASSED" || fail=1
echo "PASS count: $(echo "$out" | grep -c 'PASS:')"
echo "== rollback"
psql_in < "$RB" || fail=1
left=$(psql_in -At -c "select count(*) from public.calendar_feed_tokens where legacy_source='instructor_feed'")
echo "legacy rows after rollback: $left"
[ "$left" = "0" ] || fail=1
if [ $fail -eq 0 ]; then echo "RESULT: ALL PASSED"; exit 0; fi
echo "RESULT: FAILED" >&2; exit 1
