#!/bin/bash
# R-11 correction (20270224090000): LOCAL isolated Postgres proof. NOT a hosted tool: it never touches DEV, PROD, sb.sh or any shared database.
#
#   bash scripts/qa/r11/run-r11.sh [--phase all|chain|suites]       (the caller MUST hold C:\dfr\heavy.lock under its own ticket; this script checks owner.txt)
#
# One disposable container (name df-r11-<pid>, label df.r11=1, no published port, removed on exit) from the committed local image ns1-base:snap
# (E1, E2, O1, REG, F2), then the CF1 chain used by sql-tests/run_cf1_f3.sh plus F3, PV-1 and OJ-1, from THIS worktree, EXCLUDING 20270224090000 (R-11). Then:
#   P1  precondition: approve md5 = 3cf63c3b... (post A3 + PV-1)
#   P2  characterization: the R-11 suite on the UNPATCHED chain must FAIL, and fail on the RB-11.1 / RB-11.2 / S: checks (the blockers reproduce)
#   P3  apply the migration; approve md5 = post pin; ACL snapshot taken
#   P4  the R-11 suite must PASS
#   P5  replay: apply the migration again (no-op, same md5, same ACL); rollback (md5 = 3cf63c3b..., same ACL); rollback again (no-op); re-apply forward
#   P6  existing suites after the migration: f2, a3, pv1, f3, a5 (must keep passing); the R-11 suite once more
# Exit codes: 0 all passed; 1 a check failed; 3 infrastructure; 4 BLOCKED (lock/image/docker). Nothing is reported as passed when it did not run.
set -u
export MSYS_NO_PATHCONV=1
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"; M="$ROOT/src/lib/supabase/migrations"; T="$M/sql-tests"
OUT="${R11_OUT:-$ROOT/.qa-out/r11}"; mkdir -p "$OUT"; REPORT="$OUT/report.txt"; : > "$REPORT"
C="df-r11-$$"; IMAGE="${R11_IMAGE:-ns1-base:snap}"
MIG=20270224090000_competition_r11_approval_override_scope.sql
PRE=3cf63c3bb00a78142ea2c8e70a8b4a0c
POST=$(grep -o "v_post constant text := '[0-9a-f]*'" "$M/$MIG" | grep -o "[0-9a-f]\{32\}")
log() { echo "$*" | tee -a "$REPORT"; }
BAD=0
cleanup() { docker rm -f -v "$C" >/dev/null 2>&1; }
[ "${R11_KEEP:-0}" = 1 ] || trap cleanup EXIT
[ -f /c/dfr/heavy.lock/owner.txt ] && grep -qi "r11" /c/dfr/heavy.lock/owner.txt || { log "BLOCKED: the heavy lock is not held by an r11 job (take your queue ticket, then the lock, first)"; exit 4; }
docker image inspect "$IMAGE" >/dev/null 2>&1 || { log "BLOCKED: image $IMAGE not present"; exit 4; }
q()  { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -h localhost -d postgres -At -q -c "$1" 2>&1 | tr -d '\r'; }
ap() { u=$1; shift; for f in "$@"; do o=$(sed 's/\r$//' "$f" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U "$u" -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1); if echo "$o" | grep -qE "ERROR|FATAL|psql:"; then log "APPLY FAIL ($u) $(basename "$f"): $(echo "$o" | grep -E 'ERROR|FATAL|psql:' | head -2)"; return 1; fi; done; }
amd5() { q "select md5(replace(pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure), E'\\r', ''))"; }
acl()  { q "select p.proowner::regrole || ' ' || coalesce(p.proacl::text,'null') || ' ' || p.prosecdef || ' ' || coalesce(p.proconfig::text,'null') from pg_proc p where p.oid = 'public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure"; }
verdict() { sed 's/\r$//' "$1" | docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -h localhost -d postgres -X -q 2>&1 | grep -E 'SUITE (PASS|FAIL)' | head -1 | sed 's/^ERROR:  //'; }
run() { n=$1; f=$2; fx=${3:-}; if [ -n "$fx" ]; then src="$T/fixtures/competition_round_ready.sql"; v=$(cat "$src" "$f" | sed 's/\r$//' | docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -h localhost -d postgres -X -q 2>&1 | grep -E 'SUITE (PASS|FAIL)' | head -1 | sed 's/^ERROR:  //'); else v=$(verdict "$f"); fi
  [ -z "$v" ] && v="NO VERDICT"; echo "$v" > "$OUT/suite_$n.txt"; log "SUITE $n: $(echo "$v" | cut -c1-1500)"; case "$v" in *"SUITE PASS"*) return 0;; esac; return 1; }
check() { if [ "$2" = "$3" ]; then log "PASS  $1"; else log "FAIL  $1 (got '$2', expected '$3')"; BAD=$((BAD+1)); fi; }

docker rm -f -v "$C" >/dev/null 2>&1
docker run -d --name "$C" --label df.r11=1 -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null || { log "BLOCKED: could not start $C"; exit 4; }
for i in $(seq 1 120); do docker exec "$C" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 3; done
docker exec "$C" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 || { log "INFRA: database not ready"; exit 3; }
log "R-11 runner: container $C image $IMAGE; migration pins pre=$PRE post=$POST"

# chain (same order and owners as sql-tests/run_cf1_f3.sh; then F3, PV-1, OJ-1). Without the R-11 file.
cd "$M" || exit 3
ap postgres 20270110* 20270115* 20270116* 20270117* 20270118* 20270119* 20270120085000_* || { log "BLOCKED: chain step 1 failed"; exit 4; }
ap supabase_admin 20270120090000_* 20270120091000_* 20270120092000_* 20270120093000_* 20270120094000_* 20270120095000_* 20270120095500_* 20270120101000_* || { log "BLOCKED: chain step 2 failed"; exit 4; }
ap postgres 20270120102000_* || { log "BLOCKED: chain step 3 failed"; exit 4; }
ap supabase_admin 20270120103000_* 20270122090000_* 20270215090000_* 20270215091000_* || { log "BLOCKED: chain step 4 (U66, F3, PV-1, OJ-1) failed"; exit 4; }
log "CHAIN: ns1-base:snap + HL1/A1..A7/RB3/U66/F3/PV-1/OJ-1 applied"

check "P1 approve text before the migration = post A3 + PV-1 pin" "$(amd5)" "$PRE"
ACL0=$(acl); log "ACL before: $ACL0"

# P2 characterization: the R-11 suite on the unpatched chain
v=$(verdict "$T/test_T_competition_r11_approval_override_scope.sql"); echo "$v" > "$OUT/p2_characterization.txt"
case "$v" in *"SUITE FAIL"*) log "P2 characterization: FAIL as expected on the unpatched chain: $(echo "$v" | cut -c1-2500)";; *) log "P2 characterization: UNEXPECTED verdict on the unpatched chain: $v"; BAD=$((BAD+1));; esac

# P3 apply
ap supabase_admin "$M/$MIG" || { log "FAIL: the migration did not apply"; exit 1; }
check "P3 approve text after the migration = post pin" "$(amd5)" "$POST"
ACL1=$(acl); check "P3 owner / ACL / security definer / search_path unchanged by CREATE OR REPLACE" "$ACL1" "$ACL0"

# P4 suite
run r11_after_apply "$T/test_T_competition_r11_approval_override_scope.sql" || BAD=$((BAD+1))

# P5 replay, rollback, rollback replay, forward again
ap supabase_admin "$M/$MIG" || BAD=$((BAD+1)); check "P5 migration replay is a no-op (same text)" "$(amd5)" "$POST"; check "P5 migration replay keeps the ACL" "$(acl)" "$ACL0"
ap supabase_admin "$M/rollback/${MIG%.sql}_rollback.sql" || BAD=$((BAD+1)); check "P5 rollback restores the exact pre-migration text (md5)" "$(amd5)" "$PRE"; check "P5 rollback keeps the ACL" "$(acl)" "$ACL0"
q "select (position('v_initial' in pg_get_functiondef('public.approve_competition_round_result(uuid,uuid,text,uuid)'::regprocedure)) = 0)::text" | grep -q true && log "PASS  P5 rollback removed every R-11 fragment" || { log "FAIL  P5 rollback left R-11 text"; BAD=$((BAD+1)); }
ap supabase_admin "$M/rollback/${MIG%.sql}_rollback.sql" || BAD=$((BAD+1)); check "P5 rollback replay is a no-op" "$(amd5)" "$PRE"
ap supabase_admin "$M/$MIG" || BAD=$((BAD+1)); check "P5 re-apply forward after rollback" "$(amd5)" "$POST"; check "P5 ACL after re-apply" "$(acl)" "$ACL0"

# P6 existing suites after the migration (each is one transaction that always raises, nothing persists)
run f2 "$T/test_T_competition_f2_results.sql" || BAD=$((BAD+1))
run a3 "$T/test_T_competition_cf1_a3_results.sql" || BAD=$((BAD+1))
run pv1 "$T/test_T_competition_pv1_recompute.sql" || BAD=$((BAD+1))
run f3 "$T/test_T_competition_cf1_f3_publication.sql" || BAD=$((BAD+1))
run a5 "$T/test_T_competition_cf1_a5_exclusion.sql" || BAD=$((BAD+1))
run r11_final "$T/test_T_competition_r11_approval_override_scope.sql" || BAD=$((BAD+1))
[ "$BAD" = 0 ] && { log "R-11 RUNNER: PASS"; exit 0; } || { log "R-11 RUNNER: FAIL ($BAD check(s) failed)"; exit 1; }
