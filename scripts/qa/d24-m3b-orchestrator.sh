#!/usr/bin/env bash
# D24 M3-B: run the REAL orchestrator (create.ts) + REAL Supabase intent store against the REAL M1 + M2-C + M3-A SQL in a DISPOSABLE
# Postgres container, with an OFFLINE fake Stripe. No network (--network none), no ports, no volumes, removed on exit.
# Needs the M3-A migration (not in this branch's base): set D24_M3A_MIGRATION to its path (default: the repo path, if present).
# Usage: D24_M3A_MIGRATION=<path> bash scripts/qa/d24-m3b-orchestrator.sh
set -uo pipefail
NAME=df-d24-m3b-pg-$$
MIG="src/lib/supabase/migrations"
cd "$(dirname "$0")/../.."
M_CLAIM="$MIG/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="$MIG/20270203110000_d24_hosted_invoice_facts.sql"
M_C="$MIG/20270206090000_d24_m2c_drain_recovery.sql"
M_B="$MIG/20270207090000_d24_operator_actions.sql"
STUB="scripts/qa/d24/stubs/auth-roles.sql"
M_A="${D24_M3A_MIGRATION:-$MIG/20270208090000_d24_m3a_intent_ledger.sql}"
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_B" "$M_A" "$STUB"; do [ -f "$f" ] || { echo "missing $f (set D24_M3A_MIGRATION)"; exit 2; }; done
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" --network none -e POSTGRES_PASSWORD=d24-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -q"
$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text, stripe_connected_account_id text, stripe_connect_charges_enabled boolean default true);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
create table public.qa_business_objects (id text primary key, studio_id uuid not null);
SQL
$P < "$STUB" >/dev/null || { echo "stub failed"; exit 2; }
for f in "$M_CLAIM" "$M_D24" "$M_C" "$M_B" "$M_A"; do $P < "$f" >/dev/null || { echo "migration failed: $f"; exit 2; }; done
$P <<'SQL'
create function public.d24_owns_qa_event_fee(p_studio uuid, p_obj text) returns boolean language sql stable
  set search_path = pg_catalog, public as $$ select exists (select 1 from public.qa_business_objects where id = p_obj and studio_id = p_studio) $$;
select public.d24_register_business_object_type('event_fee', 'public.d24_owns_qa_event_fee(uuid,text)'::regprocedure);
SQL
D24_M3B_PG_CONTAINER="$NAME" npx vitest run src/lib/payments/hostedInvoice/__tests__/create.d24.pg.test.ts --reporter=verbose
