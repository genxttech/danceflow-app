#!/usr/bin/env bash
# NSI I2 M10 lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   forward M1-M9 -> fingerprint F9; M10 -> boundary suites; rollback M10 restores F9 EXACTLY; forward again reproduces F10;
#   M10 replays idempotently; M8/M9 replays fail closed on an M10 database and change nothing; M10 rollback refused on an M9 database.
# usage: nsi_i2_m10_lifecycle_local.sh <public-schema-dump.sql>   (schema-only dump of the DanceFlow public schema BEFORE any NSI migration)
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
# appointments structural fingerprint of the schema dump used here (PROD/DEV value is e0c4db1b4d1b027df0e6e1593d0f14ce; the pre-NSI image lacks two later
# appointments objects: the group_class_enrollment_holds FK and the floor-rental financial-fields trigger). Override with NSI_APPT_FP.
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator)
RB10=20261118099000_nsi_i2_m10_ensure_request_evaluator_rollback
fail=0
say() { echo "$*"; }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
newdb() {
  C="$1"; docker rm -f "$C" >/dev/null 2>&1
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106 >/dev/null
  for i in $(seq 1 30); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done; sleep 8
  docker exec -i "$C" psql -U postgres -q -c "create schema if not exists extensions" >/dev/null 2>&1
  docker exec -i "$C" psql -U postgres -q < "$PUB" >/dev/null 2>&1
  docker exec -e PGPASSWORD=postgres -i "$C" psql -h localhost -U supabase_admin -d postgres -q -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$" >/dev/null 2>&1
}
apply() { out=$(docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[$(($2-1))]}.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2); [ -n "$out" ] && { bad "apply M$2: $out"; return 1; }; return 0; }
rb10() { docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$R/$RB10.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
suite() { r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" "$FP" | grep -E "SUITE" | head -1); say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"; }
# test_T_nsi_i1_local (303 checks) builds obligations through ensure_request with pre-evaluator fixtures (appointment created "now", no grant);
# it is a valid M1-M9 suite only. The catalog diff M9 -> M10 is exactly two parts (assert_catalog, intake_ensure_request), see NSI_I2_M10_Notes.md.
i1() { for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"; done; }

say "== forward M1-M9, then M10"
C=nsi-i2-m10; newdb $C; for n in 1 2 3 4 5 6 7 8 9; do apply $C $n || exit 1; done
F9=$(fp $C); say "   fingerprint M9: $F9"
suite $C test_T_nsi_i2_m8_types_simulation_local.sql "M8 suite on M9 (documents the OPEN P1 behaviour)"
for f in test_T_nsi_i1_foundation test_T_nsi_i1_local test_T_nsi_i2_local; do   # all three legacy suites still pass on M9 with the M10-aware edits
  r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$C" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
  say "   M9 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "M9 $f: $r"
done
apply $C 10 && F10=$(fp $C) && say "   fingerprint M10: $F10"
[ "$F9" != "$F10" ] || bad "M10 did not change the catalog fingerprint"
suite $C test_T_nsi_i2_m10_ensure_request_local.sql "M10 boundary suite on M10"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite on M10"
suite $C test_T_nsi_i2_m9_archiving_local.sql "M9 suite on M10"
i1 $C "M10"
say "== rollback restores M9 exactly"
e=$(rb10 $C); [ -n "$e" ] && bad "rollback M10: $e"; [ "$(fp $C)" = "$F9" ] && say "   rollback M10 -> M9 fingerprint identical" || bad "rollback M10 did not restore M9"
suite $C test_T_nsi_i2_m8_types_simulation_local.sql "M8 suite after rollback (back on M9)"
e=$(rb10 $C); echo "$e" | grep -q "refused" && say "   second rollback refused on an M9 database: $(echo "$e" | cut -c1-90)" || bad "rollback not refused on M9: $e"
[ "$(fp $C)" = "$F9" ] || bad "refused rollback changed the catalog"
say "== forward again reproduces M10"
apply $C 10; [ "$(fp $C)" = "$F10" ] && say "   re-applied M10 fingerprint identical" || bad "re-apply differs"
say "== replays on an M10 database"
apply $C 10 && say "   replay M10 ok"; [ "$(fp $C)" = "$F10" ] && say "   fingerprint unchanged by the M10 replay" || bad "M10 replay changed the catalog"
for n in 8 9; do
  e=$(docker exec -i $C psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[$((n-1))]}.sql" 2>&1 | grep -iE "^ERROR" | head -1)
  echo "$e" | grep -q "catalog self-check failed" && say "   replay M$n fails closed: $(echo "$e" | cut -c1-120)" || bad "replay M$n did not fail closed: $e"
  [ "$(fp $C)" = "$F10" ] || bad "failed replay of M$n changed the catalog"
done
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m10 lifecycle: failures=$fail"
[ "$fail" = "0" ]
