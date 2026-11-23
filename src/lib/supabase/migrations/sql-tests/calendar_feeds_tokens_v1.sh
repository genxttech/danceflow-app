#!/usr/bin/env bash
# Calendar feeds v1 -- SQL suite on a DISPOSABLE Postgres (never a hosted database, never a shared QA stack).
#
# Starts ONE throwaway container (default name df-cf-feeds-qa-pg: no published ports, anonymous volume removed on exit),
# reconstructs only the base objects the migration references (auth.users, studios, instructors, user_studio_roles and the
# Supabase roles with Supabase's default table/function grants), applies the migration, runs the checks, proves the
# rollback removes everything and that the migration re-applies cleanly (idempotent), then removes the container.
#
# Usage: bash src/lib/supabase/migrations/sql-tests/calendar_feeds_tokens_v1.sh
# Env:   CF_QA_CONTAINER (default df-cf-feeds-qa-pg), CF_QA_IMAGE (default postgres:17)
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG="$DIR/../20270223090000_calendar_feeds_tokens_v1.sql"
RB="$DIR/../rollback/20270223090000_calendar_feeds_tokens_v1_rollback.sql"
TESTS="$DIR/calendar_feeds_tokens_v1.sql"
NAME=${CF_QA_CONTAINER:-df-cf-feeds-qa-pg}
IMAGE=${CF_QA_IMAGE:-postgres:17}

for f in "$MIG" "$RB" "$TESTS"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }
  if [ "$(tr -cd '\r' < "$f" | wc -c)" -ne 0 ]; then echo "CR line endings in $f" >&2; exit 2; fi
done

cleanup() { docker rm -fv "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
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
-- Supabase default privileges: new public objects are open to the API roles until the migration revokes them
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to service_role;
SQL

fail=0
echo "== apply migration"; psql_in < "$MIG" || fail=1
echo "== apply migration again (idempotency)"; psql_in < "$MIG" || fail=1
echo "== checks"
out=$(psql_in < "$TESTS" 2>&1); rc=$?
echo "$out" | grep -E "PASS|FAIL|ERROR|ALL CALENDAR" | sed 's/^psql:.*NOTICE: *//'
[ $rc -eq 0 ] || fail=1
echo "$out" | grep -q "ALL CALENDAR FEED SQL CHECKS PASSED" || fail=1
pass=$(echo "$out" | grep -c "PASS:")
echo "PASS count: $pass"

echo "== rollback"
psql_in < "$RB" || fail=1
left=$(psql_in -At -c "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'calendar_feed_%'" )
tabs=$(psql_in -At -c "select count(*) from pg_tables where schemaname='public' and tablename like 'calendar_feed_%'")
trg=$(psql_in -At -c "select count(*) from pg_trigger where tgname like 'calendar_feed_%' and not tgisinternal")
echo "after rollback: functions=$left tables=$tabs triggers=$trg"
[ "$left" = "0" ] && [ "$tabs" = "0" ] && [ "$trg" = "0" ] || { echo "FAIL: rollback left objects" >&2; fail=1; }
echo "== re-apply after rollback"; psql_in < "$MIG" || fail=1

if [ $fail -eq 0 ]; then echo "RESULT: ALL PASSED"; exit 0; fi
echo "RESULT: FAILED" >&2; exit 1
