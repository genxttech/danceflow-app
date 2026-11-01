#!/usr/bin/env bash
# D24 disposable Postgres stack for local QA. Reusable by d24-m1-sql.sh style SQL checks and the vitest acceptance suite.
# It only ever creates ONE throwaway container (default name df-d24-qa-pg): no published ports, no network, anonymous data volume removed with the container (rm -fv), never a hosted database.
# The PAY-WH-1 claim migration is applied unmodified on a reconstructed base table (same limitation as stage3-claim-sql.sh).
#
# Usage:
#   bash scripts/qa/d24-stack.sh up   [--m2a REF] [--m2b REF] [--m2c REF] [--stub FILE.sql]...
#   bash scripts/qa/d24-stack.sh down
#   bash scripts/qa/d24-stack.sh layers          # prints the loaded layers, e.g. "m1" or "m1 m2a m2c"
# REF is a git branch/commit holding that sibling's draft. Every migration it ADDS under src/lib/supabase/migrations/ with a
# 20270204..20270206 version prefix is applied after M1, in version order, with `git show REF:path` (nothing is checked out).
# --stub applies extra reconstructed base-table SQL before the claim migration (for tables a draft migration references).
# Env: D24_QA_CONTAINER (default df-d24-qa-pg), D24_QA_IMAGE (default postgres:17).
set -uo pipefail
cd "$(dirname "$0")/../.."
NAME=${D24_QA_CONTAINER:-df-d24-qa-pg}
IMAGE=${D24_QA_IMAGE:-postgres:17}
MIG=src/lib/supabase/migrations
M_CLAIM="$MIG/20261116090000_paywh1_webhook_event_claims.sql"
M_D24="$MIG/20270203110000_d24_hosted_invoice_facts.sql"
BASE_REF=${D24_QA_BASE_REF:-d24-m2-base}

cmd=${1:-}; shift || true
psql_in() { docker exec -i "$NAME" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

case "$cmd" in
  down) if [ "$(docker inspect -f '{{index .Config.Labels "df-d24-qa"}}' "$NAME" 2>/dev/null)" = "1" ]; then docker rm -fv "$NAME" >/dev/null 2>&1; fi; exit 0 ;;
  layers) docker exec "$NAME" cat /tmp/d24-layers 2>/dev/null || { echo "stack not running" >&2; exit 1; }; exit 0 ;;
  up) ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac

declare -A REFS=(); STUBS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --m2a) REFS[m2a]=$2; shift 2 ;;
    --m2b) REFS[m2b]=$2; shift 2 ;;
    --m2c) REFS[m2c]=$2; shift 2 ;;
    --stub) STUBS+=("$2"); shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
[ -n "${REFS[m2b]:-}" ] && STUBS+=("scripts/qa/d24/stubs/auth-roles.sql")   # M2-B needs auth.uid()/auth.jwt(), profiles, user_studio_roles
for f in "$M_CLAIM" "$M_D24"; do [ -f "$f" ] || { echo "missing $f" >&2; exit 2; }; done

# only ever replace a container this script created (label), never an arbitrary one that happens to share the name
if docker inspect "$NAME" >/dev/null 2>&1; then
  [ "$(docker inspect -f '{{index .Config.Labels "df-d24-qa"}}' "$NAME")" = "1" ] || { echo "refusing: container $NAME exists and is not a d24 QA container" >&2; exit 1; }
  docker rm -fv "$NAME" >/dev/null 2>&1
fi
docker run -d --name "$NAME" --label df-d24-qa=1 --network none -e POSTGRES_PASSWORD=d24-local-only "$IMAGE" >/dev/null || exit 1
ok=0
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && ok=1 && break; sleep 1; done
[ "$ok" = 1 ] || { echo "postgres did not start" >&2; exit 1; }
sleep 2   # the official image restarts once after init

psql_in <<'SQL' >/dev/null || exit 1
create role anon nologin; create role authenticated nologin; create role service_role nologin;
create schema if not exists public;
grant usage on schema public to anon, authenticated, service_role;
create table public.studios (id uuid primary key default gen_random_uuid(), name text);
create table public.studio_invoices (id uuid primary key default gen_random_uuid(), stripe_invoice_id text, studio_id uuid);
create table public.payment_provider_events (
  id uuid primary key default gen_random_uuid(), provider text not null, provider_event_id text not null, event_type text,
  status text not null default 'received', payload_hash text, processed_at timestamptz, error_message text,
  created_at timestamptz not null default now(), unique (provider, provider_event_id));
SQL
for s in "${STUBS[@]:-}"; do [ -n "$s" ] && { psql_in < "$s" >/dev/null || { echo "stub failed: $s" >&2; exit 1; }; }; done
psql_in < "$M_CLAIM" >/dev/null || { echo "claim migration failed" >&2; exit 1; }
psql_in < "$M_D24" >/dev/null || { echo "M1 migration failed" >&2; exit 1; }
layers="m1"

for layer in m2a m2c m2b; do   # version order: M2-C (0206) before M2-B (0207)
  ref=${REFS[$layer]:-}
  [ -n "$ref" ] || continue
  git rev-parse --verify --quiet --end-of-options "$BASE_REF^{commit}" >/dev/null && git rev-parse --verify --quiet --end-of-options "$ref^{commit}" >/dev/null || { echo "unknown git ref for $layer: $ref (or base $BASE_REF)" >&2; exit 1; }
  files=$(git diff --name-only --diff-filter=A --end-of-options "$BASE_REF" "$ref" -- "$MIG" | grep -E "/2027020[4-9][0-9]{6}_.*\.sql$" | grep -v '/rollback/' | sort)
  if [ -z "$files" ]; then echo "$layer: no migration on $ref (code-only layer, loaded as a marker)" >&2; layers="$layers $layer"; continue; fi
  for f in $files; do
    git show --end-of-options "$ref:$f" | psql_in >/dev/null || { echo "$layer migration failed: $f" >&2; exit 1; }
    echo "applied $layer: $f" >&2
  done
  layers="$layers $layer"
done
docker exec "$NAME" sh -c "echo '$layers' > /tmp/d24-layers"
echo "stack up: container=$NAME layers=[$layers]" >&2
