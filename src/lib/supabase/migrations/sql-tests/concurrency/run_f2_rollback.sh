#!/usr/bin/env bash
# Competition F2 rollback test: the rollback must REFUSE while result evidence exists, and succeed (and be re-applicable) once
# the evidence is gone. E2's two patched functions must come back byte-identical to what E2 installed.
# Usage: bash run_f2_rollback.sh [container]   (E1 + O1 + E2 + F2 applied; fixtures come from run_f2_races.sh, KEEP=1).
set -u
export MSYS_NO_PATHCONV=1
C="${1:-f2-db}"
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../.."
SU() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
SUN() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q -At "$@"; }
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
FN_SQL="select md5(pg_get_functiondef('public._compe2_guard_ballot_insert()'::regprocedure)) || md5(pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure))"

# 0. fingerprint of the patched E2 functions as F2 left them, then leave committed evidence behind
PATCHED=$(SU -c "$FN_SQL")
KEEP=1 bash "$HERE/run_f2_races.sh" "$C" >/dev/null 2>&1
ok "fixture result versions exist" $([ "$(SU -c "select count(*) > 0 from public.event_competition_result_versions")" = "t" ] && echo 1 || echo 0)
OUT=$(sed 's/\r$//' "$MIG/rollback/20270104090000_competition_f2_results_lifecycle_rollback.sql" | SUN 2>&1)
ok "rollback refuses while result evidence exists" $(echo "$OUT" | grep -q "F2 rollback refused" && echo 1 || echo 0)
ok "tables and the E2 patch are untouched after the refusal" $([ "$(SU -c "select to_regclass('public.event_competition_result_versions') is not null")" = "t" ] && [ "$(SU -c "$FN_SQL")" = "$PATCHED" ] && echo 1 || echo 0)

# 1. remove the evidence (event delete cascade; heats certified by the fixtures are reopened as a privileged fixture shortcut)
SU -c "set session_replication_role = replica; update public.event_competition_heats set lock_state='open' where event_id::text like '00000000-0000-0000-0000-f20ff3%'; reset session_replication_role;" >/dev/null
SU -c "delete from public.events where id::text like '00000000-0000-0000-0000-f20ff3%'; delete from public.studios where id::text like '00000000-0000-0000-0000-f20ff3%'; delete from public.verified_email_identities where user_id::text like '00000000-0000-0000-0000-f20ff3%'; delete from public.profiles where id::text like '00000000-0000-0000-0000-f20ff3%'; delete from auth.users where id::text like '00000000-0000-0000-0000-f20ff3%';" >/dev/null 2>&1
ok "evidence removed" $([ "$(SU -c "select count(*) from public.event_competition_result_versions")" = "0" ] && echo 1 || echo 0)

# 2. rollback succeeds, restores E2's text exactly, and leaves no F2 object
sed 's/\r$//' "$MIG/rollback/20270104090000_competition_f2_results_lifecycle_rollback.sql" | SU >/dev/null 2>&1
ok "rollback succeeded" $([ $? -eq 0 ] && echo 1 || echo 0)
ok "no F2 table, function, trigger or column remains" $([ "$(SU -c "select (select count(*) from pg_class where relname like 'event_competition\_result\_%' escape '\') + (select count(*) from pg_proc where proname like '\_compf2\_%' escape '\' or proname in ('calculate_competition_round','approve_competition_round_result','complete_competition_round','open_competition_round_correction','competition_audit_log')) + (select count(*) from pg_trigger where tgname like 'compf2\_%' escape '\') + (select count(*) from information_schema.columns where table_name='event_competition_rounds' and column_name='correction_open')")" = "0" ] && echo 1 || echo 0)
UNPATCHED=$(SU -c "$FN_SQL")
ok "E2's functions no longer carry the F2 condition" $([ "$UNPATCHED" != "$PATCHED" ] && [ "$(SU -c "select position('_compf2_correction_open' in pg_get_functiondef('public._compe2_guard_ballot_insert()'::regprocedure)) = 0 and position('correction_open' in pg_get_functiondef('public._compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid)'::regprocedure)) = 0")" = "t" ] && echo 1 || echo 0)

# 3. the migration re-applies and re-patches identically
sed 's/\r$//' "$MIG/20270104090000_competition_f2_results_lifecycle.sql" | SU >/dev/null 2>&1
ok "migration re-applies after rollback" $([ $? -eq 0 ] && [ "$(SU -c "select to_regclass('public.event_competition_result_versions') is not null")" = "t" ] && echo 1 || echo 0)
ok "re-applying restores the identical patched E2 functions" $([ "$(SU -c "$FN_SQL")" = "$PATCHED" ] && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "F2 ROLLBACK PASS ($PASS checks)"; exit 0; fi
echo "F2 ROLLBACK FAIL:$FAILS"; exit 1
