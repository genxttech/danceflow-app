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
# NOTE: a successful lock writes insert-only ballot events, so the fixture event cannot be removed afterwards; each run uses distinct ids (RUN=<2 hex>, default from the clock) so several runs can share one database. Run alone (the pg_locks check covers the whole database).
# Prints "CF1 A2 CONCURRENCY PASS (<n> checks)" or "CF1 A2 CONCURRENCY FAIL: ..." and exits non-zero on failure.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-cf1-a2-db}"
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUX() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
RUN="${RUN:-$(printf '%02x' $(($(date +%s) % 256)))}"   # distinct fixture ids per run: several runs can share one database
U() { printf '00000000-0000-0000-0000-c1a2%s%06x' "$RUN" "$((16#$1))"; }
JUDGE1=$(U a1); JUDGE2=$(U a2); JUDGE3=$(U a3); MGR=$(U a0)
EV=$(U e0); STUDIO=$(U 51)
OUT=${TMPDIR:-/tmp}
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

cleanup() {
  SUX -c "delete from public.events where id = '$EV'; delete from public.studios where id='$STUDIO'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-c1a2$RUN%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-c1a2$RUN%'; delete from auth.users where id::text like '00000000-0000-0000-0000-c1a2$RUN%';" >/dev/null 2>&1
}
[ "${KEEP:-}" = "1" ] || trap cleanup EXIT
cleanup

SU <<SQL
insert into auth.users (id, email) values ('$MGR','t-a2c-$RUN-mgr@example.test'),('$JUDGE1','t-a2c-$RUN-j1@example.test'),('$JUDGE2','t-a2c-$RUN-j2@example.test'),('$JUDGE3','t-a2c-$RUN-j3@example.test');
insert into public.profiles (id, email, full_name) select id, email, 'A2C ' || split_part(email,'@',1) from auth.users where id::text like '00000000-0000-0000-0000-c1a2$RUN%';
insert into public.verified_email_identities (user_id, email, first_verified_at, last_verified_at, method, source, credential_status, bound_at)
  select id, lower(email), now(), now(), 'otp', 'web_callback', 'bound', now() from auth.users where id::text like '00000000-0000-0000-0000-c1a2$RUN%';
insert into public.studios (id, name, slug) values ('$STUDIO','A2C Studio $RUN','t-a2c-$RUN-studio');
insert into public.user_studio_roles (user_id, studio_id, role, active) values ('$MGR','$STUDIO','studio_owner',true),('$JUDGE1','$STUDIO','instructor',true),('$JUDGE2','$STUDIO','instructor',true),('$JUDGE3','$STUDIO','instructor',true);
insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required)
  values ('$EV','$STUDIO','A2C Comp','t-a2c-$RUN-e','competition', current_date+30, current_date+30,'published','public',true);
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

# ------------------------------------------------- Deterministic synchronisation (no fixed-sleep race windows)
# The writer holds the entry row, then POLLS pg_stat_activity until the Lock-ballots backend is blocked on a lock (the only lock it can wait
# on at that point is the entry: it already holds the heat-entry shares and the writer has not touched the heat entries). Only then does the
# writer take its second lock, so the cycle ALWAYS forms. Who becomes the victim is decided by per-session deadlock_timeout (the session
# whose timeout is shorter runs the detector first and aborts): A1 -> writer (0.5s vs 5s), A2 -> lock (5s vs 0.5s). A poll that never sees
# the blocked lock backend fails loudly after 20s ("A2C barrier timeout"); there are no silent retries.
writer_sql() { # <round-no> <entry-suffix> <deadlock_timeout> <second-statement: yes|no> <hold-ms-after-barrier>
  local R="$1" E="$2" WD="$3" SECOND="$4" HOLD="$5"
  cat <<SQL
set deadlock_timeout = '$WD';
begin;
set local session_replication_role = replica;
update public.event_competition_entries set updated_at = now() where id = '$(U $E)';
do \$\$
declare t timestamptz := clock_timestamp();
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity a where a.datname = current_database() and a.pid <> pg_backend_pid()
                        and a.wait_event_type = 'Lock' and a.query like '%lock_competition_round_ballots(''$(U 8$R)''%');
    if clock_timestamp() - t > interval '20 seconds' then raise exception 'A2C barrier timeout'; end if;
    perform pg_sleep(0.05);
  end loop;
  perform pg_sleep($HOLD / 1000.0);
end \$\$;
$([ "$SECOND" = yes ] && echo "update public.event_competition_heat_entries set updated_at = now() where entry_id = '$(U $E)';")
commit;
SQL
}
lock_sql() { # <round-no> <request-suffix> <deadlock_timeout>
  cat <<SQL
set deadlock_timeout = '$3';
$(as_user "$MGR")
select public.lock_competition_round_ballots('$(U 8$1)','$(U b$2)');
SQL
}
a_probe() { # <label> <round-no> <entry-suffix> <lock deadlock_timeout> <writer deadlock_timeout> <expected victim: lock|writer>
  local L="$1" R="$2" E="$3" LD="$4" WD="$5" WHO="$6"
  writer_sql "$R" "$E" "$WD" yes 0 | SUX > $OUT/a2c_${L}_writer.out 2>&1 &
  local WRITER_PID=$!
  local LOCK_OUT WRITER_OUT RETRY
  LOCK_OUT=$(lock_sql "$R" "${R}01" "$LD" | SUX 2>&1)
  wait $WRITER_PID
  WRITER_OUT=$(cat $OUT/a2c_${L}_writer.out)
  echo "$L: lock -> $(echo "$LOCK_OUT" | grep -v '^{"sub"' | head -2 | cut -c1-160 | tr '\n' ' ')"
  echo "$L: writer -> $(echo "$WRITER_OUT" | head -2 | cut -c1-160 | tr '\n' ' ')"
  local LOCK_DEAD WRITER_DEAD
  LOCK_DEAD=$(echo "$LOCK_OUT" | grep -c 'deadlock detected'); WRITER_DEAD=$(echo "$WRITER_OUT" | grep -c 'deadlock detected')
  ok "$L: no barrier timeout (the cycle was formed deterministically)" "$(echo "$WRITER_OUT $LOCK_OUT" | grep -q 'barrier timeout' && echo 0 || echo 1)"
  ok "$L: exactly one deadlock victim (lock=$LOCK_DEAD writer=$WRITER_DEAD)" "$([ $((LOCK_DEAD+WRITER_DEAD)) -eq 1 ] && echo 1 || echo 0)"
  ok "$L: the victim is the $WHO (shorter deadlock_timeout runs the detector first)" "$([ "$WHO" = lock ] && [ "$LOCK_DEAD" = 1 ] && echo 1 || { [ "$WHO" = writer ] && [ "$WRITER_DEAD" = 1 ] && echo 1 || echo 0; })"
  ok "$L: the other session completed without an error" "$([ "$LOCK_DEAD" = 1 ] && { echo "$WRITER_OUT" | grep -qi 'error' && echo 0 || echo 1; } || { echo "$LOCK_OUT" | grep -qi 'error' && echo 0 || echo 1; })"
  ok "$L: the victim error is the retryable deadlock class, not a permanent COMP_ROSTER_* code" "$(echo "$LOCK_OUT $WRITER_OUT" | grep -q 'COMP_ROSTER' && echo 0 || echo 1)"
  if [ "$LOCK_DEAD" = 1 ]; then
    ok "$L: the victimised lock left the round active with no event" "$([ "$(round_state 8$R)/$(nevents 8$R)" = "active/0" ] && echo 1 || echo 0)"
    echo "$L: RETRY of the victimised lock (one bounded retry, reported)"
    RETRY=$(lock_sql "$R" "${R}01" 1s | SUX 2>&1)
    ok "$L: a clean retry with the same request id succeeds" "$(echo "$RETRY" | grep -q '"replayed": false' && echo 1 || echo 0)"
  fi
  ok "$L: the round ends ballots_locked with exactly one round_state_changed event" "$([ "$(round_state 8$R)/$(nevents 8$R)" = "ballots_locked/1" ] && echo 1 || echo 0)"
  ok "$L: no lock request is left waiting in this database" "$([ "$(SU -c "select count(*) from pg_locks l join pg_stat_activity a on a.pid=l.pid where not l.granted and a.datname=current_database()")" = "0" ] && echo 1 || echo 0)"
}
a_probe A1 1 911 5s 500ms writer
a_probe A2 3 931 500ms 5s lock

# ------------------------------------------------- Scenario B: the writer only holds the entry -> Lock ballots is observed BLOCKED, then succeeds
writer_sql 2 921 1s no 300 | SUX > $OUT/a2c_B_writer.out 2>&1 &
WRITER_PID=$!
LOCK_OUT=$(lock_sql 2 201 5s | SUX 2>&1)
wait $WRITER_PID
echo "B: lock -> $(echo "$LOCK_OUT" | grep -v '^{"sub"' | head -2 | cut -c1-160 | tr '\n' ' ')"
echo "B: writer -> $(head -c 200 $OUT/a2c_B_writer.out | tr '\n' ' ')"
ok "B: Lock ballots was observed blocked on the entry lock (barrier satisfied, no timeout)" "$(grep -q 'barrier timeout' $OUT/a2c_B_writer.out && echo 0 || { grep -qi 'error' $OUT/a2c_B_writer.out && echo 0 || echo 1; })"
ok "B: and then locked the round after the writer committed" "$(echo "$LOCK_OUT" | grep -q '"replayed": false' && [ "$(round_state 82)" = "ballots_locked" ] && echo 1 || echo 0)"

if [ -z "$FAILS" ]; then echo "CF1 A2 CONCURRENCY PASS ($PASS checks)"; exit 0; fi
echo "CF1 A2 CONCURRENCY FAIL:$FAILS"; exit 1
