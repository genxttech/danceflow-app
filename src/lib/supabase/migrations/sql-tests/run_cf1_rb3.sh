#!/bin/bash
# CF1 RB3 verification runner. LOCAL QA Postgres containers only (never hosted). No Stripe call exists anywhere in it.
#   bash run_cf1_rb3.sh <container_with_R2> [<container_without_R2>]
# Covers RB3 (20270120102000) and RB3R (20270120104000, evidence reconciliation: suite, rollback exactness, refusals, concurrency).
# <container_with_R2>: the CF1 chain through A7 + R2 (20270103090000) applied as the migration user (postgres), RB3 NOT applied.
# <container_without_R2>: the CF1 chain through A7, no R2, RB3 NOT applied (optional; enables the R2-absent identity check).
# Prints one line per step and a final tally. Containers are modified (RB3 applied, rolled back, re-applied): throw them away afterwards.
export MSYS_NO_PATHCONV=1
C=$1; C2=$2
M=$(cd "$(dirname "$0")/.." && pwd); T=$M/sql-tests
MIG=$M/20270120102000_competition_cf1_rb3_refund_evidence.sql
RB=$M/rollback/20270120102000_competition_cf1_rb3_refund_evidence_rollback.sql
MIG2=$M/20270120104000_competition_cf1_rb3_evidence_reconciliation.sql
RB2=$M/rollback/20270120104000_competition_cf1_rb3_evidence_reconciliation_rollback.sql
RB3BODY=c4e51b4094dfb43d92c93935a21f3a7b   # md5 of the RB3 _cf1_entry_refund_evidence_reason body (RB3R rollback must restore exactly this)
pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS  $*"; }
bad() { fail=$((fail+1)); echo "FAIL  $*"; }
ps() { local c=$1 u=$2; shift 2; sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres "$c" psql -U "$u" -h localhost -d postgres -X -q "$@"; }
q()  { echo "$3" | ps "$1" "$2" -At 2>&1; }
verdict() { grep -E "SUITE (PASS|FAIL)" | head -1 | sed 's/^ERROR:  //'; }
ev_md5() { q "$1" postgres "select md5(replace(prosrc, E'\r', '')) from pg_proc where proname='_cf1_entry_refund_evidence_reason' and pronamespace='public'::regnamespace"; }
r3_count() { q "$1" postgres "select count(*) from pg_proc where proname in ('_cf1_rb3_raw','_cf1_rb3_snapshot','_cf1_rb3_release_valid','_cf1_rb3r_guard','_cf1_rb3r_result','request_cf1_refund_evidence_release','cosign_cf1_refund_evidence_release','revoke_cf1_refund_evidence_release','cf1_refund_evidence_state') and pronamespace='public'::regnamespace"; }
body_md5() { q "$1" postgres "select md5(prosrc) from pg_proc where proname='_cf1_entry_unavailable_reason' and pronamespace='public'::regnamespace"; }
fn_count() { q "$1" postgres "select count(*) from pg_proc where proname in ('_cf1_entry_refund_evidence_reason','_cf1_refund_evidence_mode','_cf1_od17_refund_gate','_cf1_rb3_record_gate_override','_cf1_rb3_revoke_gate_override','_cf1_rb3_protect_gate_overrides') and pronamespace='public'::regnamespace"; }
# negative apply: the migration body without its own begin/commit inside an outer transaction that is always rolled back
neg() { # container user setup_sql expected_fragment label
  local out; out=$( { echo "begin;"; echo "$3"; sed '/^begin;$/d;/^commit;$/d' "$MIG"; echo "rollback;"; } | ps "$1" "$2" -v ON_ERROR_STOP=1 2>&1 )
  if echo "$out" | grep -qi "$4"; then ok "$5 (refused: $4)"; else bad "$5 (expected '$4', got: $(echo "$out" | head -2 | tr '\n' ' ' | cut -c1-200))"; fi
}

neg2() { # container user setup_sql expected_fragment label (RB3R migration)
  local out; out=$( { echo "begin;"; echo "$3"; sed '/^begin;$/d;/^commit;$/d' "$MIG2"; echo "rollback;"; } | ps "$1" "$2" -v ON_ERROR_STOP=1 2>&1 )
  if echo "$out" | grep -qi "$4"; then ok "$5 (refused: $4)"; else bad "$5 (expected '$4', got: $(echo "$out" | head -2 | tr '\n' ' ' | cut -c1-200))"; fi
}

echo "== container with R2: $C"
A1MD5=$(body_md5 $C); echo "A1 body md5 (before RB3): $A1MD5"
[ "$(q $C postgres "select to_regclass('public.event_order_refunds') is not null")" = t ] && ok "R2 ledger present before RB3" || bad "R2 ledger missing"
[ "$(fn_count $C)" = 0 ] && ok "no RB3 function before apply" || bad "RB3 already applied"

# 1. apply (postflight runs inside)
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $MIG 2>&1); if echo "$out" | grep -q ERROR; then bad "apply RB3: $(echo "$out" | grep -m1 ERROR)"; else ok "apply RB3 20270120102000 (postflight passed)"; fi
[ "$(q $C postgres "select public._cf1_od17_refund_gate()")" = r2_ledger ] && ok "gate returns r2_ledger" || bad "gate"
# 2. suite
v=$(cat $T/test_T_competition_cf1_rb3_refund_evidence.sql | ps $C supabase_admin 2>&1 | verdict); echo "SUITE (applied): $(echo "$v" | cut -c1-300)"; echo "$v" | grep -q "SUITE PASS" && ok "suite after apply" || bad "suite after apply"
# 3. rollback restores the A1 body exactly
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $RB 2>&1); echo "$out" | grep -q ERROR && bad "rollback: $(echo "$out" | grep -m1 ERROR)" || ok "rollback RB3"
[ "$(body_md5 $C)" = "$A1MD5" ] && ok "rollback restores the A1 body (md5 $A1MD5)" || bad "md5 after rollback $(body_md5 $C) <> $A1MD5"
[ "$(fn_count $C)" = 0 ] && [ "$(q $C postgres "select to_regclass('public.competition_cf1_rb3_gate_overrides') is null")" = t ] && ok "rollback drops every RB3 object" || bad "RB3 objects left after rollback"
[ "$(q $C postgres "select has_function_privilege('anon','public._cf1_entry_unavailable_reason(uuid)','execute') or has_function_privilege('authenticated','public._cf1_entry_unavailable_reason(uuid)','execute')")" = f ] && ok "A1 function still has no anon/authenticated execute after rollback" || bad "grant leak after rollback"
# 4. re-apply + suite again
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $MIG 2>&1); echo "$out" | grep -q ERROR && bad "re-apply: $(echo "$out" | grep -m1 ERROR)" || ok "re-apply RB3"
v=$(cat $T/test_T_competition_cf1_rb3_refund_evidence.sql | ps $C supabase_admin 2>&1 | verdict); echo "SUITE (re-applied): $(echo "$v" | cut -c1-300)"; echo "$v" | grep -q "SUITE PASS" && ok "suite after re-apply" || bad "suite after re-apply"
# the migration cannot be applied twice
neg $C postgres "" "an RB3 function already exists" "second apply on top of RB3"
# 5. negative postflights / preflights (all rolled back)
ps $C postgres -v ON_ERROR_STOP=1 < $RB >/dev/null 2>&1
neg $C postgres "alter table public.event_order_refunds rename column status to status_x;" "does not match what predicate P reads" "postflight: shape mismatch (column renamed)"
neg $C postgres "drop table public.event_competition_refund_exception_scopes cascade;" "only partly present" "preflight: partial R2 ledger"
neg $C supabase_admin "" "not owned by the migration user" "postflight: owner mismatch (applied as another user)"
# Privilege branch of the postflight: a NON-INHERITING migration user that owns the A1 function and sees only some of the R2 tables. The role is created
# inside the always-rolled-back transaction (superuser setup); postgres cannot be used here because it inherits SELECT through pg_read_all_data.
SETUP_NI="create role cf1rb3_ni noinherit bypassrls login; grant usage, create on schema public to cf1rb3_ni; alter function public._cf1_entry_unavailable_reason(uuid) owner to cf1rb3_ni; grant select on public.event_competition_entries, public.event_orders, public.event_registrations to cf1rb3_ni; grant select on public.event_order_refunds, public.event_order_refund_allocations to cf1rb3_ni;"
[ "$(q $C supabase_admin "select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid where m.member = 'postgres'::regrole and r.rolname = 'pg_read_all_data'")" != 0 ] && echo "NOTE postgres inherits pg_read_all_data (why a separate non-inheriting role is used)"
neg $C supabase_admin "$SETUP_NI set local role cf1rb3_ni;" "cannot select public.event_competition_refund_exception_scopes" "postflight: migration user without SELECT on a ledger table (non-inheriting role)"
out=$( { echo "begin;"; echo "$SETUP_NI grant select on public.event_competition_refund_exception_scopes to cf1rb3_ni; set local role cf1rb3_ni;"; sed '/^begin;$/d;/^commit;$/d' "$MIG"; echo "rollback;"; } | ps $C supabase_admin -v ON_ERROR_STOP=1 2>&1 )
echo "$out" | grep -qi "ERROR" && bad "postflight positive control (non-inheriting role with every ledger SELECT): $(echo "$out" | grep -m1 -i ERROR | cut -c1-200)" || ok "postflight positive control: the same non-inheriting role WITH SELECT on all three ledger tables passes"
# 6. final state of the R2 container: applied
ps $C postgres -v ON_ERROR_STOP=1 < $MIG >/dev/null 2>&1 && ok "final re-apply to leave the container in the applied state"

# ---- RB3R (20270120104000) on the R2 container: RB3 is applied here
echo "-- RB3R evidence reconciliation"
[ "$(ev_md5 $C)" = "$RB3BODY" ] && ok "RB3 evidence body matches the pin RB3R requires ($RB3BODY)" || bad "RB3 body pin differs: $(ev_md5 $C)"
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $MIG2 2>&1); if echo "$out" | grep -q ERROR; then bad "apply RB3R: $(echo "$out" | grep -m1 ERROR)"; else ok "apply RB3R 20270120104000 (postflight passed)"; fi
v=$(cat $T/test_T_competition_cf1_rb3r_reconciliation.sql | ps $C supabase_admin 2>&1 | verdict); echo "SUITE RB3R (applied): $(echo "$v" | cut -c1-400)"; echo "$v" | grep -q "SUITE PASS" && ok "RB3R suite after apply" || bad "RB3R suite after apply"
v=$(cat $T/test_T_competition_cf1_rb3_refund_evidence.sql | ps $C supabase_admin 2>&1 | verdict); echo "SUITE RB3 on RB3+RB3R: $(echo "$v" | cut -c1-700)"; echo "$v" | grep -q "SUITE PASS" && ok "unchanged RB3 suite still passes with RB3R applied" || bad "RB3 suite on RB3+RB3R (see line above)"
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $RB2 2>&1); echo "$out" | grep -q ERROR && bad "rollback RB3R: $(echo "$out" | grep -m1 ERROR)" || ok "rollback RB3R"
[ "$(ev_md5 $C)" = "$RB3BODY" ] && ok "RB3R rollback restores the RB3 evidence body exactly (md5 $RB3BODY)" || bad "RB3R rollback md5 $(ev_md5 $C)"
[ "$(r3_count $C)" = 0 ] && [ "$(q $C postgres "select to_regclass('public.competition_cf1_rb3_reconciliations') is null")" = t ] && ok "RB3R rollback drops every RB3R object" || bad "RB3R objects left after rollback"
[ "$(q $C postgres "select public._cf1_od17_refund_gate()")" = r2_ledger ] && [ "$(fn_count $C)" = 6 ] && ok "RB3-only state restored (6 RB3 functions, gate r2_ledger)" || bad "RB3-only state not restored"
neg2 $C postgres "create or replace function public._cf1_entry_refund_evidence_reason(p_entry_id uuid) returns text language sql as 'select null::text';" "not the RB3 definition" "RB3R preflight: RB3 body drifted"
neg2 $C postgres "drop function public._cf1_a6_can_manage(uuid, uuid) cascade;" "_cf1_a6_can_manage / verified_email_for_user is missing" "RB3R preflight: A6 manager helper missing"
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $MIG2 2>&1); echo "$out" | grep -q ERROR && bad "re-apply RB3R: $(echo "$out" | grep -m1 ERROR)" || ok "re-apply RB3R"
v=$(cat $T/test_T_competition_cf1_rb3r_reconciliation.sql | ps $C supabase_admin 2>&1 | verdict); echo "SUITE RB3R (re-applied): $(echo "$v" | cut -c1-400)"; echo "$v" | grep -q "SUITE PASS" && ok "RB3R suite after re-apply" || bad "RB3R suite after re-apply"
neg2 $C postgres "" "not the RB3 definition" "second apply of RB3R on top of RB3R"
# full unwind: RB3R first, then RB3; the A1 predicate body must be exactly the A1 body
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $RB2 2>&1); echo "$out" | grep -q ERROR && bad "unwind: rollback RB3R: $(echo "$out" | grep -m1 ERROR)" || ok "unwind step 1: rollback RB3R"
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $RB 2>&1); echo "$out" | grep -q ERROR && bad "unwind: rollback RB3: $(echo "$out" | grep -m1 ERROR)" || ok "unwind step 2: rollback RB3"
[ "$(body_md5 $C)" = "$A1MD5" ] && [ "$A1MD5" = 021320cddba178e1e36e95b4678d6fa0 ] && ok "after RB3R + RB3 rollback the A1 predicate body md5 is 021320cddba178e1e36e95b4678d6fa0" || bad "A1 md5 after full unwind $(body_md5 $C) (expected 021320cddba178e1e36e95b4678d6fa0, run-start $A1MD5)"
ps $C postgres -v ON_ERROR_STOP=1 < $MIG >/dev/null 2>&1 && ps $C postgres -v ON_ERROR_STOP=1 < $MIG2 >/dev/null 2>&1 && ok "re-apply RB3 then RB3R after the full unwind" || bad "re-apply after full unwind"
# two-session concurrency (commits fixtures: runs last on this container) and rollback refusal while audit rows exist
out=$(CONTAINER=$C DBUSER=postgres bash $T/test_T_competition_cf1_rb3r_concurrency.sh 2>&1); echo "$out" | grep -E "^(PASS|FAIL)|TALLY"; echo "$out" | grep -q "TALLY: 4 passed, 0 failed" && ok "RB3R concurrency script (C1 replay race, C2 + C2b co-sign race, C3 request race)" || bad "RB3R concurrency script: $(echo "$out" | tail -n 3 | tr '\n' ' ' | cut -c1-300)"
out=$(ps $C postgres -v ON_ERROR_STOP=1 < $RB2 2>&1); echo "$out" | grep -q "audit rows exist" && ok "RB3R rollback refuses while reconciliation rows exist" || bad "RB3R rollback did not refuse with rows present: $(echo "$out" | head -n 2 | tr '\n' ' ')"
[ "$(r3_count $C)" = 9 ] && ok "refused RB3R rollback changed nothing (9 RB3R functions present)" || bad "RB3R functions after refused rollback: $(r3_count $C)"

if [ -n "$C2" ]; then
  echo "== container WITHOUT R2: $C2"
  [ "$(q $C2 postgres "select to_regclass('public.event_order_refunds') is null")" = t ] && ok "R2 absent in $C2" || bad "R2 present in $C2"
  A1MD5b=$(body_md5 $C2)
  v1=$(cat $T/test_T_competition_cf1_a1_helpers.sql | ps $C2 supabase_admin 2>&1 | verdict); echo "A1 SUITE before RB3 (baseline, fails on this chain for reasons unrelated to RB3): $(echo "$v1" | cut -c1-160)"
  out=$(ps $C2 postgres -v ON_ERROR_STOP=1 < $MIG 2>&1); echo "$out" | grep -q ERROR && bad "apply RB3 without R2: $(echo "$out" | grep -m1 ERROR)" || ok "apply RB3 without R2 (notice: $(echo "$out" | grep -m1 -o 'R2 ledger absent' ))"
  v2=$(cat $T/test_T_competition_cf1_a1_helpers.sql | ps $C2 supabase_admin 2>&1 | verdict); echo "A1 SUITE after RB3:  $(echo "$v2" | cut -c1-160)"
  [ -n "$v1" ] && [ "$v1" = "$v2" ] && ok "unchanged A1 suite gives the identical verdict before and after RB3 without R2" || bad "A1 suite verdicts differ"
  [ "$(q $C2 postgres "select public._cf1_refund_evidence_mode()")" = absent ] && ok "mode absent" || bad "mode"
  out=$(q $C2 postgres "select public._cf1_od17_refund_gate()"); echo "$out" | grep -q "CF1_RB3_REFUND_EVIDENCE_GATE" && ok "gate refuses without R2 and without override" || bad "gate: $out"
  q $C2 postgres "select public._cf1_rb3_record_gate_override('absent','owner (qa fixture)','qa fixture acceptance of the absent false negative')" >/dev/null
  [ "$(q $C2 postgres "select public._cf1_od17_refund_gate()")" = "override:absent" ] && ok "gate passes with an explicit override" || bad "gate override"
  # RB3R without R2: no behaviour change
  out=$(ps $C2 postgres -v ON_ERROR_STOP=1 < $MIG2 2>&1); echo "$out" | grep -q ERROR && bad "apply RB3R without R2: $(echo "$out" | grep -m1 ERROR)" || ok "apply RB3R without R2"
  v3=$(cat $T/test_T_competition_cf1_a1_helpers.sql | ps $C2 supabase_admin 2>&1 | verdict); echo "A1 SUITE after RB3 + RB3R: $(echo "$v3" | cut -c1-160)"
  [ -n "$v1" ] && [ "$v1" = "$v3" ] && ok "unchanged A1 suite gives the identical verdict with RB3 + RB3R and no R2" || bad "A1 suite verdict differs with RB3R"
  [ "$(q $C2 postgres "select public._cf1_od17_refund_gate()")" = "override:absent" ] && ok "RB3R does not change the RB3 gate (override:absent)" || bad "gate after RB3R without R2"
  [ "$(q $C2 postgres "select (public._cf1_rb3_raw(gen_random_uuid())).reason is null")" = t ] && ok "RB3R raw classifier is inert without R2" || bad "raw classifier without R2"
  out=$(ps $C2 postgres -v ON_ERROR_STOP=1 < $RB2 2>&1); echo "$out" | grep -q ERROR && bad "rollback RB3R without R2: $(echo "$out" | grep -m1 ERROR)" || ok "rollback RB3R without R2"
  out=$(ps $C2 postgres -v ON_ERROR_STOP=1 < $RB 2>&1); echo "$out" | grep -q ERROR && bad "rollback without R2: $(echo "$out" | grep -m1 ERROR)" || ok "rollback without R2"
  [ "$(body_md5 $C2)" = "$A1MD5b" ] && ok "rollback without R2 restores the A1 body (md5 $A1MD5b)" || bad "md5 without R2"
fi
echo "RUNNER TALLY: $pass passed, $fail failed"
[ $fail = 0 ]
