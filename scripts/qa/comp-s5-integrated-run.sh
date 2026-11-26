#!/usr/bin/env bash
# S5 integrated local run: the OD-31 composed Competition chain (37 files) + the four correction PRs' migrations, applied in RELEASE order, each PR's SQL suite and the
# pinned existing suites they touched, then the full ROLLBACK chain in reverse release order, then a re-apply. LOCAL ONLY: one disposable container from the committed local
# image cf1host:found, NO network, NO published port. Never touches a hosted database, sb.sh, Stripe, Twilio or another session's container. Honours the FIFO lock
# (C:\dfr\HEAVY_LOCK_RULES.md rules 7-8): the caller creates its ticket first; the lock is taken only when the ticket is the OLDEST and the lock is free; only a lock taken here is removed.
#
#   bash scripts/qa/comp-s5-integrated-run.sh <ticket-file> <out-dir> [--wait-minutes N]
#
# Source of each file (nothing is checked out; blobs come from git objects, so the other PRs' files are never edited):
#   base chain  : release/website-embeds (live competition migrations) + JC1/U18/U18-S from release/competition-cf1-app-candidate (same composition as OD-31 run-guarded-baseline.sh)
#   S1/S2 (R11) : origin/claude/r11-correction-migration     S3 (R10): origin/claude/r10-s3-panel-readiness
#   S4 (R15)    : origin/claude/r15-s4-eligibility-clearance S5       : od02-s5-db-guard (local branch, pushed as origin/od02-s5-db-guard)
set -uo pipefail
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; WAIT_MIN=45
[ "${3:-}" = "--wait-minutes" ] && WAIT_MIN="${4:-45}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
LIVE=origin/release/website-embeds; CAND=origin/release/competition-cf1-app-candidate
P_R11=origin/claude/r11-correction-migration; P_S3=origin/claude/r10-s3-panel-readiness; P_S4=origin/claude/r15-s4-eligibility-clearance; P_S5="${P_S5:-origin/od02-s5-db-guard}"
M=src/lib/supabase/migrations
IMAGE=cf1host:found
NAME="df-s5int-$$"
mkdir -p "$OUT"; CHAIN="$OUT/chain"; rm -rf "$CHAIN"; mkdir -p "$CHAIN/base" "$CHAIN/new" "$CHAIN/rollback" "$CHAIN/sql-tests"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0
cleanup(){ docker rm -f -v "$NAME" >/dev/null 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"; }
trap cleanup EXIT
cd "$REPO" || exit 3

# 1. compose from git objects
for f in $(git ls-tree --name-only "$LIVE" "$M/" | grep -E "/[0-9]{14}_.*competition.*\.sql$"); do git show "$LIVE:$f" > "$CHAIN/base/$(basename "$f")"; done
for n in 20270215092000_competition_jc1_inactive_judge_absent 20270215093000_competition_u18_heat_entry_status_guard 20270215094000_competition_u18s_heat_entry_scratch_audit; do git show "$CAND:$M/$n.sql" > "$CHAIN/base/$n.sql"; done
for f in $(git ls-tree --name-only "$CAND" "$M/sql-tests/" | grep -E "test_T_competition_|test_T_phase10"); do git show "$CAND:$f" > "$CHAIN/sql-tests/$(basename "$f")"; done
git show origin/claude/od31-guarded-baseline-7346b9:docs/competition/governance/audit/guarded-baseline/test_T_od31_guarded_baseline_negative.sql > "$CHAIN/sql-tests/test_T_od31_guarded_baseline_negative.sql"
mkdir -p "$CHAIN/sql-tests/fixtures"; for f in $(git ls-tree -r --name-only "$CAND" "$M/sql-tests/fixtures/" | grep -E '/fixtures/[^/]+\.sql$'); do git show "$CAND:$f" > "$CHAIN/sql-tests/fixtures/$(basename "$f")"; done
rm -rf "$CHAIN/sql-tests-base"; cp -r "$CHAIN/sql-tests" "$CHAIN/sql-tests-base"   # BEFORE the PR versions override them
( cd "$CHAIN/base" && sha256sum *.sql ) > "$OUT/migrations-base.sha256"
sha256sum "$OUT/migrations-base.sha256" | cut -d' ' -f1 > "$OUT/base-fingerprint.txt"
# PR files (forward, rollback, suites): newest blobs from each PR head; PR suites override the candidate copies of the same name.
pull(){ # <ref> <regex of migration file names>
  local ref="$1" re="$2"
  for f in $(git ls-tree -r --name-only "$ref" "$M/" | grep -E "$re"); do
    case "$f" in
      */rollback/*) git show "$ref:$f" > "$CHAIN/rollback/$(basename "$f")";;
      */sql-tests/*) git show "$ref:$f" > "$CHAIN/sql-tests/$(basename "$f")";;
      *) git show "$ref:$f" > "$CHAIN/new/$(basename "$f")";;
    esac
  done
}
pull "$P_R11" '/(20270301090000_|sql-tests/test_T_competition_(r11_|cf1_a3_results|pv1_recompute))|rollback/20270301090000_'
pull "$P_S3"  '/(20270301(100|101|102)000_|sql-tests/test_T_competition_(r10_s3_|e1_officials))|rollback/20270301(100|101|102)000_'
pull "$P_S4"  '/(20270301[0-9]{6}_competition_r15_|sql-tests/(test_T_competition_(r15_|ns1_no_show)|test_T_phase10d1_heat_entry_eligibility|fixtures/))|rollback/20270301[0-9]{6}_competition_r15_'
pull "$P_S5"  '/(20270301120000_|sql-tests/test_T_competition_s5_)|rollback/20270301120000_'
mkdir -p "$CHAIN/sql-tests/fixtures"; for f in $(git ls-tree -r --name-only "$P_S4" "$M/sql-tests/fixtures/"); do git show "$P_S4:$f" > "$CHAIN/sql-tests/fixtures/$(basename "$f")"; done
cp "$CHAIN/sql-tests/test_T_competition_s5_participant_age_guard.sql" "$CHAIN/sql-tests-base/"
( cd "$CHAIN/new" && sha256sum *.sql ) > "$OUT/migrations-new.sha256"
( cd "$CHAIN/rollback" && sha256sum *.sql ) > "$OUT/rollbacks.sha256"
for r in "$P_R11" "$P_S3" "$P_S4" "$P_S5"; do printf '%s %s\n' "$r" "$(git rev-parse "$r")"; done > "$OUT/pr-heads.txt"
git rev-parse "$LIVE" "$CAND" > "$OUT/source-commits.txt"
log "base files: $(wc -l < "$OUT/migrations-base.sha256"); base fingerprint $(cat "$OUT/base-fingerprint.txt"); new files: $(wc -l < "$OUT/migrations-new.sha256"); rollbacks: $(wc -l < "$OUT/rollbacks.sha256")"

# 2. FIFO
deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
  sleep 60
done
printf 'session: od02-s5 integrated run\njob: local Postgres (%s) composed chain + R11/R10-S3/R15/S5 migrations, suites, rollback, re-apply\nstart: %s\nexpected minutes: 60\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken"

# 3. database
docker run -d --name "$NAME" --label df.s5int=1 --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" > /dev/null || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: docker run failed"; exit 4; }
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
for i in $(seq 1 60); do "${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
"${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: database not ready"; exit 4; }
docker image inspect "$IMAGE" --format '{{.Id}}' > "$OUT/image-id.txt"; "${PSQL[@]}" -Atc "select 'pg '||version()" > "$OUT/db-version.txt"

apply(){ # <dir> <file> <tag>
  if "${PSQL[@]}" -1 < "$1/$2" > "$OUT/$3-$2.log" 2>&1; then echo "OK   $3 $2" >> "$OUT/steps.txt"; return 0; else echo "FAIL $3 $2" >> "$OUT/steps.txt"; log "FAILED: $3 $2 (see $3-$2.log)"; return 1; fi
}
: > "$OUT/steps.txt"
# 4. base chain (R2 and everything from the CF1 A1 helpers on; the foundation E1..HL1 is in the image)
for f in $(ls "$CHAIN/base" | sort); do
  v="${f%%_*}"
  case "$v" in 20270103090000|20270103091000) ;; *) [ "$v" \> "20270119090000" ] || continue ;; esac
  apply "$CHAIN/base" "$f" base
done
log "base chain: $(grep -c '^OK   base' "$OUT/steps.txt") ok, $(grep -c '^FAIL base' "$OUT/steps.txt") failed"

# 6. suites (each ends by raising, so nothing persists). Order: new PR suites, pinned suites the PRs touched, OD-31 negative, S5-affected suites (informational: fixtures without dates of birth)
SUITES="${ONLY_SUITES:-test_T_competition_s5_participant_age_guard test_T_competition_r11_approval_override_scope test_T_competition_r10_s3_panel_readiness test_T_competition_r15_eligibility_clearance \
test_T_competition_cf1_a3_results test_T_competition_pv1_recompute test_T_competition_e1_officials test_T_competition_ns1_no_show test_T_phase10d1_heat_entry_eligibility test_T_od31_guarded_baseline_negative \
test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_competition_jc1_inactive_judge_absent test_T_competition_r2_entry_refunds test_T_competition_o1_day_of \
test_T_competition_cf1_f3_publication test_T_phase10d_floor_schedule test_T_competition_r2_refund_write_gate test_T_phase10c_competitor_registration test_T_phase10c4_participant_roles}"
run_suites(){ # <tag>
  : > "$OUT/suites-$1.tsv"
  for s in $SUITES; do
    local dir="$CHAIN/${SUITE_DIR:-sql-tests}"
    [ -f "$dir/$s.sql" ] || { printf '%s\tMISSING\t\n' "$s" >> "$OUT/suites-$1.tsv"; continue; }
    local pre=()
    grep -q 'pg_temp\.compo1_fixture_' "$dir/$s.sql" && pre+=("$dir/fixtures/competition_round_ready.sql")
    grep -q 'pg_temp\.r15_clear_entries' "$dir/$s.sql" && [ -f "$dir/fixtures/r15_clear_entries.sql" ] && pre+=("$dir/fixtures/r15_clear_entries.sql")
    cat ${pre[@]+"${pre[@]}"} "$dir/$s.sql" | timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/suite-$1-$s.log" 2>&1
    printf '%s %s\n' "$s" "${pre[*]##*/}" >> "$OUT/suite-fixtures-$1.txt"
    line="$(grep -E "SUITE (PASS|FAIL)|PASS \(|FAIL" "$OUT/suite-$1-$s.log" | tail -1 | cut -c1-600)"
    case "$line" in *PASS*) res=PASS;; *) res=FAIL;; esac
    printf '%s\t%s\t%s\n' "$s" "$res" "$line" >> "$OUT/suites-$1.tsv"; log "[$1] $s: $res"
  done
}

# 4b. BASELINE: the base chain alone (attributes failures: anything failing here is not caused by the new migrations)
BASE_SUITES="test_T_competition_cf1_a3_results test_T_competition_pv1_recompute test_T_competition_e1_officials test_T_competition_ns1_no_show test_T_phase10d1_heat_entry_eligibility test_T_od31_guarded_baseline_negative test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_competition_jc1_inactive_judge_absent test_T_competition_r2_entry_refunds test_T_competition_o1_day_of test_T_competition_cf1_f3_publication test_T_phase10d_floor_schedule test_T_competition_r2_refund_write_gate test_T_phase10c_competitor_registration test_T_phase10c4_participant_roles"
ALL_SUITES="$SUITES"; SUITES="$BASE_SUITES"; SUITE_DIR=sql-tests-base; run_suites baseline
# 4c. S5 ONLY on top of the base chain: the S5 suite and every suite that inserts participants (isolates the S5 effect)
S5F=$(ls "$CHAIN/new" | grep -E '^20270301120000_')
apply "$CHAIN/new" "$S5F" s5only
SUITES="test_T_competition_s5_participant_age_guard $BASE_SUITES"; run_suites s5only
if "${PSQL[@]}" -1 < "$CHAIN/rollback/${S5F%.sql}_rollback.sql" > "$OUT/rb-s5only.log" 2>&1; then log "S5-only rollback ok"; else log "S5-only rollback FAILED"; fi
SUITES="$ALL_SUITES"; SUITE_DIR=sql-tests

# 5. new migrations in RELEASE order: S1/S2, S3, S4 core, S5, then S4 gates and guard (timestamp order once S4 renumbers its gates after S5).
S4_CORE=$(ls "$CHAIN/new" | grep -E '^20270301[0-9]{6}_competition_r15_eligibility_clearance_core' | head -1)
S4_REST=$(ls "$CHAIN/new" | grep -E 'competition_r15_' | grep -v 'clearance_core' | sort)
ORDER="$(ls "$CHAIN/new" | grep -E '^20270301090000_') $(ls "$CHAIN/new" | grep -E '^2027030110[0-2]000_' | sort) $S4_CORE $(ls "$CHAIN/new" | grep -E '^20270301120000_') $S4_REST"
echo "$ORDER" | tr ' ' '\n' | grep . > "$OUT/release-order.txt"
for f in $ORDER; do apply "$CHAIN/new" "$f" new; done
log "new migrations: $(grep -c '^OK   new' "$OUT/steps.txt") ok, $(grep -c '^FAIL new' "$OUT/steps.txt") failed"

run_suites forward

# 7. rollback chain in reverse RELEASE order, then verify, then re-apply
: > "$OUT/rollback-steps.txt"
tac "$OUT/release-order.txt" | while read -r f; do
  r="${f%.sql}_rollback.sql"
  [ -f "$CHAIN/rollback/$r" ] || { echo "MISSING $r" >> "$OUT/rollback-steps.txt"; continue; }
  if "${PSQL[@]}" -1 < "$CHAIN/rollback/$r" > "$OUT/rb-$r.log" 2>&1; then echo "OK   $r" >> "$OUT/rollback-steps.txt"; else echo "FAIL $r" >> "$OUT/rollback-steps.txt"; fi
done
log "rollback: $(grep -c '^OK' "$OUT/rollback-steps.txt") ok, $(grep -c '^FAIL' "$OUT/rollback-steps.txt") failed, $(grep -c '^MISSING' "$OUT/rollback-steps.txt") missing"
"${PSQL[@]}" -At -c "select 'S5 triggers left: '||count(*) from pg_trigger where tgname like '%s5_%' and not tgisinternal; select 'S5 fns left: '||count(*) from pg_proc where proname like '_comp_s5_%' or proname in ('_comp_age_clearance_from_dob','_comp_participant_age_clearance'); select 'r15 fns left: '||count(*) from pg_proc where proname like '_r15_%' or proname like 'r15_%';" > "$OUT/after-rollback-state.txt" 2>&1
: > "$OUT/reapply-steps.txt"
for f in $(cat "$OUT/release-order.txt"); do
  if "${PSQL[@]}" -1 < "$CHAIN/new/$f" > "$OUT/reapply-$f.log" 2>&1; then echo "OK   $f" >> "$OUT/reapply-steps.txt"; else echo "FAIL $f" >> "$OUT/reapply-steps.txt"; fi
done
log "re-apply: $(grep -c '^OK' "$OUT/reapply-steps.txt") ok, $(grep -c '^FAIL' "$OUT/reapply-steps.txt") failed"
SUITES="test_T_competition_s5_participant_age_guard test_T_competition_r15_eligibility_clearance test_T_competition_r11_approval_override_scope test_T_competition_r10_s3_panel_readiness"
run_suites reapply
log "done"; echo DONE > "$OUT/result.txt"
