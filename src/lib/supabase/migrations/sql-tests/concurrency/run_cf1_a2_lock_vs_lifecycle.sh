#!/usr/bin/env bash
# Competition CF1 A2 -- Lock ballots (entries FOR SHARE, A2 block) vs an entry-lifecycle writer, with a REAL second connection per actor.
#
# Usage: bash run_cf1_a2_lock_vs_lifecycle.sh [container]   (default: cf1-a2-db; needs the chain through HL1, CF1 A1 and A2)
# Needs a superuser (supabase_admin) for fixtures; the actors run as `authenticated` with a JWT sub claim. Fixtures COMMIT and are removed
# at the end, even on failure.
# The lifecycle writer is EMULATED with the lock order of change_competition_entry_lifecycle (design A.3): entry row UPDATE
# (FOR NO KEY UPDATE), then, later in the same transaction, the entry's heat entries UPDATE. (The real RPC refuses an entry on a locked heat
# and every heat here is locked, so the real function cannot be used; trigger side effects are bypassed with replica mode, locks are real.)
#   A  deadlock probe (design U61): writer holds the entry, Lock ballots holds the heat entries and wants the entry (A2's FOR SHARE), the
#      writer then wants the heat entries -> a cycle. Expect exactly ONE victim with SQLSTATE 40P01 (retryable, not P0001), the other
#      session completes, and a clean retry of the Lock ballots succeeds (the round ends ballots_locked with ONE round_state_changed event).
#   B  wait probe: the writer only holds the entry (no heat-entry write) -> Lock ballots WAITS on the entry lock, then succeeds.
# NOTE: a successful lock writes insert-only ballot events, so the fixture event cannot be removed afterwards: run this on a FRESH database (one run per database).
# Prints "CF1 A2 CONCURRENCY PASS (<n> checks)" or "CF1 A2 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-cf1-a2-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUX() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
U() { printf '00000000-0000-0000-0000-c1a2c0%06x' "$((16#$1))"; }
JUDGE1=$(U a1); JUDGE2=$(U a2); JUDGE3=$(U a3); MGR=$(U a0)
EV=$(U e0); STUDIO=$(U 51)
OUT=${TMPDIR:-/tmp}
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

cleanup() {
  SUX -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-c1a2c0%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-c1a2c0%'; delete from auth.users where id::text like '00000000-0000-0000-0000-c1a2c0%';" >/dev/null 2>&1
}
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-a2c-mgr@example.test'),('$JUDGE1','t-a2c-j1@example.test'),('$JUDGE2','t-a2c-j2@example.test'),('$JUDGE3','t-a2c-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'A2C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-c1a2c0%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-c1a2c0%';
insert into public.studios (id, name, slug) values ('$STUDIO','A2C Studio','t-a2c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$JUDGE1','$STUDIO','instructor',true),('$JUDGE2','$STUDIO','instructor',true),('$JUDGE3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','A2C Comp','t-a2c-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$(U 61)','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 62)','$EV','$(U 61)','C','single_dance','pro_am','open');
SQL
for i in 1 2 3; do
SU <<SQL
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$(U 7$i)','$EV','$(U 61)','$(U 62)','D$i','open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values ('$(U 8$i)','$EV','$(U 61)','$(U 7$i)','R$i','final',1,'draft','ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  ('$(U 9${i}1)','$EV','$(U 61)','$(U 7$i)','E${i}1','confirmed','eligible','${i}01'), ('$(U 9${i}2)','$EV','$(U 61)','$(U 7$i)','E${i}2','confirmed','eligible','${i}02');
SQL
done
SU <<SQL
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(U c1)','$EV',1,'v1','published',now());
$(for i in 1 2 3; do echo "insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$(U d$i)','$EV','$(U 7$i)','$(U 8$i)',$i,'$(U 62)','$(U c1)','scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}1)',1),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}2)',2);"; done)
set session_replication_role = origin;
SQL

as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }
SU <<SQL
$(as_user "$MGR")
select public.add_competition_official('$EV','$JUDGE1','judge','$(U f001)');
select public.add_competition_official('$EV','$JUDGE2','judge','$(U f002)');
select public.add_competition_official('$EV','$JUDGE3','judge','$(U f003)');
$(for i in 1 2 3; do echo "select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE1'), 'A', '$(U f1$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE2'), 'B', '$(U f2$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE3'), 'C', '$(U f3$i)');"; done)
SQL
SU -c "set session_replication_role = replica; update public.event_competition_rounds set status='active' where event_id='$EV';"
marks() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"value\":$2},{\"entry_id\":\"$(U 9${1}2)\",\"value\":$3}]'::jsonb"; }
for i in 1 2 3; do
SU <<SQL
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 1 2),'$(U a${i}01)');
$(as_user "$JUDGE2")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 2 1),'$(U a${i}02)');
$(as_user "$JUDGE3")
select public.submit_competition_ballot('$(U 8$i)','$(U d$i)',$(marks $i 1 2),'$(U a${i}03)');
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d$i)','locked','early');
SQL
# the HL1 blocker needs a danced heat (superuser fixture shortcut)
SU -c "set session_replication_role = replica; update public.event_competition_heats set status='complete' where id='$(U d$i)';"
done
now_ms() { date +%s%3N; }
round_state() { SU -c "select status from public.event_competition_rounds where id='$(U $1)'"; }
nevents() { SU -c "select count(*) from public.event_competition_ballot_events where round_id='$(U $1)' and kind='round_state_changed'"; }
ok "setup: both rounds are active with all heats locked and danced" "$([ "$(round_state 81)/$(round_state 82)" = "active/active" ] && echo 1 || echo 0)"

# ------------------------------------------------- Scenario A: deadlock probe (lifecycle order entry -> heat entries vs lock heat entries -> entries)
# a_probe <label> <round-no> <entry-id-suffix> <lock-start-delay-seconds> : the writer takes the entry at t=0 and wants the heat entries at t=W (default 3, 4 for A2).
# With the lock starting at t=1 the writer is the one that completes the cycle (and is the victim); with the lock starting at t=2.5 the lock
# has been waiting on the entry for the least time when the cycle closes... either session may be chosen by Postgres; both outcomes are checked.
a_probe() {
  local L="$1" R="$2" E="$3" D="$4" W="${5:-3}"
  ( SUX <<SQL
begin;
set local session_replication_role = replica;
update public.event_competition_entries set updated_at = now() where id = '$(U $E)';
select pg_sleep($W);
update public.event_competition_heat_entries set updated_at = now() where entry_id = '$(U $E)';
commit;
SQL
  ) > $OUT/a2c_${L}_writer.out 2>&1 &
  local WRITER_PID=$!
  sleep "$D"
  local T0 LOCK_OUT WRITER_OUT RETRY T1
  T0=$(now_ms)
  LOCK_OUT=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 8$R)','$(U b${R}01)');
SQL
)
  T1=$(now_ms); wait $WRITER_PID
  WRITER_OUT=$(cat $OUT/a2c_${L}_writer.out)
  echo "$L: lock took $((T1-T0))ms -> $(echo "$LOCK_OUT" | grep -v '^{"sub"' | head -2 | tr '\n' ' ')"
  echo "$L: writer -> $(echo "$WRITER_OUT" | head -2 | tr '\n' ' ')"
  local LOCK_DEAD WRITER_DEAD
  LOCK_DEAD=$(echo "$LOCK_OUT" | grep -c 'deadlock detected'); WRITER_DEAD=$(echo "$WRITER_OUT" | grep -c 'deadlock detected')
  ok "$L: exactly one deadlock victim (lock=$LOCK_DEAD writer=$WRITER_DEAD)" "$([ $((LOCK_DEAD+WRITER_DEAD)) -eq 1 ] && echo 1 || echo 0)"
  ok "$L: the other session completed without an error" "$([ "$LOCK_DEAD" = 1 ] && { echo "$WRITER_OUT" | grep -qi 'error' && echo 0 || echo 1; } || { echo "$LOCK_OUT" | grep -qi 'error' && echo 0 || echo 1; })"
  ok "$L: the victim error is the retryable deadlock class, not a permanent COMP_ROSTER_* code" "$(echo "$LOCK_OUT $WRITER_OUT" | grep -q 'COMP_ROSTER' && echo 0 || echo 1)"
  if [ "$LOCK_DEAD" = 1 ]; then
    ok "$L: the victimised lock left the round active with no event" "$([ "$(round_state 8$R)/$(nevents 8$R)" = "active/0" ] && echo 1 || echo 0)"
    RETRY=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 8$R)','$(U b${R}01)');
SQL
)
    ok "$L: a clean retry with the same request id succeeds" "$(echo "$RETRY" | grep -q '"replayed": false' && echo 1 || echo 0)"
  fi
  ok "$L: the round ends ballots_locked with exactly one round_state_changed event" "$([ "$(round_state 8$R)/$(nevents 8$R)" = "ballots_locked/1" ] && echo 1 || echo 0)"
  ok "$L: no lock request is left waiting" "$([ "$(SU -c "select count(*) from pg_locks where not granted")" = "0" ] && echo 1 || echo 0)"
}
a_probe A1 1 911 1
a_probe A2 3 931 3 4

# ------------------------------------------------- Scenario B: the lifecycle writer only holds the entry -> Lock ballots waits, then succeeds
( SUX <<SQL
begin;
set local session_replication_role = replica;
update public.event_competition_entries set updated_at = now() where id = '$(U 921)';
select pg_sleep(3);
commit;
SQL
) > $OUT/a2c_b_writer.out 2>&1 &
WRITER_PID=$!
sleep 1
T0=$(now_ms)
LOCK_OUT=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 82)','$(U b201)');
SQL
)
T1=$(now_ms); wait $WRITER_PID
ELAPSED=$((T1-T0))
echo "B: lock took ${ELAPSED}ms -> $(echo "$LOCK_OUT" | head -2 | tr '\n' ' ')"
ok "B: Lock ballots waited on the entry row lock (>=1500ms, was ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1500 ] && echo 1 || echo 0)"
ok "B: and then locked the round" "$(echo "$LOCK_OUT" | grep -q '"replayed": false' && [ "$(round_state 82)" = "ballots_locked" ] && echo 1 || echo 0)"

if [ -z "$FAILS" ]; then echo "CF1 A2 CONCURRENCY PASS ($PASS checks)"; exit 0; fi
echo "CF1 A2 CONCURRENCY FAIL:$FAILS"; exit 1
