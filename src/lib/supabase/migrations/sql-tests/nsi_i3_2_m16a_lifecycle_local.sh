#!/usr/bin/env bash
# NSI I3-2 (M16a) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   container 1 (LC): M1-M15 -> M16a; suites; suite-level mutation probes; replays and refusals; rollback to M15 exact
#   container 2 (RACE): M1-M16a; M16a races, M15 and M14 races (regression); harness-level probes
# usage: nsi_i3_2_m16a_lifecycle_local.sh <public-schema-dump.sql>
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions 20261118102000_nsi_i3_m13_purge_hardening 20261118103000_nsi_i3_m14_hold_semantics 20261118104000_nsi_i3_m15_minor_determination 20261118105000_nsi_i3_m16a_guardian_attestation)
RB14=20261118103000_nsi_i3_m14_hold_semantics_rollback
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
applyfile() { out=$(docker exec -i "$1" psql -U postgres -q -v ON_ERROR_STOP=1 < "$2" 2>&1 | grep -iE "^ERROR|FATAL" | head -2); [ -n "$out" ] && { echo "$out"; return 1; }; return 0; }
apply() { o=$(applyfile "$1" "$M/${FILES[$(($2-1))]}.sql") || { bad "apply M$2 on $1: $o"; return 1; }; return 0; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$D/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
suite() { r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" "$1" "$2" "$FP" | grep -E "SUITE" | head -1); say "   $3: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$3: $r"; }
legacy() { for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$FP';"; cat "$D/$f.sql"; } | docker exec -i "$1" psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-3000)
    say "   $2 $f: ${r:-<no result>}"; echo "$r" | grep -q "PASS" || bad "$2 $f: $r"; done; }
upto() { local C="$1" n="$2"; newdb "$C"; for i in $(seq 1 "$n"); do apply "$C" "$i" || return 1; done; }

M16F="${FILES[15]}"
RBM16=20261118105000_nsi_i3_m16a_guardian_attestation_rollback
RBM15=20261118104000_nsi_i3_m15_minor_determination_rollback
EXPECT15="${NSI_EXPECT15:-3fc0eea416e8f820856935a2b94d078a|776}"

say "== container LC: M1-M15, then M16a"
C=nsi-i2-m16a; upto $C 15 || exit 1
F15=$(fp $C); say "   fingerprint M15: $F15"; [ "$F15" = "$EXPECT15" ] || bad "M15 fingerprint is not the DEV-applied value ($EXPECT15)"
apply $C 16 || exit 1
F16=$(fp $C); say "   fingerprint M16a: $F16"; [ "$F15" != "$F16" ] || bad "M16a did not change the catalog"
suite $C test_T_nsi_i3_2_m16a_local.sql "M16a boundary suite"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 suite on M16a"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite on M16a"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 suite on M16a"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M16a"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M16a"
legacy $C "M16a"

say "== suite-level mutation probes on M16a (each mutated copy must make the M16a suite FAIL; the good file is re-applied afterwards)"
mutate() { # label sed-expression expected-substring
  sed "$2" "$M/$M16F.sql" > "$TMPD/m16a_mut.sql"
  cmp -s "$M/$M16F.sql" "$TMPD/m16a_mut.sql" && { bad "probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m16a_mut.sql") || { say "   probe $1: mutated file refused by the migration itself: detected"; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_2_m16a_local.sql "$FP" | grep -E "SUITE" | head -1)
  if echo "$r" | grep -q "FAIL" && echo "$r" | grep -q "$3"; then say "   probe $1: detected ($3)"; else bad "probe $1 NOT detected: ${r:0:200}"; fi
  apply $C 16 || true
}
mutate "guard allows any assurance change" "s|or (new.assurance <> old.assurance and not (old.assurance = 'declared_unverified' and new.assurance = 'staff_attested'|or (false and not (old.assurance = 'declared_unverified' and new.assurance = 'staff_attested'|" "A04"
mutate "guard lets assurance_at move alone" "s|     or (new.assurance_at <> old.assurance_at and new.assurance = old.assurance)|     or false|" "A04"
mutate "attestation update allowed" "s|    raise exception 'nsi: guardian attestations are immutable' using errcode = '42501';|    return new;|" "A05"
mutate "attestation insert guard drops the respondent checks" "s|     or p.role <> 'guardian' or p.superseded_at is not null or p.redacted_at is not null then|     or false then|" "A05"
mutate "erase does not delete attestations" "s|  delete from public.intake_guardian_attestations where studio_id = p_studio_id and client_id = p_client_id;||" "A06"
mutate "audit allowlist without method" "s|'case_ref', 'method'];|'case_ref'];|" "A01"
mutate "wrong capability" "s|intake_private.assert_staff(p_studio_id, 'attest')|intake_private.assert_staff(p_studio_id, 'drift_report')|" "A01"
mutate "no gate_closed outcome" "s|  if not intake_private.retention_gate_open() then return 'gate_closed'; end if;|  null;|" "A02"
mutate "no not_open outcome" "s|     and not (q.status = 'submitted' and intake_private.fulfillment_state(q.id) = 'guardian_consent_outstanding') then|     and false then|" "A02"
mutate "no already_done outcome" "s|  if p.assurance <> 'declared_unverified' then return 'already_done'; end if;|  null;|" "A02"
mutate "submitted-with-consent-outstanding refused" "s|     and not (q.status = 'submitted' and intake_private.fulfillment_state(q.id) = 'guardian_consent_outstanding') then|     then|" "A07"
[ "$(fp $C)" = "$F16" ] && say "   catalog identical after the probes" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_2_m16a_local.sql "M16a boundary suite after the probes"

say "== replays and refusals on an M16a database"
apply $C 16 && say "   replay M16a ok"; [ "$(fp $C)" = "$F16" ] && say "   fingerprint unchanged by the M16a replay" || bad "M16a replay changed the catalog"
e=$(applyfile $C "$M/${FILES[14]}.sql"); echo "$e" | grep -q "later NSI migration" && say "   M15 replay over M16a refused" || bad "M15 replay over M16a not refused: $e"
e=$(applyfile $C "$R/$RBM15.sql"); echo "$e" | grep -q "later NSI migration" && say "   M15 rollback over M16a refused" || bad "M15 rollback over M16a not refused: $e"
[ "$(fp $C)" = "$F16" ] && say "   refusals left the catalog unchanged" || bad "refusals changed the catalog"
docker exec -i $C psql -U postgres -q -c "create or replace function intake_private.zz_m16b_probe() returns void language sql as \$\$ select 1 -- nsi-body:m16b \$\$;" >/dev/null 2>&1
e=$(applyfile $C "$M/$M16F.sql"); echo "$e" | grep -q "later NSI migration" && say "   M16a replay refused when an m16b marker exists" || bad "M16a replay not refused with an m16b marker: $e"
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "later NSI migration" && say "   M16a rollback refused when an m16b marker exists" || bad "M16a rollback not refused with an m16b marker: $e"
docker exec -i $C psql -U postgres -q -c "drop function intake_private.zz_m16b_probe();" >/dev/null 2>&1

say "== rollback restores M15 exactly; refusals"
RID=a5800000-0000-0000-0000-0000000000e1
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; insert into public.intake_guardian_attestations (studio_id, request_id, client_id, respondent_id, method, relationship, reason, attested_by) values (gen_random_uuid(), '$RID', gen_random_uuid(), '$RID', 'in_person', 'parent', 'x', gen_random_uuid());" >/dev/null 2>&1
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "attestation rows exist" && say "   rollback refused while an attestation row exists" || bad "rollback not refused with an attestation row: $e"
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; delete from public.intake_guardian_attestations where respondent_id = '$RID';" >/dev/null 2>&1
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; insert into public.intake_respondents (id, studio_id, request_id, client_id, role, display_name, declared_relationship, assurance) values ('$RID', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'guardian', 'x', 'parent', 'staff_attested');" >/dev/null 2>&1
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "staff_attested respondents exist" && say "   rollback refused while a staff_attested respondent exists" || bad "rollback not refused with a staff_attested respondent: $e"
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; delete from public.intake_respondents where id = '$RID';" >/dev/null 2>&1
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, retention_state) values (null, 'guardian_attested', 'staff', 'operational', 'pending_policy');" >/dev/null 2>&1
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "guardian_attested audit events exist" && say "   rollback refused while a guardian_attested audit event exists" || bad "rollback not refused with an audit event: $e"
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; delete from public.intake_audit_events where event_type = 'guardian_attested';" >/dev/null 2>&1
[ "$(fp $C)" = "$F16" ] && say "   refused rollbacks left the catalog unchanged" || bad "refused rollbacks changed the catalog"
e=$(applyfile $C "$R/$RBM16.sql") && [ "$(fp $C)" = "$F15" ] && say "   rollback M16a -> M15 fingerprint identical" || bad "rollback M16a: $e (fp $(fp $C))"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 suite after rollback (back on M15)"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite after rollback"
e=$(applyfile $C "$R/$RBM16.sql"); echo "$e" | grep -q "refused" && say "   second rollback refused on an M15 database" || bad "rollback not refused on M15: $e"
apply $C 16; [ "$(fp $C)" = "$F16" ] && say "   re-applied M16a fingerprint identical" || bad "re-apply differs"
docker rm -f $C >/dev/null 2>&1

say "== container RACE: M1-M16a; M16a races, M15 and M14 races (regression), harness-level probes"
C=nsi-i2-m16ar; upto $C 16 || exit 1
r=$(bash "$D/concurrency/nsi_m16a_race_local.sh" $C 0 2>&1 | tail -30); echo "$r" | sed 's/^/   [M16a] /'
echo "$r" | grep -q "SUMMARY m16a races: failures=0" || bad "M16a race harness"
r=$(bash "$D/concurrency/nsi_m15_race_local.sh" $C 100 2>&1 | tail -30); echo "$r" | sed 's/^/   [M15 on M16a] /'
echo "$r" | grep -q "SUMMARY m15 races: failures=0" || bad "M15 race harness on M16a"
r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C fixed 200 2>&1 | tail -22); echo "$r" | sed 's/^/   [M14 on M16a] /'
echo "$r" | grep -q "SUMMARY m14 races (fixed): failures=0" || bad "M14 race harness on M16a"
raceprobe() { # label offset expected-scenario sed-expr
  local label="$1" off="$2" scen="$3" ex="$4"
  sed "$ex" "$M/$M16F.sql" > "$TMPD/m16a_race_mut.sql"
  cmp -s "$M/$M16F.sql" "$TMPD/m16a_race_mut.sql" && { bad "race probe $label: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m16a_race_mut.sql") || { say "   race probe $label: mutated file refused by the migration itself: detected"; return; }
  r=$(bash "$D/concurrency/nsi_m16a_race_local.sh" $C $off 2>&1 | tail -30)
  if echo "$r" | grep -q "SUMMARY m16a races: failures=[1-9]" && echo "$r" | grep -E "FAIL" | grep -q "$scen"; then say "   race probe $label: detected ($scen)"; else bad "race probe $label NOT detected ($scen)"; fi
  apply $C 16 || true
}
raceprobe "attest without lock_client" 300 "A1" '/create or replace function public.intake_attest_guardian/,/^end \$\$;/ s|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|'
raceprobe "attest without the barrier branch after the lock" 400 "B1" "/create or replace function public.intake_attest_guardian/,/^end \\\$\\\$;/ s|    if intake_private.erasure_barrier_active(p_studio_id, v_client) then return 'erasure_barrier'; end if;|    null;|"
raceprobe "attest without the isolation guard" 500 "E1" "/create or replace function public.intake_attest_guardian/,/^end \\\$\\\$;/ s|  if current_setting('transaction_isolation') <> 'read committed' then|  if false then|"
raceprobe "attest without the already_done check (concurrent double attest)" 600 "C1" "s|  if p.assurance <> 'declared_unverified' then return 'already_done'; end if;|  null;|"
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m16a lifecycle: failures=$fail"
[ "$fail" = "0" ]
