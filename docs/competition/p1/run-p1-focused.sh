#!/usr/bin/env bash
# Focused P1 run: the OD-02 session's composed P1 runner (PR 863), pinned, restricted to selected suites. LOCAL ONLY; same containers, lock rules,
# composition, rollback, catalog comparison (A before any new migration, D after all rollbacks) and re-apply. Skipped here: concurrency scripts, the
# route probe and the Option D probe. Their file is not edited: a temporary copy gets the overrides below and is removed afterwards.
#
#   bash docs/competition/p1/run-p1-focused.sh <ticket-file> <out-dir> [--wait-minutes N]
#   P_S6=<877 sha>  P1_STACK=<877 sha 919 is stacked on>  P_P1=<919 ref>  (passed through to the pinned runner)
set -uo pipefail
S5_PIN=3f2c985ee
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; DIR="$REPO/scripts/qa/p1"
export ONLY_SUITES="${ONLY_SUITES:-test_T_competition_p1_pilot_restrictions test_T_phase10d1_heat_entry_eligibility_with_p1 test_T_phase10d1_heat_entry_eligibility test_T_competition_s6_entry_status_guard}"
if [ -e "$DIR" ]; then echo "BLOCKED: $DIR already exists; refusing to overwrite it" >&2; exit 4; fi
mkdir -p "$DIR"
trap 'rm -f "$DIR/focused.sh" "$DIR/probe_p1_r11_routes.sql" "$DIR/overrides.sh"; rmdir "$DIR" "$REPO/scripts/qa" 2>/dev/null; true' EXIT
git -C "$REPO" show "$S5_PIN:scripts/qa/p1/comp-p1-integrated-run.sh" > "$DIR/focused.sh" || exit 4
git -C "$REPO" show "$S5_PIN:scripts/qa/p1/probe_p1_r11_routes.sql" > "$DIR/probe_p1_r11_routes.sql" || exit 4
cat > "$DIR/overrides.sh" <<'EOF'
run_phase_suites(){ local s; for s in $(cat "$OUT/list-suites-$1.txt"); do case " $ONLY_SUITES " in *" $s "*) run_suite "$1" "$CHAIN/tests-$1" "$s";; esac; done; }
probe(){ :; }
probe_d(){ :; }
run_phase_races(){ log "focused run: concurrency scripts skipped ($1)"; }
EOF
marker=': > "$OUT/suites.tsv"; : > "$OUT/races.tsv"'
grep -qxF "$marker" "$DIR/focused.sh" || { echo "BLOCKED: override point not found in the pinned runner" >&2; exit 4; }
awk -v m="$marker" -v f="$DIR/overrides.sh" '$0==m { while ((getline l < f) > 0) print l } { print }' "$DIR/focused.sh" > "$DIR/focused.tmp" && mv "$DIR/focused.tmp" "$DIR/focused.sh"
sed -i 's/session: od02-s5 P1 integrated run/session: comp-od31 P1 focused run/; s/expected minutes: 90/expected minutes: 30/' "$DIR/focused.sh"
# the re-apply phase has its own suite loop: restrict it too
sed -i 's|&& run_suite E "$CHAIN/tests-$last" "$s"$|\&\& case " $ONLY_SUITES " in *" $s "*) run_suite E "$CHAIN/tests-$last" "$s";; esac|' "$DIR/focused.sh"
grep -q 'case " $ONLY_SUITES " in \*" $s "\*) run_suite E ' "$DIR/focused.sh" || { echo "BLOCKED: re-apply override point not found in the pinned runner" >&2; exit 4; }
bash "$DIR/focused.sh" "$@"
