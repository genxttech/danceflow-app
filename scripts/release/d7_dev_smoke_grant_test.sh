#!/usr/bin/env bash
# Disposable-Postgres test of scripts/release/d7_dev_smoke_grant.sql and d7_dev_smoke_grant_rollback.sql. LOCAL QA ONLY.
# Never point this at a hosted database (it starts its own postgres:17 container and removes it).
# Needs the PROD-shaped stub from the release-runbook branch:
#   git show origin/claude/d7-core-release-runbook:scripts/release/d7_core_stub_prod_shape.sql > <file>   (path passed as $1, or fetched below)
# Usage: bash scripts/release/d7_dev_smoke_grant_test.sh
set -euo pipefail
export MSYS_NO_PATHCONV=1
C=df-d7smoke-pg
ROOT="$(cd "$(dirname "$0")/../.." && (pwd -W 2>/dev/null || pwd))"
MIG="$ROOT/src/lib/supabase/migrations"
SCR="$ROOT/scripts/release"
WORK="${TMPDIR:-/tmp}/d7smoke.$$"
mkdir -p "$WORK"
STUB="${1:-$WORK/stub.sql}"
[ -s "$STUB" ] || git -C "$ROOT" show origin/claude/d7-core-release-runbook:scripts/release/d7_core_stub_prod_shape.sql > "$STUB"
cleanup() { docker rm -f "$C" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cleanup
mkdir -p "$WORK"; [ -s "$STUB" ] || git -C "$ROOT" show origin/claude/d7-core-release-runbook:scripts/release/d7_core_stub_prod_shape.sql > "$STUB"
docker run -d --name "$C" -e POSTGRES_PASSWORD=pw postgres:17 >/dev/null
for i in $(seq 1 40); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P() { docker exec -i "$C" psql -U postgres -d t -v ON_ERROR_STOP=1 -X -q "$@"; }
PF() { docker exec -i "$C" psql -U postgres -d t -v ON_ERROR_STOP=1 -X -q -At "$@"; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; exit 1; }
# run an SQL file with v_studio substituted; echo "ok" or "refused: <message>"
run_sql() { # $1 file, $2 studio uuid
  sed "s/v_studio uuid := '00000000-0000-0000-0000-000000000000'/v_studio uuid := '$2'/" "$1" > "$WORK/run.sql"
  docker cp "$WORK/run.sql" "$C:/tmp/run.sql"
  if out=$(docker exec -i "$C" psql -U postgres -d t -v ON_ERROR_STOP=1 -X -q -At -f /tmp/run.sql 2>&1); then echo "ok"; else echo "refused: $(echo "$out" | grep -m1 -o 'refused:.*\|rows matched.*\|ERROR:.*')"; fi
}
expect_ok() { r=$(run_sql "$2" "$3"); [ "$r" = "ok" ] || fail "$1 (got: $r)"; pass "$1"; }
expect_refused() { r=$(run_sql "$2" "$3"); case "$r" in refused:*) pass "$1 -> $r";; *) fail "$1 (got: $r)";; esac; }

docker exec -i "$C" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -X -q -c "create role anon nologin" -c "create role authenticated nologin" -c "create role service_role nologin bypassrls" -c "create database t"
P -c "grant usage on schema public to anon, authenticated, service_role"
docker cp "$STUB" "$C:/tmp/stub.sql"; P -f /tmp/stub.sql

# --- test seed on top of the PROD-shaped stub: plans, subscriptions, DEV markers, migration-history table
P <<'SQL'
create table public.subscription_plans(id uuid primary key default gen_random_uuid(), code text not null);
create table public.studio_subscriptions(id uuid primary key default gen_random_uuid(), studio_id uuid, subscription_plan_id uuid references public.subscription_plans(id), status text, created_at timestamptz default now());
insert into public.subscription_plans(id, code) values ('00000000-0000-0000-0000-0000000000c1','pro'),('00000000-0000-0000-0000-0000000000c2','organizer');
-- DEV markers (the stub already holds 2 PROD-like grants on studios a1/a2 with other ids; the PROD marker ids are NOT present)
insert into public.studios(id, timezone) values
  ('a25932ab-93a6-4a35-9434-1e7442135a73','America/New_York'),   -- DEV studio marker
  ('00000000-0000-0000-0000-0000000000d1','America/New_York'),   -- target: pro, active
  ('00000000-0000-0000-0000-0000000000d2','America/New_York'),   -- organizer plan
  ('00000000-0000-0000-0000-0000000000d3','America/New_York');   -- no subscription
insert into public.usage_addon_entitlements(id, studio_id, workspace_type, feature_key, source, stripe_subscription_item_id)
  values ('a3b1df74-0f56-44fe-a217-8f60d9fc7cc4','a25932ab-93a6-4a35-9434-1e7442135a73','studio','organizer_suite','stripe_subscription_item','si_devmarker');
insert into public.studio_subscriptions(studio_id, subscription_plan_id, status) values
  ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000c1','active'),
  ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000c2','trialing');
create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key);
SQL

T=00000000-0000-0000-0000-0000000000d1
G="$SCR/d7_dev_smoke_grant.sql"; R="$SCR/d7_dev_smoke_grant_rollback.sql"
cnt() { PF -c "select count(*) from public.usage_addon_entitlements where studio_id='$T' and source='manual_grant' and status='$1'"; }

echo "=== A. PRE-D7 state (stub only)"
expect_refused "nil studio id refuses" "$G" 00000000-0000-0000-0000-000000000000
expect_refused "unknown studio refuses" "$G" 00000000-0000-0000-0000-0000000000ff
expect_refused "organizer-plan studio refuses" "$G" 00000000-0000-0000-0000-0000000000d2
expect_refused "studio without subscription refuses" "$G" 00000000-0000-0000-0000-0000000000d3
P -c "insert into public.studios(id, timezone) values ('dd6c35ce-0765-4247-afc2-9738817e991c','America/New_York')"
expect_refused "PROD marker studio present -> refuses" "$G" $T
expect_refused "PROD marker present -> rollback refuses too" "$R" $T
P -c "delete from public.studios where id='dd6c35ce-0765-4247-afc2-9738817e991c'"
P -c "insert into public.usage_addon_entitlements(id, studio_id, workspace_type, feature_key, source) values ('095f8801-7d18-4c73-8d0e-141bd93dcbca','00000000-0000-0000-0000-0000000000a1','studio','organizer_suite','manual_grant_x')"
expect_refused "PROD marker entitlement present -> refuses" "$G" $T
P -c "delete from public.usage_addon_entitlements where id='095f8801-7d18-4c73-8d0e-141bd93dcbca'"
P -c "alter schema supabase_migrations rename to supabase_migrations_off"
expect_refused "no migration-history table -> refuses" "$G" $T
P -c "alter schema supabase_migrations_off rename to supabase_migrations"
P -c "delete from public.usage_addon_entitlements where id='a3b1df74-0f56-44fe-a217-8f60d9fc7cc4'"
expect_refused "DEV marker missing -> refuses" "$G" $T
P -c "insert into public.usage_addon_entitlements(id, studio_id, workspace_type, feature_key, source, stripe_subscription_item_id) values ('a3b1df74-0f56-44fe-a217-8f60d9fc7cc4','a25932ab-93a6-4a35-9434-1e7442135a73','studio','organizer_suite','stripe_subscription_item','si_devmarker')"
[ "$(cnt active)" = "0" ] || fail "no grant should exist yet"
expect_ok "grant inserted" "$G" $T
[ "$(cnt active)" = "1" ] || fail "exactly one active grant expected"; pass "one active manual grant, open-ended"
[ "$(PF -c "select notes||'|'||workspace_type||'|'||quantity_included||'|'||coalesce(period_end::text,'null') from public.usage_addon_entitlements where studio_id='$T'")" = "DEV D7 smoke test, remove after|studio|1|null" ] || fail "row content"
pass "row content as designed"
expect_refused "second grant refused (already active)" "$G" $T
expect_ok "rollback cancels" "$R" $T
[ "$(cnt active)" = "0" ] && [ "$(cnt canceled)" = "1" ] || fail "expected 0 active / 1 canceled"; pass "status canceled, row kept"
expect_ok "rollback is idempotent (no-op)" "$R" $T
expect_ok "re-grant after cancel" "$G" $T
# variant B (pre-D7): uncomment the block and run it
sed -n '/^-- VARIANT B/,$p' "$R" | sed '1,/^--$/d' | sed 's/^-- \{0,1\}//' | sed "s/00000000-0000-0000-0000-000000000000/$T/" > "$WORK/vb.sql"
docker cp "$WORK/vb.sql" "$C:/tmp/vb.sql"; P -f /tmp/vb.sql
[ "$(PF -c "select count(*) from public.usage_addon_entitlements where studio_id='$T' and source='manual_grant'")" = "0" ] || fail "variant B should have deleted both rows"
pass "variant B (pre-D7 delete) removed the grant rows"

echo "=== B. POST-D7 state (migrations 20270203090000 + 20270203100000 applied)"
for f in 20270203090000_organizer_suite_entitlement_integrity.sql 20270203100000_usage_addon_entitlements_least_privilege.sql; do docker cp "$MIG/$f" "$C:/tmp/$f"; P -f "/tmp/$f" >/dev/null; done
expect_ok "grant inserted" "$G" $T
[ "$(PF -c "select count(*) from public.usage_addon_entitlement_events where studio_id='$T'")" = "1" ] || fail "expected 1 audit event"
[ "$(PF -c "select event_type||'|'||to_status||'|'||actor||'|'||reason from public.usage_addon_entitlement_events where studio_id='$T'")" = "insert|active|d7_dev_smoke_grant|DEV D7 smoke test grant (scripts/release/d7_dev_smoke_grant.sql)" ] || fail "insert event content"
pass "audit: one insert event with actor and reason"
[ "$(PF -c "select public.usage_addon_entitlement_is_current(e.status, e.period_start, e.period_end, s.timezone, now())::text from public.usage_addon_entitlements e join public.studios s on s.id=e.studio_id where e.studio_id='$T'")" = "true" ] || fail "grant not current"
pass "grant reads as current"
expect_refused "second grant refused post-D7" "$G" $T
expect_ok "rollback cancels post-D7" "$R" $T
[ "$(PF -c "select string_agg(event_type||':'||coalesce(from_status,'')||'>'||coalesce(to_status,''), ',' order by created_at) from public.usage_addon_entitlement_events where studio_id='$T'")" = "insert:>active,status_change:active>canceled" ] || fail "event sequence"
pass "audit: insert then status_change active>canceled"
[ "$(PF -c "select public.usage_addon_entitlement_is_current(e.status, e.period_start, e.period_end, s.timezone, now())::text from public.usage_addon_entitlements e join public.studios s on s.id=e.studio_id where e.studio_id='$T'")" = "false" ] || fail "canceled grant still current"
pass "canceled grant no longer current"
expect_ok "rollback again is a no-op, no new event" "$R" $T
[ "$(PF -c "select count(*) from public.usage_addon_entitlement_events where studio_id='$T'")" = "2" ] || fail "no-op rollback wrote an event"
pass "no extra audit event"
# variant B must refuse post-D7
if P -f /tmp/vb.sql >/dev/null 2>&1; then fail "variant B should refuse once the audit table exists"; fi
pass "variant B refuses post-D7"
# service_role has no DELETE post-D7 (why cancel is the post-D7 path)
if docker exec -i "$C" psql -U postgres -d t -X -q -c "set role service_role; delete from public.usage_addon_entitlements where studio_id='$T'" >/dev/null 2>&1; then fail "service_role delete should be denied"; fi
pass "service_role DELETE denied post-D7"
echo "ALL PASS"
