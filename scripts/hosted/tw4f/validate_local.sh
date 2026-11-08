#!/usr/bin/env bash
# TW-4F H1: validates probe_objects.sql and probe_fingerprint.sql against a THROWAWAY local Postgres container that YOU started for this purpose.
#   usage: scripts/hosted/tw4f/validate_local.sh <container-name>
#   e.g.   docker run -d --name tw4f-h1-probe-pg -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=probe postgres:17
# Refuses names that look like shared or Supabase stacks. Never connects to a hosted project: it only calls `docker exec`.
set -euo pipefail
C="${1:?container name}"
case "$C" in supabase_*|df-isoqa*|qacomb*|*prod*|*dev-db*) echo "refusing shared/unsafe container name: $C" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp -d)"; trap 'rm -rf "$OUT"' EXIT
psqlq() { docker exec -i "$C" psql -U postgres -d probe -v ON_ERROR_STOP=1 -X -q "$@"; }
run_ro() { { echo "begin read only;"; cat "$1"; echo "rollback;"; } | psqlq -P pager=off -A -F ' | ' -t; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== reset"; psqlq -c "drop schema public cascade; create schema public;" >/dev/null 2>&1 || true
psqlq -c "do \$\$ begin drop role if exists anon; drop role if exists authenticated; drop role if exists service_role; end \$\$;" >/dev/null 2>&1 || true

for P in probe_objects probe_fingerprint; do
  echo "== $P on an EMPTY database (every expected object must report MISSING / zero rows, no error)"
  run_ro "$HERE/$P.sql" > "$OUT/$P.empty.txt" || fail "$P errored on an empty database"
  head -3 "$OUT/$P.empty.txt"; wc -l < "$OUT/$P.empty.txt"
done
grep -q 'read_only_txn | on' $OUT/probe_objects.empty.txt || fail "probe ran outside a read-only transaction"

echo "== load fixture"; psqlq < "$HERE/validate_local.fixture.sql" >/dev/null
SNAP="select md5(string_agg(x,',' order by x)) from (select 'c:'||oid||relname||coalesce(relacl::text,'') x from pg_class where relnamespace='public'::regnamespace union all select 'p:'||oid||md5(prosrc)||coalesce(proacl::text,'') from pg_proc where pronamespace='public'::regnamespace union all select 't:'||count(*) from public.studio_sms_onboarding) s"
BEFORE="$(psqlq -At -c "$SNAP")"
for P in probe_objects probe_fingerprint; do
  run_ro "$HERE/$P.sql" > "$OUT/$P.fixture.txt" || fail "$P errored on the fixture"
done
AFTER="$(psqlq -At -c "$SNAP")"
[ "$BEFORE" = "$AFTER" ] || fail "catalog or data changed while probing"
echo "no catalog/data change across probes: $BEFORE"

echo "== negative control: a write inside the same read-only wrapper must be refused"
if echo "begin read only; insert into public.studio_sms_onboarding (studio_id) values (gen_random_uuid()); rollback;" | psqlq >/dev/null 2>&1; then fail "read-only wrapper did not block a write"; fi
echo "write correctly refused"

echo "== assertions on fixture output"
grep -qE '^10_table \| studio_sms_onboarding \| PRESENT \| rls=t force=f rows=2 ' $OUT/probe_objects.fixture.txt || fail "onboarding table row/RLS facts"
grep -qE '^10_table \| studio_sms_credit_ledger \| PRESENT \| rls=t force=t rows=0 ' $OUT/probe_objects.fixture.txt || fail "force-RLS table facts"
grep -qE '^11_table_unlisted \| studio_sms_not_in_manifest \| UNEXPECTED' $OUT/probe_objects.fixture.txt || fail "unlisted table not flagged"
grep -qE '^20_function \| get_studio_sms_status\(p uuid\) \| PRESENT .*anon:false authenticated:true service_role:false public:false' $OUT/probe_objects.fixture.txt || fail "execute privilege facts"
grep -qE '^20_function \| tw4_runner_claim\(p uuid\) \| PRESENT .*\(CR in stored body\).*anon:false authenticated:false service_role:true' $OUT/probe_objects.fixture.txt || fail "CR body flag / service-only grants"
grep -qE '^21_function_unlisted \| tw4_future_unlisted_fn' $OUT/probe_objects.fixture.txt || fail "unlisted function not flagged"
grep -qE '^30_trigger \| studio_sms_onboarding.studio_sms_onboarding_10_integrity \| ENABLED' $OUT/probe_objects.fixture.txt || fail "trigger listing"
grep -qE '^20_function \| tw4_prov_claim \| MISSING' $OUT/probe_objects.fixture.txt || fail "missing expected function not reported"
grep -qE '^rollup:ALL' $OUT/probe_fingerprint.fixture.txt || fail "no ALL rollup"
# CRLF normalisation: the stored CR body must hash like its LF twin
LF="$(psqlq -At -c "select left(md5(E'begin\n  return 1;\nend'),8)")"
grep -qE "fn_body:other_sms_functions|fn_body:tw4_functions \| tw4_runner_claim\(p uuid\) \| $LF" $OUT/probe_fingerprint.fixture.txt || fail "CRLF body fingerprint differs from LF twin ($LF)"
# determinism: a second run gives byte-identical output
run_ro "$HERE/probe_fingerprint.sql" | cmp - $OUT/probe_fingerprint.fixture.txt || fail "fingerprint is not deterministic"
echo "ALL LOCAL PROBE CHECKS PASSED"
