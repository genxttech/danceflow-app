#!/usr/bin/env bash
# OD-31 guarded-baseline local runner. LOCAL ONLY: one disposable container from the committed local image, NO network, NO published port.
# Never touches a hosted database, sb.sh, Stripe, Twilio, or another session's container. Honours the shared heavy-job FIFO lock (C:\dfr\HEAVY_LOCK_RULES.md rules 7-8):
# the caller creates its ticket in C:\dfr\heavy.queue first; this script takes C:\dfr\heavy.lock only when that ticket is the OLDEST and the lock is free, and removes only a lock it took.
#
#   bash run-guarded-baseline.sh <ticket-file> <out-dir> [--wait-minutes N]
#
# Composition under test (the "guarded live line", see RELEASE_PATH_AND_BASELINE.md):
#   release/website-embeds @ 49dbaee1b  +  the three candidate-line Competition migrations (JC1, U18, U18-S) and their SQL suites, taken from
#   release/competition-cf1-app-candidate @ 92a8c17c6 (blob-identical to the candidate; every other Competition migration is blob-identical on both lines).
# Role: the suites need a real superuser (SET ROLE, CREATE ROLE): connect as supabase_admin, not postgres (attempt 1 as postgres failed with "permission denied to set role").
# Database: image cf1host:found (hosted-equivalent July baseline + Competition foundation E1..HL1), then the Competition migrations in version order.
set -uo pipefail
TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; WAIT_MIN=45
[ "${3:-}" = "--wait-minutes" ] && WAIT_MIN="${4:-45}"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
R=origin/release/website-embeds; C=origin/release/competition-cf1-app-candidate
M=src/lib/supabase/migrations
IMAGE=cf1host:found
NAME="df-od31-$$"
mkdir -p "$OUT"; CHAIN="$OUT/chain"; rm -rf "$CHAIN"; mkdir -p "$CHAIN/migrations" "$CHAIN/sql-tests"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
TOOK=0
cleanup(){ docker rm -f -v "$NAME" >/dev/null 2>&1; [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"; }
trap cleanup EXIT

# 1. compose the chain from git objects (no checkout needed)
cd "$REPO" || exit 3
for f in $(git ls-tree --name-only "$R" "$M/" | grep -E "/[0-9]{14}_.*competition.*\.sql$"); do git show "$R:$f" > "$CHAIN/migrations/$(basename "$f")"; done
for n in 20270215092000_competition_jc1_inactive_judge_absent 20270215093000_competition_u18_heat_entry_status_guard 20270215094000_competition_u18s_heat_entry_scratch_audit; do
  git show "$C:$M/$n.sql" > "$CHAIN/migrations/$n.sql"
done
for f in $(git ls-tree --name-only "$C" "$M/sql-tests/" | grep -E "test_T_competition_|test_T_phase10"); do git show "$C:$f" > "$CHAIN/sql-tests/$(basename "$f")"; done
cp docs/competition/governance/audit/guarded-baseline/test_T_od31_guarded_baseline_negative.sql "$CHAIN/sql-tests/"
( cd "$CHAIN/migrations" && sha256sum *.sql ) > "$OUT/migrations.sha256"
sha256sum "$OUT/migrations.sha256" | cut -d' ' -f1 > "$OUT/migrations.fingerprint"
log "composed $(wc -l < "$OUT/migrations.sha256") competition migrations; fingerprint $(cat "$OUT/migrations.fingerprint")"
git rev-parse "$R" "$C" > "$OUT/source-commits.txt"

# 2. FIFO: wait until our ticket is oldest and the lock is free
deadline=$(( $(date +%s) + WAIT_MIN*60 ))
while :; do
  oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
  if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
  [ "$(date +%s)" -gt "$deadline" ] && { log "BLOCKED: lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
  sleep 60
done
printf 'session: Competition OD-31 guarded baseline\njob: local Postgres (%s) U18/U18-S/JC1 + negative suite + regression SQL suites\nstart: %s\nexpected minutes: 30\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
log "lock taken"

# 3. start the disposable database
docker run -d --name "$NAME" --label df.od31=1 --network none -e POSTGRES_PASSWORD=postgres "$IMAGE" > /dev/null || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: docker run failed"; exit 4; }
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
for i in $(seq 1 60); do "${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 && break; sleep 2; done
"${PSQL[@]}" -Atc 'select 1' >/dev/null 2>&1 || { echo BLOCKED > "$OUT/result.txt"; log "BLOCKED: database not ready"; exit 4; }
docker image inspect "$IMAGE" --format '{{.Id}}' > "$OUT/image-id.txt"
"${PSQL[@]}" -Atc "select 'pg '||version()" > "$OUT/db-version.txt"
# state BEFORE: which objects exist
cat > "$OUT/probe.sql" <<'SQL'
select 'fn:'||p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('cf1_guard_final_heat_entry','request_round_exclusion','change_competition_entry_lifecycle','cf1_u18_guard_heat_entry_status','cf1_u18s_guard_heat_entry_scratch','_hl1_heat_is_danced','_r2_withdraw_entry','mark_competition_heat_no_show','_compe2_is_absent') order by 1;
SQL
"${PSQL[@]}" -At < "$OUT/probe.sql" > "$OUT/state-before.txt"
log "state before: $(tr '\n' ' ' < "$OUT/state-before.txt")"

# 4. migrations in version order (R2 and everything from the CF1 A1 helpers on; the foundation E1..HL1 is in the image)
applied=0; : > "$OUT/migrations-applied.txt"
for f in $(ls "$CHAIN/migrations" | sort); do
  v="${f%%_*}"
  case "$v" in 20270103090000|20270103091000) ;; *) [ "$v" \> "20270119090000" ] || continue ;; esac
  if "${PSQL[@]}" -1 < "$CHAIN/migrations/$f" > "$OUT/mig-$v.log" 2>&1; then echo "OK   $f" >> "$OUT/migrations-applied.txt"; applied=$((applied+1)); else echo "FAIL $f" >> "$OUT/migrations-applied.txt"; log "migration FAILED: $f (see mig-$v.log)"; fi
done
log "migrations applied: $applied ($(grep -c FAIL "$OUT/migrations-applied.txt") failed)"
"${PSQL[@]}" -At < "$OUT/probe.sql" > "$OUT/state-after.txt"

# 5. suites: guards first, then regression suites for the audited behaviours
SUITES="${ONLY_SUITES:-test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_od31_guarded_baseline_negative test_T_competition_jc1_inactive_judge_absent \
test_T_competition_cf1_a5_exclusion test_T_competition_ns1_no_show test_T_competition_hl1_heat_guards test_T_competition_cf1_a6_withdrawal test_T_competition_r2_entry_refunds \
test_T_competition_r2_refund_write_gate test_T_competition_f2_results test_T_competition_cf1_od17_enforcement test_T_competition_cf1_a4_minimum_integration test_T_competition_cf1_callback_final_advancement}"
: > "$OUT/suites.tsv"
for s in $SUITES; do
  [ -f "$CHAIN/sql-tests/$s.sql" ] || { printf '%s\tMISSING\t\n' "$s" >> "$OUT/suites.tsv"; continue; }
  timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 < "$CHAIN/sql-tests/$s.sql" > "$OUT/suite-$s.log" 2>&1
  line="$(grep -E "SUITE (PASS|FAIL)|PASS \(|FAIL" "$OUT/suite-$s.log" | tail -1 | cut -c1-400)"
  case "$line" in *PASS*) res=PASS;; *) res=FAIL;; esac
  printf '%s\t%s\t%s\n' "$s" "$res" "$line" >> "$OUT/suites.tsv"; log "$s: $res"
done
log "done"; echo DONE > "$OUT/result.txt"
