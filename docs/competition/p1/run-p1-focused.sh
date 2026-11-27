#!/usr/bin/env bash
# Focused P1 run: the OD-02 session's composed P1 runner (PR 863), pinned, restricted to selected suites. LOCAL ONLY; same containers, lock rules,
# composition, rollback, catalog comparison (A before any new migration, D after all rollbacks) and re-apply. Skipped here: concurrency scripts, the
# route probe and the Option D probe. Their file is not edited: a temporary copy gets the overrides below and is removed afterwards.
#
#   P_S6=<877 sha> P1_STACK=<877 sha that 919 contains> P_P1=<919 sha> bash docs/competition/p1/run-p1-focused.sh <ticket-file> <out-dir> [--wait-minutes N]
#
# The verdict of THIS script is <out-dir>/focused-result.txt and its exit code. The pinned runner's own "DONE" only says that it finished.
set -uo pipefail
S5_PIN=3f2c985ee
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; DIR="$REPO/scripts/qa/p1"
export ONLY_SUITES="test_T_competition_p1_pilot_restrictions test_T_phase10d1_heat_entry_eligibility_with_p1 test_T_phase10d1_heat_entry_eligibility test_T_competition_s6_entry_status_guard"
TICKET=""; [ "${1:-}" = "--compose-only" ] || TICKET="${1:?ticket file}"
OUT="${2:?out dir}"
STARTED=0; MADE=0
cleanup(){
  [ "$MADE" = 1 ] && { rm -f "$DIR/focused.sh" "$DIR/focused.tmp" "$DIR/probe_p1_r11_routes.sql" "$DIR/overrides.sh"; rmdir "$DIR" "$REPO/scripts/qa" 2>/dev/null; }
  # before the pinned runner owns the ticket, a refusal here must not leave it blocking the queue
  [ "$STARTED" = 0 ] && [ -n "$TICKET" ] && rm -f "$TICKET"
  true
}
trap cleanup EXIT
blocked(){ echo "BLOCKED: $*" >&2; exit 4; }
[ -n "${P_S6:-}" ] && [ -n "${P1_STACK:-}" ] && [ -n "${P_P1:-}" ] || blocked "pin P_S6, P1_STACK and P_P1"
[ -e "$DIR" ] && blocked "$DIR already exists; refusing to overwrite it"
mkdir -p "$REPO/scripts/qa" && mkdir "$DIR" || blocked "cannot create $DIR"
MADE=1
git -C "$REPO" show "$S5_PIN:scripts/qa/p1/comp-p1-integrated-run.sh" > "$DIR/focused.sh" || blocked "pinned runner not found"
git -C "$REPO" show "$S5_PIN:scripts/qa/p1/probe_p1_r11_routes.sql" > "$DIR/probe_p1_r11_routes.sql" || blocked "pinned probe not found"
cat > "$DIR/overrides.sh" <<'EOF'
run_phase_suites(){ local s; for s in $(cat "$OUT/list-suites-$1.txt"); do case " $ONLY_SUITES " in *" $s "*) run_suite "$1" "$CHAIN/tests-$1" "$s";; esac; done; }
probe(){ :; }
probe_d(){ :; }
run_phase_races(){ log "focused run: concurrency scripts skipped ($1)"; }
EOF
marker=': > "$OUT/suites.tsv"; : > "$OUT/races.tsv"'
grep -qxF "$marker" "$DIR/focused.sh" || blocked "override point not found in the pinned runner"
awk -v m="$marker" -v f="$DIR/overrides.sh" '$0==m { while ((getline l < f) > 0) print l } { print }' "$DIR/focused.sh" > "$DIR/focused.tmp" && mv "$DIR/focused.tmp" "$DIR/focused.sh" || blocked "could not add the overrides"
grep -qF 'focused run: concurrency scripts skipped' "$DIR/focused.sh" || blocked "overrides are not in the runner copy"
sed -i 's/session: od02-s5 P1 integrated run/session: comp-od31 P1 focused run/; s/expected minutes: 90/expected minutes: 30/' "$DIR/focused.sh"
# the re-apply phase has its own suite loop: restrict it too
sed -i 's|&& run_suite E "$CHAIN/tests-$last" "$s"$|\&\& case " $ONLY_SUITES " in *" $s "*) run_suite E "$CHAIN/tests-$last" "$s";; esac|' "$DIR/focused.sh" || blocked "could not restrict the re-apply loop"
grep -q 'case " $ONLY_SUITES " in \*" $s "\*) run_suite E ' "$DIR/focused.sh" || blocked "re-apply override point not found in the pinned runner"
bash -n "$DIR/focused.sh" || blocked "the runner copy does not parse"
STARTED=1
bash "$DIR/focused.sh" "$@"; rc=$?
[ "$1" = "--compose-only" ] && exit $rc

OUT="$(cd "$OUT" && pwd)"; bad=()
[ "$(cat "$OUT/result.txt" 2>/dev/null)" = DONE ] && [ "$rc" = 0 ] || bad+=("the runner did not finish (rc=$rc, result=$(cat "$OUT/result.txt" 2>/dev/null))")
need(){ # <phase> <suite>: must be present and PASS
  awk -F'\t' -v p="$1" -v s="$2" '$1==p && $2==s && $3 ~ /^PASS/ {f=1} END{exit !f}' "$OUT/suites.tsv" 2>/dev/null || bad+=("[$1] $2 is not PASS: $(awk -F'\t' -v p="$1" -v s="$2" '$1==p && $2==s {print $3}' "$OUT/suites.tsv" 2>/dev/null)"); }
need C test_T_competition_p1_pilot_restrictions
need C test_T_phase10d1_heat_entry_eligibility_with_p1
need A test_T_phase10d1_heat_entry_eligibility
need B test_T_phase10d1_heat_entry_eligibility
need B test_T_competition_s6_entry_status_guard
need E test_T_competition_p1_pilot_restrictions
for f in steps.txt rollback-steps.txt reapply-steps.txt; do
  [ -s "$OUT/$f" ] || { bad+=("$f is missing or empty"); continue; }
  grep -qE '^(FAIL|MISSING)' "$OUT/$f" && bad+=("$f has failures: $(grep -m3 -E '^(FAIL|MISSING)' "$OUT/$f" | tr '\n' ' ')")
done
[ -s "$OUT/catalog-A.txt" ] && [ -s "$OUT/catalog-D.txt" ] && [ ! -s "$OUT/catalog-failed.txt" ] || bad+=("a catalog snapshot failed")
grep -qE 'change_competition_entry_lifecycle|compp1' "$OUT/catalog-A-vs-D.diff" 2>/dev/null && bad+=("rollback does not restore the lifecycle function or leaves P1 objects")
{
  if [ "${#bad[@]}" = 0 ]; then echo "FOCUSED-OK (selected suites and rollback only; no concurrency, no route probe)"; else echo "FOCUSED-FAIL"; printf '%s\n' "${bad[@]}"; fi
  echo "expected and not counted: the released phase10d1 suite fails on C (allow-list): $(awk -F'\t' '$1=="C" && $2=="test_T_phase10d1_heat_entry_eligibility" {print $3}' "$OUT/suites.tsv")"
  echo "other catalog differences A vs D (not 877/919): $(grep -c '^[<>]' "$OUT/catalog-A-vs-D.diff" 2>/dev/null) lines, see catalog-A-vs-D.diff"
} > "$OUT/focused-result.txt"
cat "$OUT/focused-result.txt"
[ "${#bad[@]}" = 0 ]
