#!/usr/bin/env bash
# NSI I2 M11 lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own container.
#   M1-M9 -> M10 -> M11 one at a time; catalog diff M10 -> M11 must be exactly the three replaced functions; boundary suites at M11;
#   rollback M11 restores the M10 fingerprint EXACTLY (and the M10 suite passes again); forward again reproduces M11;
#   M11 replays idempotently; M10 replay fails closed on an M11 database; M11 is refused on an M9 database (precondition);
#   the shared concurrency harness (K1-K3) runs last on the M11 container.
# usage: nsi_i2_m11_lifecycle_local.sh <public-schema-dump.sql>   (schema-only dump of the DanceFlow public schema BEFORE any NSI migration)
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
# appointments structural fingerprint of the supplied schema dump (PROD/DEV value is e0c4db1b4d1b027df0e6e1593d0f14ce). Override with NSI_APPT_FP.
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening)
RB11=20261118100000_nsi_i2_m11_ensure_request_hardening_rollback
fail=0
say() { echo "$*"; }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
newdb() {
  local C="$1"; docker rm -f "$C" >/dev/null 2>&1
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106 >/dev/null
  for i in $(seq 1 30); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done; sleep 8
  docker exec -i "$C" psql -U postgres -q -c "create schema if not exists extensions" >/dev/null 2>&1
  docker exec -i "$C" psql -U postgres -q < "$PUB" >/dev/null 2>&1
  docker exec -e PGPASSWORD=postgres -i "$C" psql -h localhost -U supabase_admin -d postgres -q -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$" >/dev/null 2>&1
}
apply() { out=$(docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[$(($2-1))]}.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2); [ -n "$out" ] && { bad "apply M$2: $out"; return 1; }; return 0; }
rb11() { docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$R/$RB11.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
parts() { sed 's/^select md5(string_agg(x, .|. order by x)) as nsi_catalog_fingerprint, count(\*) as parts$/select x/; s/^) q;$/) q order by x;/' "$D/nsi_i2_catalog_fingerprint_local.sql" | docker exec -i "$1" psql -U postgres -At -f - 2>&1; }
suite() { r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" "$FP" | grep -E "SUITE" | head -1); say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"; }
legacy() { for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"; done; }

say "== forward M1-M10"
C=nsi-i2-m11; newdb $C; for n in 1 2 3 4 5 6 7 8 9 10; do apply $C $n || exit 1; done
F10=$(fp $C); say "   fingerprint M10: $F10"
P10="${TMPDIR:-/tmp}/nsi_parts10.txt"; parts $C > "$P10"
suite $C test_T_nsi_i2_m10_ensure_request_local.sql "M10 suite on M10"
say "== M11 is refused on an M9 database (precondition)"
C9=nsi-i2-m11-pre; newdb $C9; for n in 1 2 3 4 5 6 7 8 9; do apply $C9 $n || exit 1; done
e=$(docker exec -i $C9 psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[10]}.sql" 2>&1 | grep -iE "^ERROR" | head -1)
echo "$e" | grep -q "M11 requires M10" && say "   refused: $(echo "$e" | cut -c1-110)" || bad "M11 not refused on M9: $e"
docker rm -f $C9 >/dev/null 2>&1
say "== apply M11"
apply $C 11 && F11=$(fp $C) && say "   fingerprint M11: $F11"
[ "$F10" != "$F11" ] || bad "M11 did not change the catalog"
P11="${TMPDIR:-/tmp}/nsi_parts11.txt"; parts $C > "$P11"
n=$(diff "$P10" "$P11" | grep -c '^>'); say "   catalog parts that differ M10 -> M11: $n (expected 3: assert_catalog, evaluate_appointment_eligibility, intake_ensure_request)"
[ "$n" = "3" ] || bad "catalog diff is $n parts, expected 3"
diff "$P10" "$P11" | grep '^>' | sed 's/^> f:\([^(]*\)(.*/   changed: \1/' | cut -c1-120
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 boundary suite on M11"
suite $C test_T_nsi_i2_m10_ensure_request_local.sql "M10 suite on M11"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite on M11"
suite $C test_T_nsi_i2_m9_archiving_local.sql "M9 suite on M11"
legacy $C "M11"
say "== rollback restores M10 exactly"
e=$(rb11 $C); [ -n "$e" ] && bad "rollback M11: $e"; [ "$(fp $C)" = "$F10" ] && say "   rollback M11 -> M10 fingerprint identical" || bad "rollback M11 did not restore M10"
suite $C test_T_nsi_i2_m10_ensure_request_local.sql "M10 suite after rollback (back on M10)"
e=$(rb11 $C); echo "$e" | grep -q "refused" && say "   second rollback refused on an M10 database" || bad "rollback not refused on M10: $e"
say "== forward again reproduces M11; replays"
apply $C 11; [ "$(fp $C)" = "$F11" ] && say "   re-applied M11 fingerprint identical" || bad "re-apply differs"
apply $C 11 && say "   replay M11 ok"; [ "$(fp $C)" = "$F11" ] && say "   fingerprint unchanged by the M11 replay" || bad "M11 replay changed the catalog"
e=$(docker exec -i $C psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[9]}.sql" 2>&1 | grep -iE "^ERROR" | head -1)
echo "$e" | grep -q "catalog self-check failed" && say "   replay M10 fails closed: $(echo "$e" | cut -c1-110)" || bad "replay M10 did not fail closed: $e"
[ "$(fp $C)" = "$F11" ] || bad "failed replay of M10 changed the catalog"
say "== concurrency harness K1-K3 on the M11 container"
r=$(bash "$D/concurrency/nsi_i2_concurrency_local.sh" $C 8 2>&1 | tail -4); echo "$r" | sed 's/^/   /'
echo "$r" | grep -q "SUMMARY concurrency: K1 failures=0, K2 failures=0, K3 failures=0" || bad "concurrency harness"
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m11 lifecycle: failures=$fail"
[ "$fail" = "0" ]
