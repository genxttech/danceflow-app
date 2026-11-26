#!/usr/bin/env bash
# NSI full-chain disposable replay (docs/student-intake/NSI_Full_Chain_Replay_Plan.md). LOCAL DISPOSABLE CONTAINERS ONLY. Hold C:\dfr\heavy.lock.
#   A  baseline from origin/main + every other post-cutoff main migration + TW-4F chain + NSI M1-M11 at the END (PROD order)
#   B  baseline built from the NSI branch (NSI inside the history by filename order) + the same chain without NSI files
# Then: pg_dump comparison of the public and intake_private schemas, the NSI catalog fingerprint, the NSI suites on A, rollbacks M11 -> M9 on A.
# usage: nsi-full-chain-replay.sh <out-dir>
set -u
OUT="${1:?out dir}"; mkdir -p "$OUT"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"; SQLT="$REPO/src/lib/supabase/migrations/sql-tests"; MIG="$REPO/src/lib/supabase/migrations"
ISO="node $REPO/scripts/qa/iso-qa.mjs"
# Pin the NSI git ref to a commit (NSI_REF=<sha>) so the run is immune to later pushes to the branch; the baseline build reads files from it for ~30 minutes.
NSI_REF="${NSI_REF:-nsi/n0-preserve}"; export ISO_QA_REF_NSI="$NSI_REF"
TAG=df-isoqa/base:20261205090000; BACKUP=nsi-replay/base-a:20261205090000
fail=0; say() { echo "$*" | tee -a "$OUT/summary.log"; }; bad() { say "FAIL: $*"; fail=$((fail+1)); }
cd "$REPO" || exit 2
docker image inspect "$TAG" >/dev/null 2>&1 && docker tag "$TAG" "$BACKUP" && say "backed up current $TAG ($(docker image inspect $TAG --format '{{.Id}}' | cut -c1-19))"
dbof() { docker ps --filter "label=df.isoqa=1" --format '{{.Names}}' | grep -- "-$1-db$" | head -1; }
dump() { docker exec "$1" pg_dump -U postgres -s --no-owner -n public -n intake_private postgres 2>/dev/null | grep -v -e '^.restrict ' -e '^.unrestrict ' | sed -E "s/applied_at=[0-9T:.Z-]+/applied_at=<ts>/"; }
fp() { docker exec -i "$1" psql -U postgres -At -f - < "$SQLT/nsi_i2_catalog_fingerprint_local.sql" 2>&1 | head -1; }
apfp() { docker exec -i "$1" psql -U postgres -At -c "select md5((select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal) || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass) || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments') || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass))" 2>&1 | head -1; }

# ---------------------------------------------------------------- A: NSI at the end (PROD order)
say "== A: up full-nsi-end (baseline from origin/main)"
$ISO up full-nsi-end --name nsira --no-api > "$OUT/up_a.json" 2> "$OUT/up_a.err"; rc=$?
say "   up exit code $rc"; tail -3 "$OUT/up_a.err" | cut -c1-300 | sed 's/^/   /'
CA=$(dbof nsira); [ -n "$CA" ] || { bad "no db container for A"; fail=99; }
if [ -n "$CA" ] && [ $rc -eq 0 ]; then
  FPA=$(fp "$CA"); APA=$(apfp "$CA"); say "   NSI catalog fingerprint A: $FPA   appointments fp A: $APA"
  [ "$(echo "$FPA" | tr "	" "|")" = "${NSI_EXPECT_FP:-__M16B_FP__}" ] || bad "A NSI fingerprint is not the M16b value (got $FPA)"
  docker exec "$CA" psql -U postgres -At -c "select intake_private.assert_catalog(); select 'assert_catalog ok'" 2>&1 | tail -1 | sed 's/^/   /'
  dump "$CA" > "$OUT/schema_a.sql"; wc -l "$OUT/schema_a.sql" | sed 's/^/   dump lines: /'
  docker rename "$CA" nsi-i2-replay-a
  run() { r=$(LINES_OUT=2 "$SQLT/run_i2_m7_m9_local.sh" nsi-i2-replay-a "$1" "$APA" | grep -E "SUITE" | head -1 | cut -c1-1500); say "   $2: ${r:-<no result>}"; echo "$r" | grep -q PASS || bad "$2: $r"; }
  run test_T_nsi_i3_2_m16b_local.sql "M16b suite on A"
  run test_T_nsi_i3_2_m16a_local.sql "M16a suite on A"
  run test_T_nsi_i3_3_m15_local.sql "M15 suite on A"
  run test_T_nsi_i3_1_m14_local.sql "M14 suite on A"
  run test_T_nsi_i3_1_m13_local.sql "M13 suite on A"
  run test_T_nsi_i3_1_local.sql "M12 suite on A"
  run test_T_nsi_i2_m11_ensure_request_local.sql "M11 suite on A"
  run test_T_nsi_i2_m10_ensure_request_local.sql "M10 suite on A"
  run test_T_nsi_i2_m7_grants_local.sql "M7 suite on A"
  run test_T_nsi_i2_m9_archiving_local.sql "M9 suite on A"
  for f in test_T_nsi_i1_foundation test_T_nsi_i2_local; do
    r=$({ echo "set nsi.test_local = 'on'; set nsi.appointments_fp = '$APA';"; cat "$SQLT/$f.sql"; } | docker exec -i nsi-i2-replay-a psql -U postgres -q 2>&1 | grep -E "SUITE" | head -1 | cut -c1-1500)
    say "   $f on A: ${r:-<no result>}"; echo "$r" | grep -q PASS || bad "$f on A: $r"
  done
  say "== rollbacks on A: M16b -> M16a -> M15 -> M14 -> M13 -> M12 -> M11 -> M10 -> M9"
  rbk() { docker exec -i nsi-i2-replay-a psql -U postgres -q -v ON_ERROR_STOP=1 < "$MIG/rollback/$1.sql" 2>&1 | grep -iE "^ERROR|FATAL" | head -2; }
  e=$(rbk 20261118106000_nsi_i3_m16b_guardian_challenge_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "63e82e902ac004b406195a9164b944b2" ] && say "   M16b rollback -> M16a fingerprint identical" || bad "M16b rollback: $e"
  e=$(rbk 20261118105000_nsi_i3_m16a_guardian_attestation_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "3fc0eea416e8f820856935a2b94d078a" ] && say "   M16a rollback -> M15 fingerprint identical" || bad "M16a rollback: $e"
  e=$(rbk 20261118104000_nsi_i3_m15_minor_determination_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "be5a715adedad4197649593d23c6ce09" ] && say "   M15 rollback -> M14 fingerprint identical" || bad "M15 rollback: $e"
  e=$(rbk 20261118103000_nsi_i3_m14_hold_semantics_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "97e13781e9f0498d8e452c64d6d43e18" ] && say "   M14 rollback -> M13 fingerprint identical" || bad "M14 rollback: $e"
  e=$(rbk 20261118102000_nsi_i3_m13_purge_hardening_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "3353ac988bc16927f7416e4ec7015cf1" ] && say "   M13 rollback -> M12 fingerprint identical" || bad "M13 rollback: $e"
  e=$(rbk 20261118101000_nsi_i3_m12_invitations_sessions_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "9c575d50b7ef98d73b2583e73818e8d1" ] && say "   M12 rollback -> M11 fingerprint identical" || bad "M12 rollback: $e"
  e=$(rbk 20261118100000_nsi_i2_m11_ensure_request_hardening_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "c6b3d46bfbe354c9b67864ad9bd58bc2" ] && say "   M11 rollback -> M10 fingerprint identical" || bad "M11 rollback: $e"
  e=$(rbk 20261118099000_nsi_i2_m10_ensure_request_evaluator_rollback); [ -z "$e" ] && [ "$(fp nsi-i2-replay-a | cut -c1-32)" = "534c5e93300ef25b5fa8496fb472d48f" ] && say "   M10 rollback -> M9 fingerprint identical" || bad "M10 rollback: $e"
fi
docker rm -f nsi-i2-replay-a >/dev/null 2>&1; $ISO down --name nsira --force >/dev/null 2>&1

# ---------------------------------------------------------------- B: NSI inside the history (baseline from the NSI branch)
say "== B: baseline from nsi/n0-preserve (NSI inside the history by filename order)"
$ISO baseline --ref "$NSI_REF" > "$OUT/baseline_b.out" 2> "$OUT/baseline_b.err"; rc=$?
say "   baseline exit code $rc"; tail -2 "$OUT/baseline_b.err" | cut -c1-300 | sed 's/^/   /'
if [ $rc -eq 0 ]; then
  $ISO up full-nsi-mid --name nsirb --no-api > "$OUT/up_b.json" 2> "$OUT/up_b.err"; rc=$?
  say "   up exit code $rc"; tail -3 "$OUT/up_b.err" | cut -c1-300 | sed 's/^/   /'
  CB=$(dbof nsirb)
  if [ -n "$CB" ] && [ $rc -eq 0 ]; then
    FPB=$(fp "$CB"); APB=$(apfp "$CB"); say "   NSI catalog fingerprint B: $FPB   appointments fp B: $APB"
    dump "$CB" > "$OUT/schema_b.sql"
    if [ -s "$OUT/schema_a.sql" ]; then
      n=$(diff "$OUT/schema_a.sql" "$OUT/schema_b.sql" | grep -c '^[<>]'); say "   pg_dump diff A vs B (public + intake_private, schema only): $n differing lines"
      [ "$n" = "0" ] || { diff "$OUT/schema_a.sql" "$OUT/schema_b.sql" | head -60 > "$OUT/schema_diff_head.txt"; bad "schema dumps differ ($n lines), see schema_diff_head.txt"; }
      [ "$FPA" = "$FPB" ] && say "   NSI fingerprints identical" || bad "NSI fingerprints differ"
    fi
  else bad "B up failed"; fi
  $ISO down --name nsirb --force >/dev/null 2>&1
else bad "baseline B failed"; fi

# ---------------------------------------------------------------- restore the shared baseline tag
if docker image inspect "$BACKUP" >/dev/null 2>&1; then docker tag "$BACKUP" "$TAG" && docker rmi "$BACKUP" >/dev/null 2>&1 && say "restored $TAG"; fi
docker ps -a --format '{{.Names}}' | grep -E "df-isoqa-nsir|nsi-i2" | while read c; do docker rm -f "$c" >/dev/null 2>&1; done
say "SUMMARY full-chain replay: failures=$fail"
[ "$fail" = "0" ]
