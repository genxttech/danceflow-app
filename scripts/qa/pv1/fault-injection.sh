#!/bin/bash
# PV-1 fault injection (local QA database only). Proves that a failure part-way through 20270215090000 can never leave calculate_competition_round
# (or approve) redefined without its verifier, nor a verifier half-installed: the file is ONE explicit transaction, so whether the client stops at the
# first error (psql ON_ERROR_STOP=1, like `supabase db query -f`) or keeps sending statements (ON_ERROR_STOP=0), Postgres aborts the transaction at the
# first error and the final COMMIT becomes a ROLLBACK.
#   F0 precondition: PV-1 and OJ-1 rolled back (pre-PV-1 pins in place, no _comppv1_ function)
#   F1 error injected right AFTER the calculate redefinition (the worst point): client stops on error  -> state unchanged
#   F2 same injection, client continues past errors                                                     -> state unchanged
#   F3 error injected before any function is created                                                     -> state unchanged
#   F4 the real file then applies cleanly (pins 167529ba / 3cf63c3b), and OJ-1 is re-applied
# Usage: bash scripts/qa/pv1/fault-injection.sh <container>
set -u
export MSYS_NO_PATHCONV=1
C=${1:?container}
case "$C" in supabase_db_cf1c-qa|cf1q-*) ;; *) echo "refusing: only the dedicated local QA containers"; exit 2;; esac
M="$(cd "$(dirname "$0")/../../.." && pwd)/src/lib/supabase/migrations"
PV1=$M/20270215090000_competition_pv1_result_recompute.sql
OJ1=$M/20270215091000_competition_oj1_official_team_member.sql
W=$(mktemp -d)
# node is a Windows program under Git Bash: hand it Windows paths (cygpath -m), never MSYS ones
win() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
q() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -At -q -c "$1" 2>&1 | tr -d '\r'; }
state() { q "select md5(replace(pg_get_functiondef('public.calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid)'::regprocedure), E'\\r', '')) || ' ' || md5(replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\\r', '')) || ' fns=' || (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like '\\_comppv1\\_%')"; }
apply() { sed 's/\r$//' "$1" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q -v ON_ERROR_STOP="$2" > "$W/out" 2>&1; echo $?; }
PRE="bc3cc4397e740444a4d4a53d93b499cc ac33e456925e64665db1ea0547bae18b fns=0"
POST="167529bada8ca5a4dd98e22d4d0a3252 3cf63c3bb00a78142ea2c8e70a8b4a0c fns=10"
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "PASS  $1 ($2)"; else echo "FAIL  $1 (got '$2', expected '$3')"; FAIL=1; fi; }

# F0: roll back (OJ-1 first) when installed
if [ "$(state)" != "$PRE" ]; then
  apply "$M/rollback/20270215091000_competition_oj1_official_team_member_rollback.sql" 1 >/dev/null
  apply "$M/rollback/20270215090000_competition_pv1_result_recompute_rollback.sql" 1 >/dev/null
fi
check "F0 precondition: pre-PV-1 texts, no PV-1 function" "$(state)" "$PRE"

# Injected copies: an error right after the calculate redefinition block (before approve), and one before any function.
node -e '
const fs=require("fs"); const s=fs.readFileSync(process.argv[1],"utf8").replace(/\r/g,"");
const after=s.indexOf("-- approve_competition_round_result: re-verify"); if(after<0) throw new Error("approve block not found");
fs.writeFileSync(process.argv[2], s.slice(0,after)+"select 1/0; -- PV-1 FAULT INJECTION (after the calculate redefinition)\n"+s.slice(after));
const first=s.indexOf("create function public._comppv1_truthy"); if(first<0) throw new Error("first function not found");
fs.writeFileSync(process.argv[3], s.slice(0,first)+"select 1/0; -- PV-1 FAULT INJECTION (before any function)\n"+s.slice(first));
' "$(win "$PV1")" "$(win "$W/inj_after_calc.sql")" "$(win "$W/inj_before.sql")"
for i in inj_after_calc inj_before; do
  [ "$(grep -c "PV-1 FAULT INJECTION" "$W/$i.sql" 2>/dev/null)" = 1 ] || { echo "FAIL  injected copy $i.sql was not built: no fault test ran"; rm -rf "$W"; exit 1; }
done
# hit LABEL: the injected run must have reached its injected statement (otherwise an unchanged state proves nothing)
hit() { if grep -q "division by zero" "$W/out"; then echo "PASS  $1: the injected error was raised"; else echo "FAIL  $1: the injected error was never reached"; FAIL=1; fi; }

rc=$(apply "$W/inj_after_calc.sql" 1); echo "      F1 client exit $rc: $(grep -m1 ERROR "$W/out" | cut -c1-90)"; hit F1
check "F1 failure after the calculate redefinition, client stops on error: nothing changed" "$(state)" "$PRE"
rc=$(apply "$W/inj_after_calc.sql" 0); echo "      F2 client exit $rc: $(grep -c ERROR "$W/out") ERROR lines (first: $(grep -m1 ERROR "$W/out" | cut -c1-60))"; hit F2
check "F2 failure after the calculate redefinition, client continues past errors: nothing changed" "$(state)" "$PRE"
rc=$(apply "$W/inj_before.sql" 0); echo "      F3 client exit $rc"; hit F3
check "F3 failure before any function: nothing changed" "$(state)" "$PRE"

# F4: the real files
rc=$(apply "$PV1" 1); echo "      F4 PV-1 client exit $rc"
check "F4 the real PV-1 file applies cleanly with both pins" "$(state)" "$POST"
rc=$(apply "$OJ1" 1); echo "      F4 OJ-1 client exit $rc"
check "F4 OJ-1 re-applied (_compe2_round_role a7d7a235)" "$(q "select md5(replace(pg_get_functiondef('public._compe2_round_role(uuid)'::regprocedure), E'\\r', ''))")" "a7d7a235d9522a073312807df3ff11f9"
rm -rf "$W"
[ $FAIL = 0 ] && echo "PV-1 FAULT INJECTION PASS" || echo "PV-1 FAULT INJECTION FAIL"
exit $FAIL
