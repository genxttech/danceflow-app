#!/usr/bin/env bash
# Competition HL1 -- heat reopen vs Lock ballots, with a REAL second database connection per actor.
#
# Usage: bash run_hl1_reopen_vs_lock_ballots.sh [container]   (default: f2-clean-4; needs 10A..10D, E1, E2, O1, F2 and 20270119090000)
# Needs a superuser (supabase_admin) for fixtures; the actors run as `authenticated` with a JWT sub claim. Fixtures COMMIT (a second
# connection cannot see an open transaction) and are removed at the end, even on failure.
#   A  a heat reopen is in flight (uncommitted, holds the round row FOR SHARE) when the manager runs Lock ballots
#        -> Lock ballots WAITS for the reopen, then sees the heat open and refuses (COMP_BALLOTS_HEATS_NOT_LOCKED); the round stays active
#   B  a round-lock write is in flight (round row FOR UPDATE, status ballots_locked, uncommitted) when a manager reopens a locked heat
#        -> the reopen WAITS, then is REFUSED (COMP_HL1_REOPEN_ROUND_LOCKED); the heat stays locked
#      (B simulates the write lock_competition_round_ballots ends with: a real Lock ballots cannot commit here because the heat is
#       undanced, and a danced heat cannot be reopened, so the real functions can never both succeed.)
# Prints "HL1 CONCURRENCY PASS (<n> checks)" or "HL1 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-f2-clean-4}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUX() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
U() { printf '00000000-0000-0000-0000-e1f0e1%06x' "$((16#$1))"; }
JUDGE1=$(U a1); JUDGE2=$(U a2); JUDGE3=$(U a3); MGR=$(U a0)
EV=$(U e0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

cleanup() {
  SUX -c "set session_replication_role = replica; update public.event_competition_heats set lock_state = 'open' where event_id = '$EV'; reset session_replication_role;" >/dev/null 2>&1
  SUX -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-e1f0e1%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-e1f0e1%'; delete from auth.users where id::text like '00000000-0000-0000-0000-e1f0e1%';" >/dev/null 2>&1
}
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-hl1c-mgr@example.test'),('$JUDGE1','t-hl1c-j1@example.test'),('$JUDGE2','t-hl1c-j2@example.test'),('$JUDGE3','t-hl1c-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'HL1C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-e1f0e1%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-e1f0e1%';
insert into public.studios (id, name, slug) values ('$STUDIO','HL1C Studio','t-hl1c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$JUDGE1','$STUDIO','instructor',true),('$JUDGE2','$STUDIO','instructor',true),('$JUDGE3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','HL1C Comp','t-hl1c-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$(U 61)','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 62)','$EV','$(U 61)','C','single_dance','pro_am','open');
SQL
for i in 1 2; do
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
$(for i in 1 2; do echo "insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$(U d$i)','$EV','$(U 7$i)','$(U 8$i)',$i,'$(U 62)','$(U c1)','scheduled');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}1)',1),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}2)',2);"; done)
set session_replication_role = origin;
SQL

as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }
SU <<SQL
$(as_user "$MGR")
select public.add_competition_official('$EV','$JUDGE1','judge','$(U f001)');
select public.add_competition_official('$EV','$JUDGE2','judge','$(U f002)');
select public.add_competition_official('$EV','$JUDGE3','judge','$(U f003)');
$(for i in 1 2; do echo "select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE1'), 'A', '$(U f1$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE2'), 'B', '$(U f2$i)');
select public.assign_competition_panel_member('$(U 8$i)', (select id from public.event_competition_officials where event_id='$EV' and user_id='$JUDGE3'), 'C', '$(U f3$i)');"; done)
SQL
SU -c "set session_replication_role = replica; update public.event_competition_rounds set status='active' where event_id='$EV';"
# Both heats are locked early (scheduled, undanced): the HL1 early-lock path.
SU <<SQL
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d1)','locked','early');
select public.set_competition_heat_lock_state('$(U d2)','locked','early');
SQL
marks() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"value\":$2},{\"entry_id\":\"$(U 9${1}2)\",\"value\":$3}]'::jsonb"; }
now_ms() { date +%s%3N; }
heat_state() { SU -c "select lock_state from public.event_competition_heats where id='$(U $1)'"; }
round_state() { SU -c "select status from public.event_competition_rounds where id='$(U $1)'"; }

# Round 1 ballots (so the only Lock ballots blocker left is the heat state).
SU <<SQL
$(as_user "$JUDGE1")
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks 1 1 2),'$(U a101)');
$(as_user "$JUDGE2")
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks 1 2 1),'$(U a102)');
$(as_user "$JUDGE3")
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks 1 1 2),'$(U a103)');
SQL
ok "setup: heats are locked and the round is active" "$([ "$(heat_state d1)/$(round_state 81)" = "locked/active" ] && echo 1 || echo 0)"

# ------------------------------------------------- Scenario A: Lock ballots waits for an in-flight reopen
( SUX <<SQL
$(as_user "$MGR")
begin;
select public.set_competition_heat_lock_state('$(U d1)','open','locked by mistake');
select pg_sleep(4);
commit;
SQL
) > /tmp/hl1c_a_reopen.out 2>&1 &
REOPEN_PID=$!
sleep 1.5
T0=$(now_ms)
LOCK_OUT=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 81)','$(U a104)');
SQL
)
T1=$(now_ms); wait $REOPEN_PID
ELAPSED=$((T1-T0))
echo "A: Lock ballots took ${ELAPSED}ms -> $(echo "$LOCK_OUT" | head -2 | tr '\n' ' ')"
ok "A: the reopen committed" "$([ "$(heat_state d1)" = "open" ] && echo 1 || echo 0)"
ok "A: Lock ballots waited for the in-flight reopen (>=1800ms, was ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1800 ] && echo 1 || echo 0)"
ok "A: Lock ballots then saw the open heat and refused" "$(echo "$LOCK_OUT" | grep -q 'COMP_BALLOTS_HEATS_NOT_LOCKED' && echo 1 || echo 0)"
ok "A: the round stayed active" "$([ "$(round_state 81)" = "active" ] && echo 1 || echo 0)"

# ------------------------------------------------- Scenario B: reopen waits for an in-flight round lock, then is refused
( SUX <<SQL
begin;
set local session_replication_role = replica;
select 1 from public.event_competition_rounds where id = '$(U 82)' for update;
update public.event_competition_rounds set status = 'ballots_locked', updated_at = now() where id = '$(U 82)';
select pg_sleep(4);
commit;
SQL
) > /tmp/hl1c_b_lock.out 2>&1 &
LOCK_PID=$!
sleep 1.5
T0=$(now_ms)
REOPEN_OUT=$(SUX <<SQL 2>&1
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d2)','open','late reopen');
SQL
)
T1=$(now_ms); wait $LOCK_PID
ELAPSED=$((T1-T0))
echo "B: reopen took ${ELAPSED}ms -> $(echo "$REOPEN_OUT" | head -2 | tr '\n' ' ')"
ok "B: the round lock committed" "$([ "$(round_state 82)" = "ballots_locked" ] && echo 1 || echo 0)"
ok "B: the reopen waited for the in-flight round lock (>=1800ms, was ${ELAPSED}ms)" "$([ "$ELAPSED" -ge 1800 ] && echo 1 || echo 0)"
ok "B: the reopen was refused as round locked" "$(echo "$REOPEN_OUT" | grep -q 'COMP_HL1_REOPEN_ROUND_LOCKED' && echo 1 || echo 0)"
ok "B: the heat stayed locked" "$([ "$(heat_state d2)" = "locked" ] && echo 1 || echo 0)"

if [ -z "$FAILS" ]; then echo "HL1 CONCURRENCY PASS ($PASS checks)"; exit 0; fi
echo "HL1 CONCURRENCY FAIL:$FAILS"; exit 1
