#!/usr/bin/env bash
# Competition E2 -- evidence run of the E2 SQL suite on the CURRENT database state, for either path:
#   path "no-f2"  : public.event_competition_result_versions does not exist  (expect the original 212 checks)
#   path "with-f2": the real F2 table exists (migration 20270114 applied)    (expect the stub-only steps skipped)
# Usage: bash run_e2_f2_compat.sh <container> <evidence-dir>
# NOT RUN YET (waiting for the Competition DB slot). Writes, into <evidence-dir>:
#   <path>-suite.log          complete psql output of the suite
#   <path>-verdict.txt        the verdict line, check count, exact git head
#   <path>-schema-before.txt / -after.txt   fingerprint of result_versions (columns, constraints, triggers, row count) and of
#                                           every F2 table found, taken before and after the suite
# and fails if any fingerprint changed (the suite must not modify, drop or leave anything of F2 behind).
set -u
export MSYS_NO_PATHCONV=1
C="${1:?container}"; EV="${2:?evidence dir}"
HERE="$(cd "$(dirname "$0")" && pwd)"; SUITE="$HERE/../test_T_competition_e2_ballots.sql"
ROOT="$(cd "$HERE/../../../../../.." && pwd)"
mkdir -p "$EV"
PSQL() { docker exec -i -e PGPASSWORD=postgres "$C" psql -U supabase_admin -d postgres -q "$@"; }

HAS_F2=$(PSQL -At -c "select to_regclass('public.event_competition_result_versions') is not null")
if [ "$HAS_F2" = "t" ]; then P="with-f2"; else P="no-f2"; fi

fingerprint() {
  PSQL -At <<'SQL'
select 'tables', coalesce(string_agg(c.relname || ':' || (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), ',' order by c.relname), 'none')
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and (c.relname like 'event_competition_result%' or c.relname like 'event_competition_round_result%');
select 'result_versions', case when to_regclass('public.event_competition_result_versions') is null then 'absent' else
  (select md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod), ',' order by a.attnum)) from pg_attribute a where a.attrelid = 'public.event_competition_result_versions'::regclass and a.attnum > 0 and not a.attisdropped) end;
select 'result_versions_constraints', case when to_regclass('public.event_competition_result_versions') is null then 'absent' else
  (select md5(string_agg(conname || pg_get_constraintdef(oid), ',' order by conname)) from pg_constraint where conrelid = 'public.event_competition_result_versions'::regclass) end;
select 'result_versions_triggers', case when to_regclass('public.event_competition_result_versions') is null then 'absent' else
  (select coalesce(md5(string_agg(tgname, ',' order by tgname)), 'none') from pg_trigger where tgrelid = 'public.event_competition_result_versions'::regclass and not tgisinternal) end;
SQL
  # row counts of every F2 result table
  for t in $(PSQL -At -c "select relname from pg_class where relnamespace='public'::regnamespace and relkind='r' and (relname like 'event_competition_result%' or relname like 'event_competition_round_result%') order by 1"); do
    echo "rows $t $(PSQL -At -c "select count(*) from public.$t")"
  done
}

HEAD=$(cd "$ROOT" && git rev-parse HEAD)
{ echo "path=$P"; echo "git_head=$HEAD"; echo "container=$C"; echo "started=$(date -u +%FT%TZ)"; } > "$EV/$P-verdict.txt"
fingerprint > "$EV/$P-schema-before.txt"
sed 's/\r$//' "$SUITE" | PSQL > "$EV/$P-suite.log" 2>&1
fingerprint > "$EV/$P-schema-after.txt"

VERDICT=$(grep -E "E2 SQL SUITE (PASS|FAIL)" "$EV/$P-suite.log" | head -1)
echo "verdict=$VERDICT" >> "$EV/$P-verdict.txt"
if diff -q "$EV/$P-schema-before.txt" "$EV/$P-schema-after.txt" >/dev/null; then SAME=1; echo "f2_state_unchanged=yes" >> "$EV/$P-verdict.txt"; else SAME=0; echo "f2_state_unchanged=NO" >> "$EV/$P-verdict.txt"; fi
echo "finished=$(date -u +%FT%TZ)" >> "$EV/$P-verdict.txt"
cat "$EV/$P-verdict.txt"
if echo "$VERDICT" | grep -q "PASS" && [ "$SAME" = "1" ]; then echo "E2 F2-COMPAT ($P) PASS"; exit 0; fi
echo "E2 F2-COMPAT ($P) FAIL"; exit 1
