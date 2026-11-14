#!/usr/bin/env bash
# D24 M2-A: run the real registerHostedInvoice wrapper against the real d24_register_invoice in a DISPOSABLE Postgres container.
# Container df-d24-m2a-pg: no published ports, no volumes, removed on exit. It never touches any other database.
# Usage: bash scripts/qa/d24-m2a-wrapper.sh
set -uo pipefail
NAME=df-d24-m2a-pg
M_CLAIM="src/lib/supabase/migrations/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="src/lib/supabase/migrations/20270203110000_d24_hosted_invoice_facts.sql"
cd "$(dirname "$0")/../.."
for f in "$M_CLAIM" "$M_D24"; do [ -f "$f" ] || { echo "missing $f"; exit 2; }; done
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=d24-local-only postgres:17 >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
P="docker exec -i $NAME psql -U postgres -v ON_ERROR_STOP=1 -q"
$P <<'SQL'
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text, stripe_connected_account_id text);
create table public.studio_invoices (id uuid primary key default gen_random_uuid(), stripe_invoice_id text, studio_id uuid);
create table public.qa_business_objects (id text primary key, studio_id uuid not null);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
$P < "$M_CLAIM" >/dev/null || exit 2
$P < "$M_D24" >/dev/null || exit 2
D24_M2A_PG_CONTAINER="$NAME" npx vitest run src/lib/payments/hostedInvoice/__tests__/register.d24.pg.test.ts --reporter=verbose
