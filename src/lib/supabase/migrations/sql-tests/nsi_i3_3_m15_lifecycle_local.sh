#!/usr/bin/env bash
# NSI I3-3 (M15) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   container 1 (LC): M1-M14 -> M15; suites; suite-level mutation probes; replays and refusals; rollback to M14 exact
#   container 2 (RACE): M1-M15; M15 race and lock-order harness; M14 race harness (regression); harness-level probes
# usage: nsi_i3_3_m15_lifecycle_local.sh <public-schema-dump.sql>
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions 20261118102000_nsi_i3_m13_purge_hardening 20261118103000_nsi_i3_m14_hold_semantics 20261118104000_nsi_i3_m15_minor_determination)
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

M15F="${FILES[14]}"
RBM15=20261118104000_nsi_i3_m15_minor_determination_rollback
EXPECT14="${NSI_EXPECT14:-be5a715adedad4197649593d23c6ce09|770}"

say "== container LC: M1-M14, then M15"
C=nsi-i2-m15; upto $C 14 || exit 1
F14=$(fp $C); say "   fingerprint M14: $F14"; [ "$F14" = "$EXPECT14" ] || bad "M14 fingerprint is not the DEV-applied value ($EXPECT14)"
apply $C 15 || exit 1
F15=$(fp $C); say "   fingerprint M15: $F15"; [ "$F14" != "$F15" ] || bad "M15 did not change the catalog"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 boundary suite"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite on M15"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 suite on M15"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M15"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M15"
legacy $C "M15"

say "== suite-level mutation probes on M15 (each mutated copy must make the M15 suite FAIL; the good file is re-applied afterwards)"
mutate() { # label sed-expression expected-substring
  sed "$2" "$M/$M15F.sql" > "$TMPD/m15_mut.sql"
  cmp -s "$M/$M15F.sql" "$TMPD/m15_mut.sql" && { bad "probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m15_mut.sql") || { say "   probe $1: mutated file refused by the migration itself: detected"; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_3_m15_local.sql "$FP" | grep -E "SUITE" | head -1)
  if echo "$r" | grep -q "FAIL" && echo "$r" | grep -q "$3"; then say "   probe $1: detected ($3)"; else bad "probe $1 NOT detected: ${r:0:200}"; fi
  apply $C 15 || true
}
mutate "drop the monotone rule" "s|  if not v_minor and exists (select 1 from public.intake_minor_determinations d where d.request_id = q.id and d.is_minor) then|  if false then|" "N07"
mutate "drop the no-daily-growth rule" "s|l.source = 'birthday' and l.is_minor = v_minor and l.threshold = v_thr then return 'already_current'|false then return 'already_current'|" "N07"
mutate "flip < to <=" "s|intake_private.age_in_years(v_bd, v_local) < v_thr|intake_private.age_in_years(v_bd, v_local) <= v_thr|" "N03"
mutate "drop the birthday sanity bounds" "s|if v_bd is null or v_bd > v_local or v_bd < (v_local - interval '120 years')::date then return 'no_birthday'; end if;|if v_bd is null then return 'no_birthday'; end if;|" "N03"
mutate "drop the threshold clamp" "s|select greatest(coalesce((select s.minor_age_threshold from public.intake_settings s where s.studio_id = p_studio_id), 18), 18) into v_thr;|select coalesce((select s.minor_age_threshold from public.intake_settings s where s.studio_id = p_studio_id), 18) into v_thr;|" "N03"
mutate "drop the time zone fallback" "s|'Etc/GMT+12'|'UTC'|" "N06"
mutate "drop the staff-override stop" "s|if l.id is not null and l.source = 'staff_override' then return 'staff_override_exists'; end if;||" "N07"
mutate "drop the open-request check" "s|  if q.status not in ('pending', 'invited', 'in_progress') then return 'request_not_open'; end if;|  null;|" "N08"
mutate "drop the birthday-first rule in declare" "s|  v_res := public.intake_determine_minor_from_birthday(s.studio_id, q.id);|  v_res := 'no_birthday';|" "N09"
mutate "drop the one-declaration rule" "s|  if exists (select 1 from public.intake_minor_determinations d where d.request_id = q.id) then return 'already_determined'; end if;||" "N09"
mutate "audit without client_ref (determine)" "s|'minor_determination_recorded', 'system', null, null, q.id, q.client_id,|'minor_determination_recorded', 'system', null, null, q.id, null,|" "N10"
mutate "staff provenance not stored on the row" "s|declared_value_class, actor_user_id)|declared_value_class)|;s|p_declared, s.issued_by_user) returning id into v_id;|p_declared) returning id into v_id;|" "N10"
mutate "session state never answers unknown" "s|  if not coalesce(v_found, false) then return 'unknown'; end if;|  if false then return 'unknown'; end if;|" "N11"
mutate "staff read capability wrong" "s|assert_staff(p_studio_id, 'view_status')|assert_staff(p_studio_id, 'minor_override')|" "N12"
mutate "drop the O11 branch" "s|    if v_source = 'declared' then|    if false then|" "N15"
mutate "drop the B2 branch" "s|  if v_found is not true then|  if false then|" "N15"
[ "$(fp $C)" = "$F15" ] && say "   catalog identical after the probes" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_3_m15_local.sql "M15 boundary suite after the probes"

say "== replays and refusals on an M15 database"
apply $C 15 && say "   replay M15 ok"; [ "$(fp $C)" = "$F15" ] && say "   fingerprint unchanged by the M15 replay" || bad "M15 replay changed the catalog"
e=$(applyfile $C "$M/${FILES[13]}.sql"); echo "$e" | grep -q "later NSI migration" && say "   M14 replay over M15 refused" || bad "M14 replay over M15 not refused: $e"
e=$(applyfile $C "$R/$RB14.sql"); echo "$e" | grep -q "refused" && say "   M14 rollback over M15 refused" || bad "M14 rollback over M15 not refused: $e"
[ "$(fp $C)" = "$F15" ] && say "   refusals left the catalog unchanged" || bad "refusals changed the catalog"
docker exec -i $C psql -U postgres -q -c "create or replace function intake_private.zz_m16_probe() returns void language sql as \$\$ select 1 -- nsi-body:m16 \$\$;" >/dev/null 2>&1
e=$(applyfile $C "$M/$M15F.sql"); echo "$e" | grep -q "later NSI migration" && say "   M15 replay refused when an m16 marker exists" || bad "M15 replay not refused with an m16 marker: $e"
e=$(applyfile $C "$R/$RBM15.sql"); echo "$e" | grep -q "later NSI migration" && say "   M15 rollback refused when an m16 marker exists" || bad "M15 rollback not refused with an m16 marker: $e"
docker exec -i $C psql -U postgres -q -c "drop function intake_private.zz_m16_probe();" >/dev/null 2>&1

say "== rollback restores M14 exactly; refusals"
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; insert into public.intake_minor_determinations (studio_id, request_id, is_minor, source, evaluated_on, threshold) values (gen_random_uuid(), 'a5800000-0000-0000-0000-0000000000e1', false, 'birthday', current_date, 18);" >/dev/null 2>&1
e=$(applyfile $C "$R/$RBM15.sql"); echo "$e" | grep -q "determination rows exist" && say "   rollback refused while a birthday row exists" || bad "rollback not refused with a birthday row: $e"
[ "$(fp $C)" = "$F15" ] && say "   refused rollback left the catalog unchanged" || bad "refused rollback changed the catalog"
docker exec -i $C psql -U postgres -q -c "set session_replication_role = replica; delete from public.intake_minor_determinations where request_id = 'a5800000-0000-0000-0000-0000000000e1';" >/dev/null 2>&1
e=$(applyfile $C "$R/$RBM15.sql") && [ "$(fp $C)" = "$F14" ] && say "   rollback M15 -> M14 fingerprint identical" || bad "rollback M15: $e (fp $(fp $C))"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 suite after rollback (back on M14)"
e=$(applyfile $C "$R/$RBM15.sql"); echo "$e" | grep -q "refused" && say "   second rollback refused on an M14 database" || bad "rollback not refused on M14: $e"
apply $C 15; [ "$(fp $C)" = "$F15" ] && say "   re-applied M15 fingerprint identical" || bad "re-apply differs"
docker rm -f $C >/dev/null 2>&1

say "== container RACE: M1-M15; M15 races, M14 races (regression), harness-level probes"
C=nsi-i2-m15r; upto $C 15 || exit 1
r=$(bash "$D/concurrency/nsi_m15_race_local.sh" $C 0 2>&1 | tail -30); echo "$r" | sed 's/^/   [M15] /'
echo "$r" | grep -q "SUMMARY m15 races: failures=0" || bad "M15 race harness"
r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C fixed 100 2>&1 | tail -22); echo "$r" | sed 's/^/   [M14 on M15] /'
echo "$r" | grep -q "SUMMARY m14 races (fixed): failures=0" || bad "M14 race harness on M15"
raceprobe() { # label offset expected-scenario sed-expr
  local label="$1" off="$2" scen="$3" ex="$4"
  sed "$ex" "$M/$M15F.sql" > "$TMPD/m15_race_mut.sql"
  cmp -s "$M/$M15F.sql" "$TMPD/m15_race_mut.sql" && { bad "race probe $label: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m15_race_mut.sql") || { say "   race probe $label: mutated file refused by the migration itself: detected"; return; }
  r=$(bash "$D/concurrency/nsi_m15_race_local.sh" $C $off 2>&1 | tail -30)
  if echo "$r" | grep -q "SUMMARY m15 races: failures=[1-9]" && echo "$r" | grep -E "FAIL" | grep -q "$scen"; then say "   race probe $label: detected ($scen)"; else bad "race probe $label NOT detected ($scen)"; fi
  apply $C 15 || true
}
raceprobe "determine without lock_client" 200 "A1" '/create or replace function public.intake_determine_minor_from_birthday/,/^end \$\$;/ s|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|'
raceprobe "declare without lock_client" 300 "A2b" '/create or replace function public.intake_declare_minor_status/,/^end \$\$;/ s|  perform intake_private.lock_client(s.studio_id, v_client);|  null;|'
raceprobe "determine without the barrier branch after the lock" 400 "B1" "/create or replace function public.intake_determine_minor_from_birthday/,/^end \\\$\\\$;/ s|    if intake_private.erasure_barrier_active(p_studio_id, v_client) then return 'erasure_barrier'; end if;|    null;|"
raceprobe "determine without the isolation guard" 500 "E1" "/create or replace function public.intake_determine_minor_from_birthday/,/^end \\\$\\\$;/ s|  if current_setting('transaction_isolation') <> 'read committed' then|  if false then|"
raceprobe "declare without the after-lock session re-read" 600 "D1" "s|  select \\* into s from public.intake_sessions x where x.session_hash = p_session_hash for update;|  null;|"
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m15 lifecycle: failures=$fail"
[ "$fail" = "0" ]
