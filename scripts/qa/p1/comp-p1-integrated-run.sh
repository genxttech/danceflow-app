#!/usr/bin/env bash
# P1 integrated local run (OWNER-DECISIONS.md section 21): the composed Competition base chain + every P1 correction in timestamp order
# (844, 865, 864, 866, 863, 877, 899 and the P1 restriction slots 20270301180000-189000). PR 867 is merged: JC1/U18/U18-S are part of the pinned base.
# LOCAL ONLY: disposable containers from the local image cf1host:found, no network, no published port. Never a hosted database, never sb.sh, Stripe or Twilio.
# Nothing is checked out: every file comes from git objects, so no PR's files are edited. FIFO (C:\dfr\HEAVY_LOCK_RULES.md rules 7-8): the caller creates
# the ticket first; the lock is taken only when that ticket is the oldest and the lock is free; only what this run created is removed.
#
#   bash scripts/qa/p1/comp-p1-integrated-run.sh <ticket-file> <out-dir> [--wait-minutes N]
#   bash scripts/qa/p1/comp-p1-integrated-run.sh --compose-only <out-dir>          (git only: no lock, no docker)
#   P_P1=origin/<branch>  restriction branch (default: newest of the 25 most recent origin branches that carries a 2027030118x migration)
#   P_S6=<ref or sha>     PR 877 head (pin it once its rebased head is reported; default: the branch tip)
#   P1_STACK=<sha>        877 commit the restriction is stacked on, kept out of the restriction's own files
#   LIVE_PIN=<sha>        release line the base chain is taken from
#
# Phases: A base chain (released suites) | B base + corrections without the restriction (control) | C B + restriction (only when it exists)
#         D rollback of every new migration in reverse order, catalog compared with A | E re-apply, the corrections' own suites again.
# Every phase A-C: all Competition SQL suites present for it and the R-11 route probe. Concurrency scripts run on the last forward phase (C, else B);
# a script that fails is re-run on B (when the last phase is C) and on A, for attribution.
set -uo pipefail
if [ "${1:-}" = "--compose-only" ]; then COMPOSE_ONLY=1; TICKET=""; OUT="${2:?out dir}"; else COMPOSE_ONLY=0; TICKET="${1:?ticket file}"; OUT="${2:?out dir}"; fi
WAIT_MIN=45; [ "${3:-}" = "--wait-minutes" ] && WAIT_MIN="${4:-45}"
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"; HERE="$REPO/scripts/qa/p1"
mkdir -p "$OUT" && OUT="$(cd "$OUT" && pwd)" || exit 3
if [ "$(git -C "$OUT" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then echo "BLOCKED: the out dir must be outside any git work tree" >&2; exit 4; fi
RUN_ID="$$-$(date +%s)"
LOCK=/c/dfr/heavy.lock; QUEUE=/c/dfr/heavy.queue
LIVE="${LIVE_PIN:-57c33191026c3237b02945da2cbf36802ef39043}"; CAND=origin/release/competition-cf1-app-candidate
MERGED_867=6dc6b2d4e5657f27754c9dfc62e977f642ecb04c; P1_STACK="${P1_STACK:-6c80b98a76831647dc603ff839dc2c8edcf2cc3e}"
M=src/lib/supabase/migrations; IMAGE=cf1host:found; NAME="df-p1int-$RUN_ID"
APPHELPER='credential.helper=!node C:/Users/mcurt/d24-app-key/git-credential-app.mjs'
mkdir -p "$OUT"; CHAIN="$OUT/chain"; rm -rf "$CHAIN"; mkdir -p "$CHAIN/base" "$CHAIN/new" "$CHAIN/p1" "$CHAIN/rollback"
log(){ echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$OUT/runner.log"; }
blocked(){ log "BLOCKED: $*"; echo BLOCKED > "$OUT/result.txt"; exit 4; }
TOOK=0; SNAPS=""
cleanup(){
  [ "$COMPOSE_ONLY" = 1 ] && return
  for c in $(docker ps -aq --filter "label=df.p1int=$RUN_ID" 2>/dev/null); do docker rm -f -v "$c" >/dev/null 2>&1; done
  for i in $SNAPS; do docker rmi -f "$i" >/dev/null 2>&1; done
  [ "$TOOK" = 1 ] && rm -rf "$LOCK"; rm -f "$TICKET"
}
trap cleanup EXIT
cd "$REPO" || exit 3

if [ "$COMPOSE_ONLY" = 0 ]; then
  deadline=$(( $(date +%s) + WAIT_MIN*60 ))
  while :; do
    oldest="$(ls "$QUEUE" 2>/dev/null | sort | head -1)"
    if [ "$oldest" = "$(basename "$TICKET")" ] && mkdir "$LOCK" 2>/dev/null; then TOOK=1; break; fi
    [ "$(date +%s)" -gt "$deadline" ] && blocked "lock/queue not available within ${WAIT_MIN} min (oldest ticket: $oldest)"
    sleep 60
  done
  printf 'session: od02-s5 P1 integrated run\njob: local Postgres (%s) P1 composition: suites, bypass probe, concurrency, rollback, re-apply\nstart: %s\nexpected minutes: 90\n' "$NAME" "$(date -u +%FT%TZ)" > "$LOCK/owner.txt"
  log "lock taken"
fi

# ---------------------------------------------------------------- 1. compose from git objects, AFTER the lock, so the heads are current
git -c credential.helper= -c "$APPHELPER" fetch -q origin || log "git fetch failed: composing from the local remote-tracking refs"
if [ -z "${P_P1:-}" ]; then
  for r in $(git for-each-ref --sort=-committerdate --count=25 --format='%(refname:short)' refs/remotes/origin); do
    git ls-tree --name-only "$r" "$M/" 2>/dev/null | grep -qE '/2027030118[0-9]{4}_[^/]+\.sql$' && { P_P1="$r"; break; }
  done
fi
R844="${P_844:-origin/claude/od04-event-delete-guard-c68a8f}"; R866="${P_866:-origin/claude/r15-s4-eligibility-clearance}"
LAYERS="844:$R844 865:${P_865:-origin/claude/r11-correction-migration} 864:${P_864:-origin/claude/r10-s3-panel-readiness}
863:${P_S5:-origin/od02-s5-db-guard} 866:$R866 877:${P_S6:-origin/claude/od31-s6-entry-status-guard} 899:${P_899:-origin/claude/comp-d-published-order-guard}"
[ -n "${P_P1:-}" ] && LAYERS="$LAYERS P1:$P_P1"
# a pinned head that its branch has since left is reported; the pin is what runs
for pin in "${P_844:-}:od04-event-delete-guard-c68a8f" "${P_865:-}:r11-correction-migration" "${P_864:-}:r10-s3-panel-readiness" "${P_866:-}:r15-s4-eligibility-clearance" "${P_S6:-}:od31-s6-entry-status-guard" "${P_899:-}:comp-d-published-order-guard" "${P_P1:-}:od31-p1-pilot-restrictions" "${P_S5:-}:od02-s5-db-guard"; do
  want="${pin%%:*}"; br="origin/claude/${pin#*:}"; [ "${pin#*:}" = od02-s5-db-guard ] && br=origin/od02-s5-db-guard
  [ -n "$want" ] || continue
  tip="$(git rev-parse -q --verify "$br")"; [ "$tip" = "$(git rev-parse -q --verify "$want^{commit}")" ] || log "WARNING: $br is at $tip, not at the pinned $want"
done
: > "$OUT/heads.txt"; : > "$OUT/suite-sources.txt"; : > "$OUT/adapted-copies.txt"
git rev-parse --verify -q "$LIVE" >/dev/null || blocked "missing $LIVE"; git rev-parse --verify -q "$CAND" >/dev/null || blocked "missing $CAND"
printf 'live (pinned base) %s\ncandidate %s\n' "$(git rev-parse "$LIVE")" "$(git rev-parse "$CAND")" >> "$OUT/heads.txt"
now="$(git rev-parse origin/release/website-embeds 2>/dev/null)"; [ "$now" = "$(git rev-parse "$LIVE")" ] || log "WARNING: release line moved to $now since the pinned base"
# one archive per ref (a git process per file is far too slow under the lock)
extract(){ local ref="$1" dest="$2"; shift 2; mkdir -p "$dest"; git archive "$ref" -- "$@" | tar -x -C "$dest"; }
X="$CHAIN/x-live"; extract "$LIVE" "$X" $(git ls-tree --name-only "$LIVE" "$M/" | grep -E "/[0-9]{14}_.*competition.*.sql$"); cp "$X/$M/"*.sql "$CHAIN/base/"
X="$CHAIN/x-cand"; extract "$CAND" "$X" "$M/sql-tests"
( cd "$CHAIN/base" && sha256sum *.sql ) > "$OUT/migrations-base.sha256"
sha256sum "$OUT/migrations-base.sha256" | cut -d' ' -f1 > "$OUT/base-fingerprint.txt"
# released suites (candidate tree) for phase A
cp -r "$X/$M/sql-tests" "$CHAIN/tests-A"
git show origin/claude/od31-guarded-baseline-7346b9:docs/competition/governance/audit/guarded-baseline/test_T_od31_guarded_baseline_negative.sql > "$CHAIN/tests-A/test_T_od31_guarded_baseline_negative.sql"
cp -r "$CHAIN/tests-A" "$CHAIN/tests-B"

# one layer = the files touched by commits of that head that are in neither the live line nor an earlier layer
layer(){ # <label> <ref> <target tests dir> <migration dir>
  local label="$1" ref="$2" tdir="$3" mdir="$4" f rel v
  git rev-parse --verify -q "$ref" >/dev/null || blocked "missing head for $label: $ref"
  echo "$label $ref $(git rev-parse "$ref")" >> "$OUT/heads.txt"
  local files=() X="$CHAIN/x-$label"
  for f in $(git log --no-merges --format= --name-only "$ref" "^$LIVE" $SEEN -- "$M" | sort -u); do files+=("$f"); done
  SEEN_NEXT="^$ref"
  [ "${#files[@]}" = 0 ] && { echo "$label has no files of its own beyond the release line and earlier layers" >> "$OUT/heads.txt"; SEEN="$SEEN $SEEN_NEXT"; return 0; }
  # only paths that still exist at the head can be archived
  local present=(); local all; all="$(git ls-tree -r --name-only "$ref" -- "$M")"
  for f in "${files[@]}"; do grep -qxF "$f" <<<"$all" && present+=("$f"); done
  extract "$ref" "$X" "${present[@]}"
  for f in "${present[@]}"; do
    case "$f" in
      "$M"/sql-tests/*)
        rel="${f#"$M"/sql-tests/}"; if [[ "$rel" == */* ]]; then mkdir -p "$tdir/${rel%/*}"; fi
        if [ ! -f "$tdir/$rel" ]; then echo "$rel from $label (new)" >> "$OUT/suite-sources.txt"
        elif ! cmp -s "$tdir/$rel" "$X/$f"; then echo "$rel from $label (replaces an earlier version; lines removed or changed: $(diff "$tdir/$rel" "$X/$f" | grep -c '^<'))" >> "$OUT/suite-sources.txt"; fi
        cp "$X/$f" "$tdir/$rel";;
      "$M"/rollback/*) cp "$X/$f" "$CHAIN/rollback/";;
      "$M"/*.sql)
        n="${f##*/}"; v="${n%%_*}"
        if [ -f "$CHAIN/base/$n" ]; then cmp -s "$CHAIN/base/$n" "$X/$f" || echo "$label $n differs from the base chain copy" >> "$OUT/compose-warnings.txt"
        elif [[ "$v" > "20270215094000" ]]; then cp "$X/$f" "$mdir/$n"
        else echo "$label $n sorts inside the base chain and was NOT composed" >> "$OUT/compose-warnings.txt"; fi;;
    esac
  done
  SEEN="$SEEN $SEEN_NEXT"
}
: > "$OUT/compose-warnings.txt"; SEEN=""
if git rev-parse --verify -q "$MERGED_867^{commit}" >/dev/null; then SEEN="^$MERGED_867"; echo "867 $MERGED_867 merged: part of the base chain" >> "$OUT/heads.txt"; fi
for l in $LAYERS; do [ "${l%%:*}" = P1 ] && continue; layer "${l%%:*}" "${l#*:}" "$CHAIN/tests-B" "$CHAIN/new"; done
S4="$R866"
mkdir -p "$CHAIN/tests-A/fixtures"; git show "$S4:$M/sql-tests/fixtures/r15_clear_entries.sql" > "$CHAIN/tests-A/fixtures/r15_clear_entries.sql"   # inert without R-15
git show "$R844:$M/sql-tests/test_T_competition_od04_ordinary_event_baseline.sql" > "$CHAIN/tests-A/test_T_competition_od04_ordinary_event_baseline.sql"
git show "$R844:$M/sql-tests/fixtures/od04_seed.sql" > "$CHAIN/tests-A/fixtures/od04_seed.sql"

# ---------------------------------------------------------------- 2. ADAPTED COPIES (composed phases only): blob-checked S4 patches and the S4 hook for S6 suites
ADIR="$CHAIN/adapted-work"; mkdir -p "$ADIR/$M/sql-tests"
git show "$S4:$M/sql-tests/adapted/r15-u18-u18s-jc1-clearance-hook.patch" > "$ADIR/hook.patch"
git show "$S4:$M/sql-tests/adapted/README.md" > "$ADIR/README.md"
blob(){ git hash-object --no-filters "$1"; }
ADAPTED="test_T_competition_u18_heat_entry_status_guard test_T_competition_u18s_heat_entry_scratch_audit test_T_competition_jc1_inactive_judge_absent"
adapted_ok=1
for n in $ADAPTED; do
  git show "$CAND:$M/sql-tests/$n.sql" > "$ADIR/$M/sql-tests/$n.sql"
  want="$(grep -F "\`$n.sql\`" "$ADIR/README.md" | awk -F'`' '{print $4}')"
  [ -n "$want" ] && [ "$(blob "$ADIR/$M/sql-tests/$n.sql")" = "$want" ] || { adapted_ok=0; log "ADAPTED: released blob mismatch for $n"; }
done
if [ "$adapted_ok" = 1 ] && ( cd "$ADIR" && git -c core.autocrlf=false apply -p1 hook.patch ); then
  for n in $ADAPTED; do
    want="$(grep -F "\`$n.sql\`" "$ADIR/README.md" | awk -F'`' '{print $6}')"
    if [ "$(blob "$ADIR/$M/sql-tests/$n.sql")" = "$want" ]; then
      cp "$ADIR/$M/sql-tests/$n.sql" "$CHAIN/tests-B/$n.sql"; echo "$n released=$(blob "$CHAIN/tests-A/$n.sql") adapted=$want" >> "$OUT/adapted-copies.txt"
    else log "ADAPTED: adapted blob mismatch for $n; composed phases keep the released copy"; fi
  done
else log "ADAPTED: hook patch not applied; composed phases keep the released copies"; fi
n=test_T_od31_guarded_baseline_negative; p="docs/competition/governance/audit/guarded-baseline/$n.sql"
mkdir -p "$ADIR/$(dirname "$p")"; cp "$CHAIN/tests-A/$n.sql" "$ADIR/$p"; git show "$S4:$M/sql-tests/adapted/r15-od31-negative-c2.patch" > "$ADIR/od31.patch"
want_rel="$(grep -F "$n.sql\`" "$ADIR/README.md" | awk -F'`' '{print $4}')"; want="$(grep -F "$n.sql\`" "$ADIR/README.md" | awk -F'`' '{print $6}')"
if [ -n "$want_rel" ] && [ "$(blob "$ADIR/$p")" = "$want_rel" ] && ( cd "$ADIR" && git -c core.autocrlf=false apply -p1 od31.patch ) && [ "$(blob "$ADIR/$p")" = "$want" ]; then
  cp "$ADIR/$p" "$CHAIN/tests-B/$n.sql"; echo "$n released=$want_rel adapted=$want" >> "$OUT/adapted-copies.txt"
else log "ADAPTED: OD-31 patch or blob check failed; composed phases keep the released copy"; fi
HOOK="$(awk 'index($0,"+-- S4/R-15")==1 {on=1} on && substr($0,1,1)=="+" {print substr($0,2); if ($0=="+end $r15$;") exit}' "$ADIR/hook.patch")"
printf '%s' "$HOOK" | grep -q 'perform pg_temp.r15_clear_entries' || { log "ADAPTED: hook block with the helper call not found in the S4 patch"; HOOK=""; }
n=test_T_competition_s6_entry_status_guard; src="$CHAIN/tests-B/$n.sql"
if [ -f "$src" ] && [ -n "$HOOK" ] && ! grep -q r15_clear_entries "$src"; then
  points="$(grep -n '^insert into public\.event_competition_heat_entries' "$src" | cut -d: -f1 | tr '\n' ' ')"
  if [ -n "$points" ]; then
    rel="$(blob "$src")"; HOOK="$HOOK" awk 'index($0,"insert into public.event_competition_heat_entries")==1 { print ENVIRON["HOOK"] } { print }' "$src" > "$src.tmp" && mv "$src.tmp" "$src"
    echo "$n released=$rel adapted=$(blob "$src") (hook before lines $points)" >> "$OUT/adapted-copies.txt"
  fi
fi
n=test_T_competition_u18s_heat_entry_scratch_audit_with_s6; src="$CHAIN/tests-B/$n.sql"
if [ -f "$src" ]; then
  W="$CHAIN/adapted-u18s-s6"; mkdir -p "$W/$M/sql-tests"; x="$M/sql-tests/test_T_competition_u18s_heat_entry_scratch_audit.sql"; cp "$src" "$W/$x"
  if ( cd "$W" && git -c core.autocrlf=false apply -p1 --include="$x" "$ADIR/hook.patch" ) 2>>"$OUT/runner.log" && ! cmp -s "$src" "$W/$x"; then rel="$(blob "$src")"; cp "$W/$x" "$src"; echo "$n source=$rel adapted=$(blob "$src")" >> "$OUT/adapted-copies.txt"
  else log "ADAPTED: S4 hook did not apply to the S6 variant of U18-S; running it unhooked"; fi
fi
# phase C test tree = B plus the restriction's own files (never adapted here)
cp -r "$CHAIN/tests-B" "$CHAIN/tests-C"
if [ -n "${P_P1:-}" ]; then
  if git rev-parse --verify -q "$P1_STACK^{commit}" >/dev/null && git merge-base --is-ancestor "$P1_STACK" "$P_P1"; then
    SEEN="$SEEN ^$P1_STACK"
    git merge-base --is-ancestor "$P1_STACK" "${P_S6:-origin/claude/od31-s6-entry-status-guard}" || echo "the restriction is stacked on 877 at $P1_STACK, which is not in the composed 877 head" >> "$OUT/compose-warnings.txt"
  else echo "the restriction is not stacked on $P1_STACK: check that its layer holds only its own files (set P1_STACK)" >> "$OUT/compose-warnings.txt"
  fi
  layer P1 "$P_P1" "$CHAIN/tests-C" "$CHAIN/p1"
fi
( cd "$CHAIN/new" && ls *.sql 2>/dev/null ) | sort > "$OUT/order-B.txt"; ( cd "$CHAIN/p1" && ls *.sql 2>/dev/null ) | sort > "$OUT/order-C.txt"
grep -vE '^2027030118[0-9]{4}_' "$OUT/order-C.txt" > "$OUT/p1-outside-slot.txt" 2>/dev/null
cat "$OUT/order-B.txt" "$OUT/order-C.txt" | sort -c 2>/dev/null || echo "restriction migrations do not all sort after the corrections" >> "$OUT/compose-warnings.txt"
for f in $(cat "$OUT/order-B.txt" "$OUT/order-C.txt"); do [ -f "$CHAIN/rollback/${f%.sql}_rollback.sql" ] || echo "no rollback file for $f" >> "$OUT/compose-warnings.txt"; done
( cd "$CHAIN" && sha256sum new/*.sql p1/*.sql rollback/*.sql 2>/dev/null ) > "$OUT/migrations-new.sha256"
suites_in(){ ( cd "$1" && ls test_T_competition_*.sql test_T_phase10*.sql test_T_od31*.sql 2>/dev/null | sed 's/\.sql$//' ); }
conc_in(){ ( cd "$1" && ls concurrency/*.sh test_T_competition_*.sh 2>/dev/null | grep -E '(concurrency|_races?|_vs_|_locks|_marks_txn)[^/]*\.sh$' | grep -E 'cf1|e2_|f2_|hl1|ns1|ss1|od04|d_publish|competition|r10|r11|r15|p1' | grep -vE 'rollback|verify_' ); }
for p in A B C; do suites_in "$CHAIN/tests-$p" > "$OUT/list-suites-$p.txt"; conc_in "$CHAIN/tests-$p" > "$OUT/list-races-$p.txt"; done
log "composed: base $(wc -l < "$OUT/migrations-base.sha256") (fingerprint $(cat "$OUT/base-fingerprint.txt")), corrections $(wc -l < "$OUT/order-B.txt"), restriction $(wc -l < "$OUT/order-C.txt") (${P_P1:-NOT FOUND}), warnings $(wc -l < "$OUT/compose-warnings.txt")"
log "suites A/B/C: $(wc -l < "$OUT/list-suites-A.txt")/$(wc -l < "$OUT/list-suites-B.txt")/$(wc -l < "$OUT/list-suites-C.txt"); race scripts A/B/C: $(wc -l < "$OUT/list-races-A.txt")/$(wc -l < "$OUT/list-races-B.txt")/$(wc -l < "$OUT/list-races-C.txt")"
if [ "$COMPOSE_ONLY" = 1 ]; then echo COMPOSED > "$OUT/result.txt"; exit 0; fi

# ---------------------------------------------------------------- 3. database
export MSYS_NO_PATHCONV=1
wait_db(){ for i in $(seq 1 90); do docker exec -e PGPASSWORD=postgres "$1" psql -U supabase_admin -d postgres -Atc 'select 1' >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
start_db(){ docker run -d --pull=never --name "$1" --label "df.p1int=$RUN_ID" --network none -e POSTGRES_PASSWORD=postgres "$2" >/dev/null && wait_db "$1"; }
start_db "$NAME" "$IMAGE" || blocked "database not ready"
PSQL=(docker exec -i -e PGPASSWORD=postgres "$NAME" psql -U supabase_admin -d postgres -X -q -v ON_ERROR_STOP=1)
docker image inspect "$IMAGE" --format '{{.Id}}' > "$OUT/image-id.txt"; "${PSQL[@]}" -Atc "select 'pg '||version()" > "$OUT/db-version.txt"
: > "$OUT/steps.txt"
apply(){ if "${PSQL[@]}" -1 < "$1" > "$OUT/$2-$(basename "$1").log" 2>&1; then echo "OK   $2 $(basename "$1")" >> "$OUT/steps.txt"; else echo "FAIL $2 $(basename "$1")" >> "$OUT/steps.txt"; log "FAILED: $2 $(basename "$1"): $(grep -m1 -E 'ERROR|FATAL' "$OUT/$2-$(basename "$1").log")"; return 1; fi; }
snapshot(){ local img="df-p1int-snap-$RUN_ID-$1"; "${PSQL[@]}" -c checkpoint >/dev/null 2>&1; docker commit "$NAME" "$img" >/dev/null && SNAPS="$SNAPS $img" && wait_db "$NAME" || log "snapshot $1 failed: race scripts of that phase will be reported as not run"; }
# catalog of schema public: functions (body, owner, grants), triggers, policies, table grants, constraints, columns, indexes
catalog(){ "${PSQL[@]}" -At > "$OUT/catalog-$1.txt" <<'SQL'
select 'fn ' || p.oid::regprocedure::text || ' owner=' || p.proowner::regrole::text || ' acl=' || coalesce(p.proacl::text, 'default') || ' def=' || md5(pg_get_functiondef(p.oid)) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f', 'p') order by 1;
select 'trg ' || t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgenabled::text || ' ' || md5(pg_get_triggerdef(t.oid)) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and c.relnamespace = 'public'::regnamespace order by 1;
select 'pol ' || tablename || ' ' || policyname || ' ' || cmd || ' ' || roles::text || ' ' || md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) from pg_policies where schemaname = 'public' order by 1;
select 'rel ' || c.relname || ' ' || c.relkind::text || ' rls=' || c.relrowsecurity || ' acl=' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(c.relacl) x), 'default') from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v', 'S', 'm') order by 1;
select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || ' nn=' || a.attnotnull || ' acl=' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(a.attacl) x), '-') from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') and a.attnum > 0 and not a.attisdropped order by 1;
select 'con ' || conrelid::regclass::text || ' ' || conname || ' ' || md5(pg_get_constraintdef(oid)) from pg_constraint where connamespace = 'public'::regnamespace order by 1;
select 'idx ' || indexname || ' ' || md5(indexdef) from pg_indexes where schemaname = 'public' order by 1;
SQL
[ $? = 0 ] && [ -s "$OUT/catalog-$1.txt" ] || { log "CATALOG FAILED ($1): its comparisons prove nothing"; echo "$1" >> "$OUT/catalog-failed.txt"; }
}
guards(){ "${PSQL[@]}" -At -F' | ' -c "select c.relname, t.tgname, t.tgenabled, p.proname, case when t.tgtype & 2 = 2 then 'before' else 'after' end || ' ' || concat_ws(',', case when t.tgtype & 4 = 4 then 'insert' end, case when t.tgtype & 16 = 16 then 'update' end, case when t.tgtype & 8 = 8 then 'delete' end, case when t.tgtype & 32 = 32 then 'truncate' end) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid where not t.tgisinternal and c.relname in ('event_competition_heats', 'event_competition_heat_entries', 'event_competition_entries', 'event_competition_schedule_versions') order by 1, 2" > "$OUT/guards-$1.txt"; }
pred(){ "${PSQL[@]}" -Atc "select coalesce(md5(string_agg(pg_get_functiondef(p.oid), '|' order by p.proname)), 'absent') from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('_comp_participant_age_clearance', '_comp_age_clearance_from_dob')"; }
run_suite(){ # <phase> <tests dir> <suite>
  local ph="$1" dir="$2" s="$3" pre=() before after line res first
  [ -f "$dir/fixtures/r15_clear_entries.sql" ] && pre+=("$dir/fixtures/r15_clear_entries.sql")
  grep -q 'pg_temp\.compo1_fixture_' "$dir/$s.sql" && pre+=("$dir/fixtures/competition_round_ready.sql")
  grep -q 'od04_seed(' "$dir/$s.sql" && pre+=("$dir/fixtures/od04_seed.sql")
  before="$(pred)"
  cat ${pre[@]+"${pre[@]}"} "$dir/$s.sql" | tr -d '\r' | timeout 900 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/suite-$ph-$s.log" 2>&1
  after="$(pred)"
  line="$(grep -E "SUITE (PASS|FAIL)|PASS \(|FAIL" "$OUT/suite-$ph-$s.log" | tail -1 | cut -c1-500)"
  case "$line" in *FAIL*) res=FAIL;; *PASS*) res=PASS;; *) res=FAIL; line="NO VERDICT: $(grep -m1 -E 'ERROR|FATAL' "$OUT/suite-$ph-$s.log" | cut -c1-400)";; esac
  first="$(grep -m1 -E '(ERROR|FATAL):' "$OUT/suite-$ph-$s.log" | cut -c1-400)"
  if [ "$res" = PASS ] && [ -n "$first" ]; then case "$first" in *PASS*) ;; *) res=FAIL; line="verdict says PASS but an earlier error exists: $first";; esac; fi
  case "$s" in *od04_ordinary_event_baseline) res=OUTPUT; line="compared across phases (od04-baseline-diff.txt)";; esac
  [ "$before" = "$after" ] || { res=FAIL-PREDICATE; log "[$ph] $s: S5 predicate changed"; }
  [ "$ph" != A ] && grep -qs "^$s " "$OUT/adapted-copies.txt" && [ "$(blob "$dir/$s.sql")" != "$(blob "$CHAIN/tests-A/$s.sql" 2>/dev/null)" ] && res="$res [ADAPTED COPY]"
  printf '%s\t%s\t%s\t%s\n' "$ph" "$s" "$res" "$line" >> "$OUT/suites.tsv"; log "[$ph] $s: $res"
}
run_phase_suites(){ for s in $(cat "$OUT/list-suites-$1.txt"); do run_suite "$1" "$CHAIN/tests-$1" "$s"; done; }
probe(){ # <phase>
  tr -d '\r' < "$HERE/probe_p1_r11_routes.sql" | timeout 600 "${PSQL[@]}" -At -v ON_ERROR_STOP=0 > "$OUT/bypass-$1.log" 2>&1
  { grep -E '^VERDICT[ -]' "$OUT/bypass-$1.log" || echo "NO VERDICT: $(grep -m1 -E 'ERROR|FATAL' "$OUT/bypass-$1.log")"; grep -q '^P1R11 PROBE COMPLETE' "$OUT/bypass-$1.log" || echo "PROBE INCOMPLETE"; grep -m1 -E '(ERROR|FATAL):' "$OUT/bypass-$1.log"; } > "$OUT/bypass-$1.txt"
  log "[$1] bypass probe: reached $(grep -c ': REACHED' "$OUT/bypass-$1.txt"), not reached $(grep -c ': NOT REACHED' "$OUT/bypass-$1.txt"), closed at setup $(grep -c ': CLOSED AT SETUP' "$OUT/bypass-$1.txt"), inconclusive $(grep -c ': INCONCLUSIVE' "$OUT/bypass-$1.txt") (read bypass-$1.txt)"
}
race(){ # <phase> <snapshot phase> <script>
  local ph="$1" img="df-p1int-snap-$RUN_ID-$2" sc="$3" c rc line res tag
  tag="$(basename "$sc" .sh)"; c="df-p1int-r-$RUN_ID-$ph-$tag"
  start_db "$c" "$img" || { printf '%s\t%s\tNOT RUN\tcontainer from %s not ready\n' "$ph" "$sc" "$img" >> "$OUT/races.tsv"; docker rm -f -v "$c" >/dev/null 2>&1; return 1; }
  ( cd "$CHAIN/tests-$2" && CONTAINER="$c" DBUSER=supabase_admin timeout 600 bash "$sc" "$c" ) > "$OUT/race-$ph-$tag.log" 2>&1; rc=$?
  docker rm -f -v "$c" >/dev/null 2>&1
  line="$(grep -E '(PASS|FAIL)' "$OUT/race-$ph-$tag.log" | tail -1 | cut -c1-400)"
  if [ "$rc" = 0 ] && ! grep -qE '^FAIL|RACES FAIL|CONCURRENCY FAIL' "$OUT/race-$ph-$tag.log" && [ -n "$line" ]; then res=PASS; else res=FAIL; [ -n "$line" ] || line="rc=$rc $(grep -m1 -E 'ERROR|FATAL' "$OUT/race-$ph-$tag.log" | cut -c1-300)"; fi
  printf '%s\t%s\t%s\trc=%s %s\n' "$ph" "$sc" "$res" "$rc" "$line" >> "$OUT/races.tsv"; log "[$ph] race $tag: $res"
  [ "$res" = PASS ]
}
# races run on the last forward phase; a failure is re-run on B (if that phase is C) and on A
run_phase_races(){ local ph="$1" sc; for sc in $(cat "$OUT/list-races-$ph.txt"); do
  race "$ph" "$ph" "$sc" && continue
  [ "$ph" = C ] && [ -f "$CHAIN/tests-B/$sc" ] && race "B-attribution" B "$sc"
  [ -f "$CHAIN/tests-A/$sc" ] && race "A-attribution" A "$sc"
done; }
# Option D's own planted-heat probe (observation only), when that head carries it
probe_d(){ local f="$CHAIN/tests-$1/probe_D_planted_heat.sql"; [ -f "$f" ] || return 0
  tr -d '\r' < "$f" | timeout 600 "${PSQL[@]}" -v ON_ERROR_STOP=0 > "$OUT/probe-D-$1.log" 2>&1; log "[$1] Option D planted-heat probe: $(grep -m1 -E '(ERROR|FATAL):' "$OUT/probe-D-$1.log" | cut -c1-300)"; }
: > "$OUT/suites.tsv"; : > "$OUT/races.tsv"
sed 's/^/compose warning: /' "$OUT/compose-warnings.txt" | tee -a "$OUT/runner.log"

# A
for f in $(ls "$CHAIN/base" | sort); do v="${f%%_*}"; case "$v" in 20270103090000|20270103091000) ;; *) [[ "$v" > "20270119090000" ]] || continue ;; esac; apply "$CHAIN/base/$f" A; done
grep -q '^FAIL A' "$OUT/steps.txt" && blocked "the base chain did not apply"
catalog A; guards A; snapshot A; run_phase_suites A; probe A
# B: corrections in timestamp order. A correction that does not apply is recorded and the chain continues without it.
for f in $(cat "$OUT/order-B.txt"); do apply "$CHAIN/new/$f" B; done
catalog B; guards B; snapshot B; run_phase_suites B; probe B; probe_d B
# C
if [ -s "$OUT/order-C.txt" ]; then
  for f in $(cat "$OUT/order-C.txt"); do apply "$CHAIN/p1/$f" C; done
  if grep -q '^FAIL C ' "$OUT/steps.txt"; then C_OK=0; log "C BLOCKED: a restriction migration did not apply; no phase C evidence"; run_phase_races B
  else C_OK=1; catalog C; guards C; snapshot C; run_phase_suites C; probe C; probe_d C; run_phase_races C; fi
else log "PENDING: no restriction migration found; phase C not run"; run_phase_races B; fi
o="$(ls "$OUT"/suite-A-test_T_competition_od04_ordinary_event_baseline.log 2>/dev/null)"
if [ -n "$o" ]; then for p in B C; do q="$OUT/suite-$p-test_T_competition_od04_ordinary_event_baseline.log"; [ -f "$q" ] && { echo "== A vs $p"; diff "$o" "$q" && echo identical; } ; done > "$OUT/od04-baseline-diff.txt"; fi
# D: reverse timestamp order, only what applied; then compare the catalog with A
APPLIED="$(grep -E '^OK   [BC] ' "$OUT/steps.txt" | awk '{print $3}' | sort)"
: > "$OUT/rollback-steps.txt"
for f in $(echo "$APPLIED" | tac); do
  r="$CHAIN/rollback/${f%.sql}_rollback.sql"
  if [ ! -f "$r" ]; then echo "MISSING $f" >> "$OUT/rollback-steps.txt"; continue; fi
  if "${PSQL[@]}" -1 < "$r" > "$OUT/D-$(basename "$r").log" 2>&1; then echo "OK   $f" >> "$OUT/rollback-steps.txt"; else echo "FAIL $f $(grep -m1 ERROR "$OUT/D-$(basename "$r").log")" >> "$OUT/rollback-steps.txt"; fi
done
catalog D; diff "$OUT/catalog-A.txt" "$OUT/catalog-D.txt" > "$OUT/catalog-A-vs-D.diff"
log "rollback: $(grep -c '^OK' "$OUT/rollback-steps.txt") ok, $(grep -c '^FAIL' "$OUT/rollback-steps.txt") failed, $(grep -c '^MISSING' "$OUT/rollback-steps.txt") missing; catalog lines differing from A: $(grep -c '^[<>]' "$OUT/catalog-A-vs-D.diff")"
# E
: > "$OUT/reapply-steps.txt"
for f in $APPLIED; do
  src="$CHAIN/new/$f"; [ -f "$src" ] || src="$CHAIN/p1/$f"
  if "${PSQL[@]}" -1 < "$src" > "$OUT/E-$f.log" 2>&1; then echo "OK   $f" >> "$OUT/reapply-steps.txt"; else echo "FAIL $f $(grep -m1 ERROR "$OUT/E-$f.log")" >> "$OUT/reapply-steps.txt"; fi
done
last=B; [ "${C_OK:-0}" = 1 ] && last=C
catalog E; diff "$OUT/catalog-$last.txt" "$OUT/catalog-E.txt" > "$OUT/catalog-$last-vs-E.diff"
log "re-apply: $(grep -c '^OK' "$OUT/reapply-steps.txt") ok, $(grep -c '^FAIL' "$OUT/reapply-steps.txt") failed; catalog lines differing from $last: $(grep -c '^[<>]' "$OUT/catalog-$last-vs-E.diff")"
for s in $(awk '{print $1}' "$OUT/suite-sources.txt" | grep -E '^test_T_(competition|od31|phase10)[a-z0-9_]*.sql$' | sed 's/.sql$//' | sort -u); do
  [ -f "$CHAIN/tests-$last/$s.sql" ] && run_suite E "$CHAIN/tests-$last" "$s"
done
log "done"; echo DONE > "$OUT/result.txt"
