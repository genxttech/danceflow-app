#!/usr/bin/env bash
# Competition E2 rollback test: the rollback must REFUSE while ballot evidence exists, and succeed (and be re-applicable)
# once the evidence is gone. Usage: bash run_e2_rollback.sh [container]  (E1 + O1 + E2 applied; fixtures come from run_e2_submit_vs_lock.sh).
set -u
export MSYS_NO_PATHCONV=1
C="${1:-e2-qa-db}"
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../.."
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

# 1. leave committed ballots behind (KEEP=1 skips the fixture cleanup)
KEEP=1 bash "$HERE/run_e2_submit_vs_lock.sh" "$C" >/dev/null 2>&1
ok "fixture ballots exist" $([ "$(SU -c "select count(*) > 0 from public.event_competition_ballots")" = "t" ] && echo 1 || echo 0)
OUT=$(sed 's/\r$//' "$MIG/rollback/20270102090000_competition_e2_ballots_rollback.sql" | SU 2>&1)
ok "rollback refuses while ballots exist" $(echo "$OUT" | grep -q "E2 rollback refused" && echo 1 || echo 0)
ok "tables still present after the refusal" $([ "$(SU -c "select to_regclass('public.event_competition_ballots') is not null")" = "t" ] && echo 1 || echo 0)

# 2. remove the evidence (event delete cascade; heats were locked by the fixtures, reopen them as a privileged fixture shortcut)
SU -c "set session_replication_role = replica; update public.event_competition_heats set lock_state='open' where event_id::text like '00000000-0000-0000-0000-e20ff3%'; reset session_replication_role;" >/dev/null
SU -c "delete from public.events where id::text like '00000000-0000-0000-0000-e20ff3%'; delete from public.studios where id::text like '00000000-0000-0000-0000-e20ff3%'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-e20ff3%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-e20ff3%'; delete from auth.users where id::text like '00000000-0000-0000-0000-e20ff3%';" >/dev/null 2>&1
ok "evidence removed" $([ "$(SU -c "select count(*) from public.event_competition_ballots")" = "0" ] && echo 1 || echo 0)

# 3. rollback succeeds, leaves no E2 object, and the migration re-applies
sed 's/\r$//' "$MIG/rollback/20270102090000_competition_e2_ballots_rollback.sql" | SU >/dev/null 2>&1
ok "rollback succeeded" $([ $? -eq 0 ] && echo 1 || echo 0)
ok "no E2 table or function remains" $([ "$(SU -c "select (select count(*) from pg_class where relname like 'event_competition\_ballot%' escape '\' or relname = 'event_competition_marks' or relname = 'event_competition_judge_attendance') + (select count(*) from pg_proc where proname like '\_compe2\_%' escape '\' or proname in ('submit_competition_ballot','lock_competition_round_ballots'))")" = "0" ] && echo 1 || echo 0)
ok "no E2 trigger remains on rounds" $([ "$(SU -c "select count(*) from pg_trigger where tgrelid='public.event_competition_rounds'::regclass and tgname like 'compe2\_%' escape '\'")" = "0" ] && echo 1 || echo 0)
sed 's/\r$//' "$MIG/20270102090000_competition_e2_ballots.sql" | SU >/dev/null 2>&1
ok "migration re-applies after rollback" $([ $? -eq 0 ] && [ "$(SU -c "select to_regclass('public.event_competition_ballots') is not null")" = "t" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "E2 ROLLBACK PASS ($PASS checks)"; exit 0; fi
echo "E2 ROLLBACK FAIL:$FAILS"; exit 1
