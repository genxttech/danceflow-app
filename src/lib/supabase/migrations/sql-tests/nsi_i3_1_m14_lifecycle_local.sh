#!/usr/bin/env bash
# NSI I3-1 (M14) lifecycle harness. LOCAL DISPOSABLE CONTAINERS ONLY (nsi-i2-*). Builds its own containers.
#   container 1 (LC):   M1-M13 -> M14; suites; suite-level mutation probes; rollback to M13 exact; refusals; re-apply; replay; concurrency C1-C7
#   container 2 (RACE): M1-M13; race harness EXPECT=bug (the defects must REPRODUCE); M14; race harness EXPECT=fixed; harness-level probes
# usage: nsi_i3_1_m14_lifecycle_local.sh <public-schema-dump.sql>
set -u
PUB="${1:?schema dump}"
D="$(cd "$(dirname "$0")" && pwd)"; M="$D/.."; R="$M/rollback"
TMPD="${TMPDIR:-/tmp}"
FP="${NSI_APPT_FP:-ff651a6c438d40a001e52ef1625c9043}"
FILES=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions 20261118095000_nsi_i2_eligibility_preview 20261118096000_nsi_i2_m7_pilot_grants 20261118097000_nsi_i2_m8_lesson_types_simulation 20261118098000_nsi_i2_m9_template_archiving 20261118099000_nsi_i2_m10_ensure_request_evaluator 20261118100000_nsi_i2_m11_ensure_request_hardening 20261118101000_nsi_i3_m12_invitations_sessions 20261118102000_nsi_i3_m13_purge_hardening 20261118103000_nsi_i3_m14_hold_semantics)
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

say "== container LC: M1-M13, then M14"
C=nsi-i2-m14; upto $C 13 || exit 1
F13=$(fp $C); say "   fingerprint M13: $F13"
apply $C 14 || exit 1
F14=$(fp $C); say "   fingerprint M14: $F14"; [ "$F13" != "$F14" ] || bad "M14 did not change the catalog"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 boundary suite"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 suite on M14"
suite $C test_T_nsi_i3_1_local.sql "M12 suite on M14"
suite $C test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on M14"
legacy $C "M14"

say "== suite-level mutation probes on M14 (each mutated copy must make the M14 suite FAIL; the good file is re-applied afterwards)"
mutate() { # label sed-expression expected-substring
  sed "$2" "$M/${FILES[13]}.sql" > "$TMPD/m14_mut.sql"
  cmp -s "$M/${FILES[13]}.sql" "$TMPD/m14_mut.sql" && { bad "probe $1: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m14_mut.sql") || { say "   probe $1: mutated file refused by the migration itself: detected"; return; }
  r=$(LINES_OUT=2 "$D/run_i2_m7_m9_local.sh" $C test_T_nsi_i3_1_m14_local.sql "$FP" | grep -E "SUITE" | head -1)
  if echo "$r" | grep -q "FAIL" && echo "$r" | grep -q "$3"; then say "   probe $1: detected ($3)"; else bad "probe $1 NOT detected: ${r:0:200}"; fi
  apply $C 14 || true
}
mutate "hold check honors effective_at again" 's|and h.client_ref = p_client_id and h.released_at is null);|and h.client_ref = p_client_id and h.released_at is null and h.effective_at <= now());|' "T01"
mutate "delete guard skips the hold check" 's|  if intake_private.client_has_active_hold(v_studio, v_client) then|  if false then|' "T04"
mutate "delete guard allows an unresolvable subject" "s|    raise exception 'nsi: delete refused: the subject of this row cannot be resolved' using errcode = '42501';|    return old;|" "T03"
mutate "purge does not pre-filter held clients" 's|    where not intake_private.client_has_active_hold(c.sid, c.cid)|    where true|' "T07"
mutate "hold creation allowed for an erased client's request" 's|  if intake_private.erasure_barrier_active(p_studio_id, v_client) then|  if false then|' "T05"
mutate "revoke_session audit without client_ref" "s|s.request_id, (select q.client_id from public.intake_requests q where q.id = s.request_id), 'intake_session', s.id|s.request_id, null, 'intake_session', s.id|" "T06"
[ "$(fp $C)" = "$F14" ] && say "   catalog identical after the probes" || bad "catalog differs after the probes"
suite $C test_T_nsi_i3_1_m14_local.sql "M14 boundary suite after the probes"

say "== rollback restores M13 exactly; refusals"
e=$(applyfile $C "$R/$RB14.sql") && [ "$(fp $C)" = "$F13" ] && say "   rollback M14 -> M13 fingerprint identical" || bad "rollback M14: $e"
suite $C test_T_nsi_i3_1_m13_local.sql "M13 suite after rollback (back on M13)"
e=$(applyfile $C "$R/$RB14.sql"); echo "$e" | grep -q "refused" && say "   second rollback refused on an M13 database" || bad "rollback not refused on M13: $e"
apply $C 14; [ "$(fp $C)" = "$F14" ] && say "   re-applied M14 fingerprint identical" || bad "re-apply differs"
# rollback refused while a hold row exists
docker exec -i $C psql -U postgres -q -c "insert into public.studios (id,name,slug) values ('a5800000-0000-0000-0000-0000000000f1','LC','lc-m14') on conflict do nothing; insert into public.clients (id, studio_id, first_name, last_name) values ('a5800000-0000-0000-0000-0000000000f2','a5800000-0000-0000-0000-0000000000f1','C','H') on conflict do nothing; set session_replication_role = replica; insert into public.profiles (id) values ('a5800000-0000-0000-0000-0000000000f3') on conflict do nothing; insert into public.intake_legal_holds (studio_id, scope_type, scope_ref, client_ref, reason, retention_basis, review_due_at, created_by) values ('a5800000-0000-0000-0000-0000000000f1','client','a5800000-0000-0000-0000-0000000000f2','a5800000-0000-0000-0000-0000000000f2','x','x', now() + interval '30 days', 'a5800000-0000-0000-0000-0000000000f3');" >/dev/null 2>&1
e=$(applyfile $C "$R/$RB14.sql"); echo "$e" | grep -qE "refused: (legal hold rows exist|the retention gate is open)" && say "   rollback refused while a hold row exists or the gate is open: $(echo "$e" | cut -c1-90)" || bad "rollback not refused with a hold row: $e"
[ "$(fp $C)" = "$F14" ] && say "   refused rollback left the catalog unchanged" || bad "refused rollback changed the catalog"
say "== replays on an M14 database"
apply $C 14 && say "   replay M14 ok"; [ "$(fp $C)" = "$F14" ] && say "   fingerprint unchanged by the M14 replay" || bad "M14 replay changed the catalog"
say "== concurrency harness C1-C7 on the M14 container (commits fixtures; runs last)"
r=$(bash "$D/concurrency/nsi_i3_1_concurrency_local.sh" $C 8 2>&1 | tail -18); echo "$r" | sed 's/^/   /'
echo "$r" | grep -q "SUMMARY concurrency M12: failures=0 deadlocks=0" || bad "concurrency harness"
docker rm -f $C >/dev/null 2>&1

say "== container RACE: the defects must reproduce on M13, and be gone on M14"
C=nsi-i2-m14r; upto $C 13 || exit 1
r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C bug 0 2>&1 | tail -22); echo "$r" | sed 's/^/   [M13] /'
echo "$r" | grep -q "SUMMARY m14 races (bug): failures=0" || bad "race harness on M13 did not reproduce every defect"
apply $C 14 || exit 1
r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C fixed 100 2>&1 | tail -22); echo "$r" | sed 's/^/   [M14] /'
echo "$r" | grep -q "SUMMARY m14 races (fixed): failures=0" || bad "race harness on M14"
say "== harness-level mutation probes (the M14 race harness must FAIL on each mutated copy)"
raceprobe() { # label offset sed-expr...
  local label="$1" off="$2"; shift 2
  cp "$M/${FILES[13]}.sql" "$TMPD/m14_race_mut.sql"
  for ex in "$@"; do sed -i "$ex" "$TMPD/m14_race_mut.sql"; done
  cmp -s "$M/${FILES[13]}.sql" "$TMPD/m14_race_mut.sql" && { bad "race probe $label: the mutation changed nothing"; return; }
  o=$(applyfile $C "$TMPD/m14_race_mut.sql") || { say "   race probe $label: mutated file refused by the migration itself: detected"; return; }
  r=$(bash "$D/concurrency/nsi_m14_race_local.sh" $C fixed $off 2>&1 | tail -22)
  if echo "$r" | grep -q "SUMMARY m14 races (fixed): failures=[1-9]"; then say "   race probe $label: detected ($(echo "$r" | grep -E 'FAIL' | head -1 | cut -c1-70))"; else bad "race probe $label NOT detected"; fi
  apply $C 14 || true
}
raceprobe "isolation guard removed from lock_client" 200 '/create or replace function intake_private.lock_client/,/^end \$\$;/ s|  if current_setting(.transaction_isolation.) <> .read committed. then|  if false then|'
raceprobe "delete guard without the try-lock" 300 's|  if not intake_private.try_lock_client(v_studio, v_client) then|  if false then|'
raceprobe "hold insert without any client lock (trigger and RPC)" 400 's|  perform intake_private.lock_client(new.studio_id, new.client_ref);|  null;|' '/create or replace function public.intake_create_legal_hold/,/^end \$\$;/ s|  perform intake_private.lock_client(p_studio_id, v_client);|  null;|'
raceprobe "hold check honors effective_at again" 500 's|and h.client_ref = p_client_id and h.released_at is null);|and h.client_ref = p_client_id and h.released_at is null and h.effective_at <= now());|'
docker rm -f $C >/dev/null 2>&1
say "SUMMARY m14 lifecycle: failures=$fail"
[ "$fail" = "0" ]
