#!/usr/bin/env bash
# D24 disposable Postgres stack for local QA. Reusable by d24-m1-sql.sh style SQL checks and the vitest acceptance suite.
# It only ever creates ONE throwaway container (default name df-d24-qa-pg): no published ports, no network, anonymous data volume removed with the container (rm -fv), never a hosted database.
# The PAY-WH-1 claim migration is applied unmodified on a reconstructed base table (same limitation as stage3-claim-sql.sh).
#
# Usage:
#   bash scripts/qa/d24-stack.sh up                    # DEFAULT: layers come from this checkout (the merged tree), no refs
#   bash scripts/qa/d24-stack.sh up --m1-only          # M1 only (layers m2a/m2b/m2c stay BLOCKED)
#   bash scripts/qa/d24-stack.sh up   [--m2a REF] [--m2b REF] [--m2c REF] [--stub FILE.sql]...   # optional: draft layers from git refs
#   bash scripts/qa/d24-stack.sh up   [--m3a REF|TREE] [--m3b REF|TREE] [--m3c REF|TREE]        # M3 layers: PR-head git refs, or this checkout (TREE)
#   bash scripts/qa/d24-stack.sh down
#   bash scripts/qa/d24-stack.sh layers          # prints the loaded layers, e.g. "m1" or "m1 m2a m2c"
# REF is a git branch/commit holding that sibling's draft. Every migration it ADDS under src/lib/supabase/migrations/ with a
# 20270204..20270206 version prefix is applied after M1, in version order, with `git show REF:path` (nothing is checked out).
# M3 layers (D24 M3-D): m3a = SQL (version 20270208xxxxxx), m3b = code-only orchestrator, m3c = SQL >= 20270209000000 plus code. A REF is diffed against
# `git merge-base REF HEAD`, so a draft PR head loads exactly its own additions on top of the merged tree. Non-migration src/ files of a REF layer are
# extracted with `git show` (nothing is checked out) into $D24_OVERLAY, which the vitest config exposes as @d24overlay. A layer that is not given stays NOT loaded
# (its scenarios report BLOCKED); a bare `up` auto-loads m3a/m3b/m3c from THIS checkout only if the merged tree already contains them.
# The exact commit of every loaded layer is stored beside the layer list (`shas` command).
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
  shas) docker exec "$NAME" sh -c "cat /tmp/d24-shas" 2>/dev/null || { echo "stack not running" >&2; exit 1; }; exit 0 ;;
  down) if [ "$(docker inspect -f '{{index .Config.Labels "df-d24-qa"}}' "$NAME" 2>/dev/null)" = "1" ]; then docker rm -fv "$NAME" >/dev/null 2>&1; fi; exit 0 ;;
  layers) docker exec "$NAME" sh -c "cat /tmp/d24-layers" 2>/dev/null || { echo "stack not running" >&2; exit 1; }; exit 0 ;;
  up) ;;
  *) sed -n 2,16p "$0"; exit 2 ;;
esac

declare -A REFS=(); STUBS=(); M1ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --m2a) REFS[m2a]=$2; shift 2 ;;
    --m2b) REFS[m2b]=$2; shift 2 ;;
    --m2c) REFS[m2c]=$2; shift 2 ;;
    --m3a) REFS[m3a]=$2; shift 2 ;;
    --m3b) REFS[m3b]=$2; shift 2 ;;
    --m3c) REFS[m3c]=$2; shift 2 ;;
    --stub) STUBS+=("$2"); shift 2 ;;
    --m1-only) M1ONLY=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
if [ "$M1ONLY" = 0 ] && [ ${#REFS[@]} -eq 0 ]; then
  REFS[m2a]=TREE; REFS[m2c]=TREE; REFS[m2b]=TREE
  ls "$MIG" | grep -qE '^20270208[0-9]{6}_.*\.sql$' && REFS[m3a]=TREE
  [ -f src/lib/payments/hostedInvoice/create.ts ] && REFS[m3b]=TREE
  ls "$MIG" | awk '/^[0-9]{14}_.*\.sql$/ && substr($0,1,14) >= "20270209000000" {f=1} END {exit !f}' && REFS[m3c]=TREE
fi
[ -n "${REFS[m2b]:-}" ] && STUBS+=("scripts/qa/d24/stubs/auth-roles.sql")   # M2-B needs auth.uid()/auth.jwt(), profiles, user_studio_roles
[ -z "${REFS[m2b]:-}" ] && [ -n "${REFS[m3c]:-}" ] && STUBS+=("scripts/qa/d24/stubs/auth-roles.sql")
[ -n "${REFS[m3c]:-}" ] && STUBS+=("scripts/qa/d24/stubs/m3c-base.sql")   # M3-C references clients/appointments/events/payments
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
create table public.studios (id uuid primary key default gen_random_uuid(), name text, stripe_connected_account_id text, stripe_connect_charges_enabled boolean default true);
grant select on public.studios to service_role;   -- as on Supabase; M3-A resolves the Stripe account from this table
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
  if [ "$ref" = TREE ]; then
    case $layer in m2a) pat=NONE ;; m2c) pat=20270206 ;; m2b) pat=20270207 ;; esac
    files=$(ls "$MIG" | grep -E "^${pat}[0-9]{6}_.*.sql$" | sed "s|^|$MIG/|")
  else
  git rev-parse --verify --quiet --end-of-options "$BASE_REF^{commit}" >/dev/null && git rev-parse --verify --quiet --end-of-options "$ref^{commit}" >/dev/null || { echo "unknown git ref for $layer: $ref (or base $BASE_REF)" >&2; exit 1; }
  files=$(git diff --name-only --diff-filter=A --end-of-options "$BASE_REF" "$ref" -- "$MIG" | grep -E "/2027020[4-9][0-9]{6}_.*\.sql$" | grep -v '/rollback/' | sort)
  fi
  if [ "$ref" = TREE ] && [ "$layer" = m2a ]; then
    [ -f src/lib/payments/hostedInvoice/register.ts ] && { echo "m2a: code-only layer present in tree (register.ts)" >&2; layers="$layers m2a"; }
    continue
  fi
  if [ "$ref" = TREE ] && [ -z "$files" ]; then echo "$layer: expected migration is missing from this checkout" >&2; exit 1; fi
  if [ -z "$files" ]; then echo "$layer: no migration on $ref (code-only layer, loaded as a marker)" >&2; layers="$layers $layer"; continue; fi
  for f in $files; do
    if [ "$ref" = TREE ]; then cat "$f" | psql_in; else git show --end-of-options "$ref:$f" | psql_in; fi >/dev/null || { echo "$layer migration failed: $f" >&2; exit 1; }
    echo "applied $layer: $f" >&2
  done
  layers="$layers $layer"
done

# ---- M3 layers (order: M3-A SQL, M3-B code, M3-C SQL + code) ----
shas=""
head_sha=$(git rev-parse HEAD)
[ -n "${REFS[m2a]:-}${REFS[m2b]:-}${REFS[m2c]:-}" ] && shas="tree=$head_sha"
OVERLAY=${D24_OVERLAY:-}
overlay_from() {   # $1=ref $2=merge-base: extract every added/modified non-migration src/ file of the ref (later layers overwrite earlier ones)
  [ -n "$OVERLAY" ] || { echo "D24_OVERLAY is not set: a ref'd code layer cannot be loaded" >&2; exit 1; }
  local f
  for f in $(git diff --name-only --diff-filter=AM --end-of-options "$2" "$1" -- src | grep -v '/migrations/'); do
    mkdir -p "$OVERLAY/$(dirname "$f")"
    git show --end-of-options "$1:$f" > "$OVERLAY/$f" || { echo "cannot extract $f from $1" >&2; exit 1; }
  done
}
for layer in m3a m3b m3c; do
  ref=${REFS[$layer]:-}
  [ -n "$ref" ] || continue
  mb=""; files=""
  if [ "$ref" = TREE ]; then
    sha="TREE@$head_sha"
    case $layer in
      m3a) files=$(ls "$MIG" | grep -E '^20270208[0-9]{6}_.*\.sql$' | sed "s|^|$MIG/|") ;;
      m3c) files=$(ls "$MIG" | awk '/^[0-9]{14}_.*\.sql$/ && substr($0,1,14) >= "20270209000000"' | sed "s|^|$MIG/|") ;;
    esac
    case $layer in
      m3b) [ -f src/lib/payments/hostedInvoice/create.ts ] || { echo "m3b: create.ts is not in this checkout" >&2; exit 1; } ;;
      m3a|m3c) [ -n "$files" ] || { echo "$layer: expected migration is missing from this checkout" >&2; exit 1; } ;;
    esac
  else
    sha=$(git rev-parse --verify --quiet --end-of-options "$ref^{commit}") || { echo "unknown git ref for $layer: $ref" >&2; exit 1; }
    mb=$(git merge-base "$sha" HEAD) || { echo "no merge-base for $layer ($ref) with HEAD" >&2; exit 1; }
    case $layer in
      m3a) files=$(git diff --name-only --diff-filter=A --end-of-options "$mb" "$sha" -- "$MIG" | grep -E '/20270208[0-9]{6}_.*\.sql$' | grep -v '/rollback/' | sort) ;;
      m3c) files=$(git diff --name-only --diff-filter=A --end-of-options "$mb" "$sha" -- "$MIG" | grep -v '/rollback/' | awk -F/ '{v=substr($NF,1,14)} v >= "20270209000000"' | sort) ;;
    esac
    [ "$layer" = m3a ] && [ -z "$files" ] && { echo "m3a: no 20270208 migration on $ref" >&2; exit 1; }
    [ "$layer" = m3b ] && ! git cat-file -e "$sha:src/lib/payments/hostedInvoice/create.ts" 2>/dev/null && { echo "m3b: $ref has no src/lib/payments/hostedInvoice/create.ts" >&2; exit 1; }
    overlay_from "$sha" "$mb"
  fi
  for f in $files; do
    if [ "$ref" = TREE ]; then cat "$f" | psql_in; else git show --end-of-options "$sha:$f" | psql_in; fi >/dev/null || { echo "$layer migration failed: $f" >&2; exit 1; }
    echo "applied $layer: $f" >&2
  done
  layers="$layers $layer"
  shas="$shas $layer=$sha"
done
docker exec "$NAME" sh -c "echo '$layers' > /tmp/d24-layers; echo '$shas' > /tmp/d24-shas"
echo "stack up: container=$NAME layers=[$layers]" >&2
