#!/usr/bin/env bash
# Competition NS1 -- no-show vs ballot submit / lock races, with a REAL second database connection per actor.
#
# Usage: bash run_ns1_races.sh [container]   (default: ns1-db; the DB must have 10A..10D, E1, O1, E2, REG, F2 and NS1 applied)
# Needs a superuser (supabase_admin) for fixtures only; actors run as `authenticated` with a JWT sub claim. Fixtures COMMIT (a
# second connection cannot see an open transaction) and are removed by deleting the event at the end, even on failure.
#   A  a no-show is in flight (uncommitted)  when a judge submits a ballot over the OLD entry set -> the submit WAITS, then is refused
#   B  a ballot submit is in flight          when the manager marks a no-show                    -> the mark WAITS, then succeeds; the ballot is STALE
#   C  the lock is in flight                 when the manager marks a no-show                    -> the mark WAITS, then is refused (window closed)
#   D  a no-show is in flight                when the manager locks                              -> the lock WAITS, then is refused STALE
# Prints "NS1 CONCURRENCY PASS (<n> checks)" or "NS1 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-ns1-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
U() { printf '00000000-0000-0000-0000-a51ff3%06x' "$((16#$1))"; }
J1=$(U a1); J2=$(U a2); J3=$(U a3); MGR=$(U a0)
EV=$(U e0); STUDIO=$(U 51)
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
OUTDIR="${TMPDIR:-/tmp}"

cleanup() {
  SU -c "set session_replication_role = replica; update public.event_competition_heats set lock_state = 'open' where event_id = '$EV'; reset session_replication_role;" >/dev/null 2>&1
  SU -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-a51ff3%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-a51ff3%'; delete from auth.users where id::text like '00000000-0000-0000-0000-a51ff3%';" >/dev/null 2>&1
}
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-ns1c-mgr@example.test'),('$J1','t-ns1c-j1@example.test'),('$J2','t-ns1c-j2@example.test'),('$J3','t-ns1c-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'NS1C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-a51ff3%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-a51ff3%';
insert into public.studios (id, name, slug) values ('$STUDIO','NS1C Studio','t-ns1c-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$J1','$STUDIO','instructor',true),('$J2','$STUDIO','instructor',true),('$J3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','NS1C Comp','t-ns1c-e','competition', current_date+30, current_date+30,'published','public',true);
insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status)
  values ('$(U 61)','$EV','$STUDIO','P','country','relative','skating','configured');
insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values ('$(U 62)','$EV','$(U 61)','C','single_dance','pro_am','open');
SQL
for i in 1 2 3 4; do
SU <<SQL
insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values ('$(U 7$i)','$EV','$(U 61)','$(U 62)','D$i','open');
insert into public.event_competition_rounds (id, event_id, program_id, division_id, name, round_type, sequence_number, status, scoring_method)
  values ('$(U 8$i)','$EV','$(U 61)','$(U 7$i)','R$i','final',1,'draft','ordinal_majority');
insert into public.event_competition_entries (id, event_id, program_id, division_id, display_name, status, eligibility_status, entry_number) values
  ('$(U 9${i}1)','$EV','$(U 61)','$(U 7$i)','E${i}1','confirmed','eligible','${i}01'), ('$(U 9${i}2)','$EV','$(U 61)','$(U 7$i)','E${i}2','confirmed','eligible','${i}02'),
  ('$(U 9${i}3)','$EV','$(U 61)','$(U 7$i)','E${i}3','confirmed','eligible','${i}03');
SQL
done
SU <<SQL
set session_replication_role = replica;
insert into public.event_competition_schedule_versions (id, event_id, version_number, name, status, published_at) values ('$(U c1)','$EV',1,'v1','published',now());
$(for i in 1 2 3 4; do echo "insert into public.event_competition_heats (id, event_id, division_id, round_id, heat_number, contest_id, schedule_version_id, status) values ('$(U d$i)','$EV','$(U 7$i)','$(U 8$i)',$i,'$(U 62)','$(U c1)','active');
insert into public.event_competition_heat_entries (event_id, division_id, heat_id, entry_id, floor_order) values ('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}1)',1),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}2)',2),('$EV','$(U 7$i)','$(U d$i)','$(U 9${i}3)',3);"; done)
set session_replication_role = origin;
SQL

as_user() { echo "set role authenticated; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, false);"; }
OFF() { echo "(select id from public.event_competition_officials where event_id='$EV' and user_id='$1')"; }
SU <<SQL
$(as_user "$MGR")
select public.add_competition_official('$EV','$J1','judge','$(U f001)');
select public.add_competition_official('$EV','$J2','judge','$(U f002)');
select public.add_competition_official('$EV','$J3','judge','$(U f003)');
$(for i in 1 2 3 4; do echo "select public.assign_competition_panel_member('$(U 8$i)', $(OFF $J1), 'A', '$(U f1$i)');
select public.assign_competition_panel_member('$(U 8$i)', $(OFF $J2), 'B', '$(U f2$i)');
select public.assign_competition_panel_member('$(U 8$i)', $(OFF $J3), 'C', '$(U f3$i)');"; done)
SQL
SU -c "set session_replication_role = replica; update public.event_competition_rounds set status='active' where event_id='$EV';"
HE() { echo "(select id from public.event_competition_heat_entries where heat_id='$(U d$1)' and entry_id='$(U 9${1}$2)')"; }
marks3() { echo "'[{\"entry_id\":\"$(U 9${1}1)\",\"value\":$2},{\"entry_id\":\"$(U 9${1}2)\",\"value\":$3},{\"entry_id\":\"$(U 9${1}3)\",\"value\":$4}]'::jsonb"; }
now_ms() { date +%s%3N; }
stale_count() { SU -c "select jsonb_array_length(public._compe2_round_blockers('$(U 8$1)') -> 'stale_ballots')"; }

# ------------------------------------------------------------- A: submit waits for an in-flight no-show
( SU <<SQL
$(as_user "$MGR")
begin;
select public.mark_competition_heat_no_show($(HE 1 3), 'race A', '$(U a001)');
select pg_sleep(4);
commit;
SQL
) > "$OUTDIR/ns1c_a_mark.out" 2>&1 &
PID=$!
sleep 1.5
T0=$(now_ms)
OUT=$(SU <<SQL 2>&1
$(as_user "$J1")
select public.submit_competition_ballot('$(U 81)','$(U d1)',$(marks3 1 1 2 3),'$(U a101)');
SQL
)
T1=$(now_ms); wait $PID; EL=$((T1-T0))
echo "A: submit took ${EL}ms -> $OUT"
ok "A: submit waited for the in-flight no-show (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "A: the old-set (3 mark) ballot was refused" $(echo "$OUT" | grep -q 'COMP_' && echo 1 || echo 0)
ok "A: no ballot persisted" $([ "$(SU -c "select count(*) from public.event_competition_ballots where round_id='$(U 81)'")" = "0" ] && echo 1 || echo 0)

# ------------------------------------------------------------- B: mark waits for an in-flight submit; the ballot becomes stale
( SU <<SQL
$(as_user "$J1")
begin;
select public.submit_competition_ballot('$(U 82)','$(U d2)',$(marks3 2 1 2 3),'$(U b101)');
select pg_sleep(4);
commit;
SQL
) > "$OUTDIR/ns1c_b_submit.out" 2>&1 &
PID=$!
sleep 1.5
T0=$(now_ms)
OUT=$(SU <<SQL 2>&1
$(as_user "$MGR")
select public.mark_competition_heat_no_show($(HE 2 3), 'race B', '$(U b001)');
SQL
)
T1=$(now_ms); wait $PID; EL=$((T1-T0))
echo "B: mark took ${EL}ms -> $OUT"
ok "B: mark waited for the in-flight submit (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "B: mark succeeded" $(echo "$OUT" | grep -q '"no_show_id"' && echo 1 || echo 0)
ok "B: the earlier 3-mark ballot is now stale (fail closed)" $([ "$(stale_count 2)" = "1" ] && echo 1 || echo 0)

# ------------------------------------------------------------- C: mark waits for an in-flight lock, then is refused
SU <<SQL
$(as_user "$J1")
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks3 3 1 2 3),'$(U c101)');
$(as_user "$J2")
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks3 3 2 1 3),'$(U c102)');
$(as_user "$J3")
select public.submit_competition_ballot('$(U 83)','$(U d3)',$(marks3 3 1 3 2),'$(U c103)');
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d3)','locked','race C');
SQL
( SU <<SQL
$(as_user "$MGR")
begin;
select public.lock_competition_round_ballots('$(U 83)','$(U c201)');
select pg_sleep(4);
commit;
SQL
) > "$OUTDIR/ns1c_c_lock.out" 2>&1 &
PID=$!
sleep 1.5
T0=$(now_ms)
OUT=$(SU <<SQL 2>&1
$(as_user "$MGR")
select public.mark_competition_heat_no_show($(HE 3 3), 'race C', '$(U c001)');
SQL
)
T1=$(now_ms); wait $PID; EL=$((T1-T0))
echo "C: mark took ${EL}ms -> $OUT"
ok "C: mark waited for the in-flight lock (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "C: mark refused, window closed" $(echo "$OUT" | grep -q 'COMP_NO_SHOW_WINDOW' && echo 1 || echo 0)
ok "C: round locked with no no-show recorded" $([ "$(SU -c "select (select status from public.event_competition_rounds where id='$(U 83)') || ':' || (select count(*) from public.event_competition_heat_no_shows where round_id='$(U 83)')")" = "ballots_locked:0" ] && echo 1 || echo 0)

# ------------------------------------------------------------- D: lock waits for an in-flight no-show, then is refused stale
SU <<SQL
$(as_user "$J1")
select public.submit_competition_ballot('$(U 84)','$(U d4)',$(marks3 4 1 2 3),'$(U d101)');
$(as_user "$J2")
select public.submit_competition_ballot('$(U 84)','$(U d4)',$(marks3 4 2 1 3),'$(U d102)');
$(as_user "$J3")
select public.submit_competition_ballot('$(U 84)','$(U d4)',$(marks3 4 1 3 2),'$(U d103)');
$(as_user "$MGR")
select public.set_competition_heat_lock_state('$(U d4)','locked','race D');
SQL
( SU <<SQL
$(as_user "$MGR")
begin;
select public.mark_competition_heat_no_show($(HE 4 3), 'race D', '$(U d001)');
select pg_sleep(4);
commit;
SQL
) > "$OUTDIR/ns1c_d_mark.out" 2>&1 &
PID=$!
sleep 1.5
T0=$(now_ms)
OUT=$(SU <<SQL 2>&1
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 84)','$(U d201)');
SQL
)
T1=$(now_ms); wait $PID; EL=$((T1-T0))
echo "D: lock took ${EL}ms -> $OUT"
ok "D: lock waited for the in-flight no-show (>=1800ms, was ${EL}ms)" $([ "$EL" -ge 1800 ] && echo 1 || echo 0)
ok "D: lock refused as stale" $(echo "$OUT" | grep -q 'COMP_BALLOTS_STALE' && echo 1 || echo 0)
ok "D: round is still active" $([ "$(SU -c "select status from public.event_competition_rounds where id='$(U 84)'")" = "active" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "NS1 CONCURRENCY PASS ($PASS checks)"; exit 0; fi
echo "NS1 CONCURRENCY FAIL:$FAILS"; exit 1
