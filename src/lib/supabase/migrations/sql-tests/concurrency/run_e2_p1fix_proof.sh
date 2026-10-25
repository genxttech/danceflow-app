#!/usr/bin/env bash
# Competition E2 -- proof that the P1-1 re-fix tests are real regression tests.
#
# NOT RUN YET when written (DB slot queued). Usage: bash run_e2_p1fix_proof.sh [container]   (E1 + O1 + E2 applied, superuser)
# 1. rolls E2 back and applies the PRE-FIX migration (the version before commit 22f66ccd) from git;
# 2. runs sql-tests/test_T_competition_e2_p1fix.sql and requires it to FAIL, on checks A, B and C;
# 3. rolls back, re-applies the CURRENT migration (always restored, even on failure) and requires the same file to PASS,
#    then the full E2 suite to PASS.
# Needs no ballot evidence in the DB (the rollback refuses otherwise), which holds because the suites roll back.
# Prints "E2 P1FIX PROOF PASS (<n> checks)" or "E2 P1FIX PROOF FAIL: ...".
set -u
export MSYS_NO_PATHCONV=1
C="${1:-e2-qa-db}"
HERE="$(cd "$(dirname "$0")" && pwd)"; MIG="$HERE/../.."; ROOT="$(cd "$MIG/../../../.." && pwd)"
REL="src/lib/supabase/migrations/20270102090000_competition_e2_ballots.sql"
PSQL() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q "$@"; }
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }

rollback() { sed 's/\r$//' "$MIG/rollback/20270102090000_competition_e2_ballots_rollback.sql" | PSQL -v ON_ERROR_STOP=1 >/dev/null 2>&1; }
apply_current() { sed 's/\r$//' "$MIG/20270102090000_competition_e2_ballots.sql" | PSQL -v ON_ERROR_STOP=1 >/dev/null 2>&1; }
restore() { rollback; apply_current; }
trap restore EXIT

# ---- pre-fix
rollback
ok "rolled back the current migration" $([ "$(PSQL -At -c "select to_regclass('public.event_competition_ballots') is null")" = "t" ] && echo 1 || echo 0)
(cd "$ROOT" && git show "22f66ccd^:$REL") | sed 's/\r$//' | PSQL -v ON_ERROR_STOP=1 >/dev/null 2>&1
ok "pre-fix migration applied" $([ "$(PSQL -At -c "select to_regclass('public.event_competition_ballots') is not null")" = "t" ] && echo 1 || echo 0)
OUT=$(sed 's/\r$//' "$HERE/../test_T_competition_e2_p1fix.sql" | PSQL 2>&1 | grep -E "SUITE" | head -1)
ok "p1fix suite FAILS on the pre-fix migration" $(echo "$OUT" | grep -q "P1FIX SQL SUITE FAIL" && echo 1 || echo 0)
for chk in "A: a heat with every entry scratched" "B: lock on a callback round with T >= eligible" "C: ballots on the fully scratched heat"; do
  ok "pre-fix fails check: $chk" $(echo "$OUT" | grep -qF "$chk" && echo 1 || echo 0)
done

# ---- current
rollback
apply_current
ok "current migration applied" $([ "$(PSQL -At -c "select to_regclass('public.event_competition_ballots') is not null")" = "t" ] && echo 1 || echo 0)
OUT=$(sed 's/\r$//' "$HERE/../test_T_competition_e2_p1fix.sql" | PSQL 2>&1 | grep -E "SUITE" | head -1)
ok "p1fix suite PASSES on the current migration" $(echo "$OUT" | grep -q "P1FIX SQL SUITE PASS" && echo 1 || echo 0)
OUT=$(sed 's/\r$//' "$HERE/../test_T_competition_e2_ballots.sql" | PSQL 2>&1 | grep -E "SUITE" | head -1)
ok "full E2 suite PASSES on the current migration" $(echo "$OUT" | grep -q "E2 SQL SUITE PASS" && echo 1 || echo 0)

if [ -z "$FAILS" ]; then echo "E2 P1FIX PROOF PASS ($PASS checks)"; exit 0; fi
echo "E2 P1FIX PROOF FAIL:$FAILS"; exit 1
