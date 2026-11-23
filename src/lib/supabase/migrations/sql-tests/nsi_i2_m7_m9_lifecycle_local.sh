#!/usr/bin/env bash
# NSI I2 M7-M9 lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   flow F  forward M7, M8, M9 one at a time (boundary tests at each level) -> rollbacks M9, M8, M7 restore EXACTLY the
#           previous catalog fingerprint -> forward again reproduces the M9 fingerprint
#   flow A  M9 rollback is refused once an archive audit event exists; state unchanged
#   flow B  M8 rollback refused with a NULL-template selection; M7 rollback refused once a grant exists; state unchanged
# usage: nsi_i2_m7_m9_lifecycle_local.sh   (needs /tmp/pub_schema.sql: schema-only dump of the DanceFlow public schema)
set -u
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
FP=e0c4db1b4d1b027df0e6e1593d0f14ce
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving)
RBS=("" "" "" "" "" 20261118095000_nsi_i2_eligibility_preview_rollback 20261118096000_nsi_i2_m7_pilot_grants_rollback 20261118097000_nsi_i2_m8_lesson_types_simulation_rollback 20261118098000_nsi_i2_m9_template_archiving_rollback)
fail=0
say() { echo "$*"; }
bad() { echo "FAIL: $*"; fail=$((fail+1)); }
newdb() {
  C="$1"; docker rm -f "$C" >/dev/null 2>&1
  docker run -d --name "$C" -e POSTGRES_PASSWORD=postgres public.ecr.aws/supabase/postgres:17.6.1.106 >/dev/null
  for i in $(seq 1 30); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 2; done; sleep 8
  docker exec -i "$C" psql -U postgres -q -c "create schema if not exists extensions" >/dev/null 2>&1
  docker exec -i "$C" psql -U postgres -q < /tmp/pub_schema.sql >/dev/null 2>&1
  docker exec -e PGPASSWORD=postgres -i "$C" psql -h localhost -U supabase_admin -d postgres -q -c "create or replace function auth.uid() returns uuid language sql stable as \$\$ select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''), nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$\$;"
}
apply() { # container index(1-based migration number)
  out=$(docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[$(($2-1))]}.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2)
  [ -n "$out" ] && { bad "apply M$2: $out"; return 1; }; return 0
}
rollback() {
  docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$R/${RBS[$(($2-1))]}.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2
}
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
suite() { # container test-file-or-runner label
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" | grep -E "SUITE" | head -1)
  say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"
}
i1() { # container label
  for f in test_T_nsi_i1_foundation test_T_nsi_i1_local test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-600)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"
  done
}

# ------------------------------------------------------------------------------------------------ flow F
say "== flow F: forward one migration at a time, tests at each boundary"
C=nsi-i2-lifecycle
newdb $C; for n in 1 2 3 4 5 6; do apply $C $n || exit 1; done
F6=$(fp $C); say "   fingerprint M6: $F6"
apply $C 7 && F7=$(fp $C) && say "   fingerprint M7: $F7"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 boundary suite on M7"
apply $C 8 && F8=$(fp $C) && say "   fingerprint M8: $F8"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite on M8"
suite $C test_T_nsi_i2_m8_types_simulation_local.sql "M8 boundary suite on M8"
apply $C 9 && F9=$(fp $C) && say "   fingerprint M9: $F9"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite on M9"
suite $C test_T_nsi_i2_m8_types_simulation_local.sql "M8 suite on M9"
suite $C test_T_nsi_i2_m9_archiving_local.sql "M9 boundary suite on M9"
i1 $C "M9"
say "== rollbacks restore exact levels"
e=$(rollback $C 9); [ -n "$e" ] && bad "rollback M9: $e"; [ "$(fp $C)" = "$F8" ] && say "   rollback M9 -> M8 fingerprint identical" || bad "rollback M9 did not restore M8"
suite $C test_T_nsi_i2_m8_types_simulation_local.sql "M8 suite after rollback of M9 (back on M8)"
e=$(rollback $C 8); [ -n "$e" ] && bad "rollback M8: $e"; [ "$(fp $C)" = "$F7" ] && say "   rollback M8 -> M7 fingerprint identical" || bad "rollback M8 did not restore M7"
suite $C test_T_nsi_i2_m7_grants_local.sql "M7 suite after rollback of M8 (back on M7)"
e=$(rollback $C 7); [ -n "$e" ] && bad "rollback M7: $e"; [ "$(fp $C)" = "$F6" ] && say "   rollback M7 -> M6 fingerprint identical" || bad "rollback M7 did not restore M6"
say "== forward again reproduces M9"
for n in 7 8 9; do apply $C $n; done; [ "$(fp $C)" = "$F9" ] && say "   re-applied M9 fingerprint identical" || bad "re-apply differs"
say "== replay on a complete M9 database: M2-M4 and M9 are idempotent; M1 and M5-M8 fail closed (older bodies / older catalog) and change nothing"
for n in 2 3 4 9; do apply $C $n && say "   replay M$n ok"; done
[ "$(fp $C)" = "$F9" ] && say "   fingerprint unchanged after the idempotent replays" || bad "idempotent replays changed the catalog"
for n in 1 5 6 7 8; do
  e=$(docker exec -i $C psql -U postgres -q -v ON_ERROR_STOP=1 < "$M/${FILES[$((n-1))]}.sql" 2>&1 | grep -iE "^ERROR" | head -1)
  echo "$e" | grep -q "catalog self-check failed" && say "   replay M$n fails closed: $(echo "$e" | cut -c1-120)" || bad "replay M$n did not fail closed: $e"
  [ "$(fp $C)" = "$F9" ] || bad "failed replay of M$n changed the catalog"
done
say "   catalog unchanged after every failed replay"

# ------------------------------------------------------------------------------------------------ flow A
say "== flow A: M9 rollback refused once an archive audit event exists"
C=nsi-i2-lifecycle-a; newdb $C; for n in 1 2 3 4 5 6 7 8 9; do apply $C $n || exit 1; done
FA=$(fp $C)
docker exec -i $C psql -U postgres -q -c "insert into public.studios (id,name,slug) values ('a5400000-0000-0000-0000-00000000000a','LC','lc-a'); select intake_private.audit_write('a5400000-0000-0000-0000-00000000000a','template_archived','staff',null,'studio_owner',null,null,null,null,null,'{}'::jsonb,'operational');" >/dev/null 2>&1
e=$(rollback $C 9); echo "$e" | grep -q "refused" && say "   refused: $(echo "$e" | cut -c1-100)" || bad "M9 rollback not refused: $e"
FA2=$(fp $C); [ "$FA" = "$FA2" ] && say "   refused rollback left the catalog unchanged" || bad "refused M9 rollback changed the catalog"

# ------------------------------------------------------------------------------------------------ flow B
say "== flow B: M8 rollback refused with a default-template selection; M7 rollback refused once a grant exists"
C=nsi-i2-lifecycle-b; newdb $C; for n in 1 2 3 4 5 6 7 8 9; do apply $C $n || exit 1; done
e=$(rollback $C 9); [ -n "$e" ] && bad "rollback M9 in flow B: $e"
FB8=$(fp $C)
docker exec -i $C psql -U postgres -q -c "insert into public.studios (id,name,slug) values ('a5400000-0000-0000-0000-00000000000b','LC','lc-b'); insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('a5400000-0000-0000-0000-00000000000b','private_lesson', null);" >/dev/null 2>&1
e=$(rollback $C 8); echo "$e" | grep -q "refused" && say "   M8 refused: $(echo "$e" | cut -c1-100)" || bad "M8 rollback not refused: $e"
[ "$(fp $C)" = "$FB8" ] && say "   refused M8 rollback left the catalog unchanged" || bad "refused M8 rollback changed the catalog"
docker exec -i $C psql -U postgres -q -c "delete from public.intake_service_assignments where studio_id='a5400000-0000-0000-0000-00000000000b';" >/dev/null 2>&1
docker exec -i $C psql -U postgres -q -c "insert into public.intake_templates (id, studio_id, name) values ('a5400000-0000-0000-0000-000000000c01','a5400000-0000-0000-0000-00000000000b','LC'); insert into public.intake_settings (studio_id, default_template_id) values ('a5400000-0000-0000-0000-00000000000b','a5400000-0000-0000-0000-000000000c01'); insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('a5400000-0000-0000-0000-00000000000b','private_lesson','a5400000-0000-0000-0000-000000000c01'),('a5400000-0000-0000-0000-00000000000b','coaching','a5400000-0000-0000-0000-000000000c01');" >/dev/null 2>&1
e=$(rollback $C 8); echo "$e" | grep -q "not selected all three" && say "   M8 refused while a studio with a default template has deselected a type: $(echo "$e" | cut -c1-90)" || bad "M8 rollback not refused for a partial selection: $e"
[ "$(fp $C)" = "$FB8" ] || bad "refused (partial selection) M8 rollback changed the catalog"
docker exec -i $C psql -U postgres -q -c "insert into public.intake_service_assignments (studio_id, appointment_type, template_id) values ('a5400000-0000-0000-0000-00000000000b','intro_lesson','a5400000-0000-0000-0000-000000000c01');" >/dev/null 2>&1
e=$(rollback $C 8); [ -n "$e" ] && bad "M8 rollback after selecting all three types: $e" || say "   M8 rolled back once all three types were selected explicitly"
FB7=$(fp $C)
docker exec -i $C psql -U postgres -q -c "insert into public.intake_feature_grants (studio_id, capability, reason, granted_by, expires_at) values ('a5400000-0000-0000-0000-00000000000b','config_preview','lifecycle',gen_random_uuid(), now()+interval '5 days');" >/dev/null 2>&1
e=$(rollback $C 7); echo "$e" | grep -q "refused" && say "   M7 refused: $(echo "$e" | cut -c1-100)" || bad "M7 rollback not refused: $e"
[ "$(fp $C)" = "$FB7" ] && say "   refused M7 rollback left the catalog unchanged" || bad "refused M7 rollback changed the catalog"

for c in nsi-i2-lifecycle nsi-i2-lifecycle-a nsi-i2-lifecycle-b; do docker rm -f $c >/dev/null 2>&1; done
say "SUMMARY lifecycle: failures=$fail"
[ "$fail" = "0" ]
