#!/usr/bin/env bash
# OD-04 race: an event delete vs a concurrent evidence writer. LOCAL QA Postgres only.
#   bash run_od04_race.sh <container>        (the OD-04 migration and the competition chain are applied; fixtures are committed and removed here)
# A real evidence writer (ballot / result insert) takes FOR KEY SHARE on the events row through its foreign key before it inserts. The
# writer session below does exactly that statement itself and places the evidence row with the FK triggers off (session_replication_role =
# replica, like the other suites), so the lock interleaving is the real one while the row needs no parent chain.
#   Race 1: the writer holds the lock and commits evidence; the delete (started 1 s later) must wait, then be refused.
#   Race 2: the delete runs first; a writer that starts later must find the event gone (its FK check would fail), so no evidence is orphaned.
set -u
export MSYS_NO_PATHCONV=1
C="${1:-df-od04-qa}"
HERE="$(cd "$(dirname "$0")" && pwd)"; T="$HERE/.."
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -h localhost -d postgres -X -q -v ON_ERROR_STOP=1 -At "$@"; }
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
OUT=$(mktemp -d)
S=$(SU -c "insert into public.studios (id,name,slug) values (gen_random_uuid(),'OD04 race','t-od04-race-'||substr(gen_random_uuid()::text,1,6)) returning id")
mkev() { SU -c "insert into public.events (id,studio_id,name,slug,event_type,start_date,end_date,status,visibility,registration_required) values (gen_random_uuid(),'$S','OD04 race','t-od04-r-'||substr(gen_random_uuid()::text,1,10),'competition',current_date+30,current_date+30,'draft','private',true) returning id"; }
cleanup() { SU -c "set session_replication_role = replica; delete from public.event_competition_ballot_events where event_id in (select id from public.events where studio_id='$S'); delete from public.events where studio_id='$S'; delete from public.studios where id='$S';" >/dev/null 2>&1; }
trap cleanup EXIT

# ---- Race 1
E1=$(mkev)
(
  cat "$T/fixtures/od04_seed.sql"
  echo "begin; select 1 from public.events where id='$E1' for key share; select pg_sleep(7); select pg_temp.od04_seed('event_competition_ballot_events','$E1', '{\"kind\":\"ballot_submitted\"}'::jsonb) is not null; commit;"
) | sed 's/\r$//' | SU > "$OUT/w1.txt" 2>&1 &
W1=$!
sleep 4
START=$(date +%s)
SU -c "delete from public.events where id='$E1'" > "$OUT/d1.txt" 2>&1; echo "d1rc=$?" >> "$OUT/d1.txt"
END=$(date +%s)
wait $W1
ok "race1: the writer committed its evidence row" $([ "$(SU -c "select count(*) from public.event_competition_ballot_events where event_id='$E1'")" = "1" ] && echo 1 || echo 0)
ok "race1: the delete waited for the writer (>= 2 s)" $([ $((END-START)) -ge 2 ] && echo 1 || echo 0)
ok "race1: the delete was refused with COMP_EVENT_HAS_SCORING_EVIDENCE" $(grep -q "COMP_EVENT_HAS_SCORING_EVIDENCE" "$OUT/d1.txt" && echo 1 || echo 0)
ok "race1: the event survived" $([ "$(SU -c "select count(*) from public.events where id='$E1'")" = "1" ] && echo 1 || echo 0)

# ---- Race 2
E2=$(mkev)
( echo "begin; delete from public.events where id='$E2'; select pg_sleep(6); commit;" ) | SU > "$OUT/d2.txt" 2>&1 &
D2=$!
sleep 1
# the writer's FK check: lock the parent for key share, then count what it found
(
  echo "begin; select id from public.events where id='$E2' for key share; commit;"
) | SU > "$OUT/w2.txt" 2>&1
wait $D2
ok "race2: the delete committed" $([ "$(SU -c "select count(*) from public.events where id='$E2'")" = "0" ] && echo 1 || echo 0)
ok "race2: the late writer found no parent row (its FK would fail) and no evidence was orphaned" $([ -z "$(tr -d '[:space:]' < "$OUT/w2.txt")" ] && [ "$(SU -c "select count(*) from public.event_competition_ballot_events where event_id='$E2'")" = "0" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "OD04 RACE PASS ($PASS checks)"; exit 0; fi
echo "OD04 RACE FAIL:$FAILS"; echo "--- w1:"; cat "$OUT/w1.txt"; echo "--- d1:"; cat "$OUT/d1.txt"; exit 1
