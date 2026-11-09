#!/usr/bin/env bash
# Competition CF1 A2 -- rollback chain order (design U68): A2 rolls back BEFORE HL1, restoring the exact post-HL1 text; HL1's rollback then
# restores the pre-HL1 text; re-applying HL1 and A2 returns the pinned post-A2 text.
# Usage: bash run_cf1_a2_rollback_chain.sh [container]   (default cf1-a2-db; needs the chain through HL1, A1 and A2 applied, as role postgres)
# Prints "CF1 A2 ROLLBACK CHAIN PASS (<n> checks)" or "... FAIL: ..." (exit 1).
set -u
export MSYS_NO_PATHCONV=1
C="${1:-cf1-a2-db}"
D="$(cd "$(dirname "$0")/../.." && pwd)"
PS() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -At "$@"; }
PIN() { PS -c "select md5(replace(pg_get_functiondef('public.lock_competition_round_ballots(uuid,uuid)'::regprocedure), E'\r',''))"; }
PRE_HL1=a10fc61528af902c0d7fd0e00caaa155; POST_HL1=6e4175342d51ffe274d70ce413bae8c3; POST_A2=c4ba327df7943d559ab52ccd07d20ea0
PASS=0; FAILS=""
ok() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); else FAILS="$FAILS; $1"; fi; }
run() { PS < "$D/$1" >/dev/null 2>&1 && echo 1 || echo 0; }
ok "start: the installed text is the post-A2 pin" "$([ "$(PIN)" = "$POST_A2" ] && echo 1 || echo 0)"
ok "HL1 rollback is REFUSED while A2 is applied (wrong order)" "$([ "$(run rollback/20270119090000_competition_hl1_heat_guards_rollback.sql)" = 0 ] && [ "$(PIN)" = "$POST_A2" ] && echo 1 || echo 0)"
ok "A1 rollback is REFUSED while A2 still references its helper" "$([ "$(run rollback/20270120085000_competition_cf1_a1_eligibility_helpers_rollback.sql)" = 0 ] && echo 1 || echo 0)"
ok "A2 rollback succeeds" "$(run rollback/20270120092000_competition_cf1_a2_lock_check_rollback.sql)"
ok "after the A2 rollback the text is EXACTLY the post-HL1 pin" "$([ "$(PIN)" = "$POST_HL1" ] && echo 1 || echo 0)"
ok "a second A2 rollback is refused" "$([ "$(run rollback/20270120092000_competition_cf1_a2_lock_check_rollback.sql)" = 0 ] && echo 1 || echo 0)"
ok "HL1 rollback succeeds after A2's" "$(run rollback/20270119090000_competition_hl1_heat_guards_rollback.sql)"
ok "after the HL1 rollback the text is the pre-HL1 pin" "$([ "$(PIN)" = "$PRE_HL1" ] && echo 1 || echo 0)"
ok "A2 apply is refused on the pre-HL1 text (preflight pin)" "$([ "$(run 20270120092000_competition_cf1_a2_lock_check.sql)" = 0 ] && [ "$(PIN)" = "$PRE_HL1" ] && echo 1 || echo 0)"
ok "HL1 re-apply succeeds" "$(run 20270119090000_competition_hl1_heat_guards.sql)"
ok "after the HL1 re-apply the text is the post-HL1 pin" "$([ "$(PIN)" = "$POST_HL1" ] && echo 1 || echo 0)"
ok "A2 re-apply succeeds" "$(run 20270120092000_competition_cf1_a2_lock_check.sql)"
ok "after the A2 re-apply the text is the post-A2 pin" "$([ "$(PIN)" = "$POST_A2" ] && echo 1 || echo 0)"
if [ -z "$FAILS" ]; then echo "CF1 A2 ROLLBACK CHAIN PASS ($PASS checks)"; exit 0; fi
echo "CF1 A2 ROLLBACK CHAIN FAIL:$FAILS"; exit 1
