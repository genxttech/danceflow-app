#!/usr/bin/env bash
# D-1 local M1-only validation on a FRESH disposable stack (nsi-i1-sqlvalidate). Never touches shared DEV/PROD.
set -u
export MSYS_NO_PATHCONV=1
S=/c/Users/mcurt/AppData/Local/Temp/claude/C--Dev-studioapp/909fbce0-6240-4c27-9f3d-a0dac5eec5aa/scratchpad
M=/c/Dev/studioapp-intake-audit/src/lib/supabase/migrations
M1=$M/20261118090000_nsi_i1_m1_config_helpers.sql
R1=$M/rollback/20261118090000_nsi_i1_m1_config_helpers_rollback.sql
DB=supabase_db_nsi-i1-sqlvalidate
PF=$S/d1/d1_postflight_m1.sql
run() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$1" 2>&1 | grep -v '^[[:space:]]*$' | grep -v NOTICE | grep -iv '^ *assert_catalog\|^-*$\|(1 row)'; }
pf() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -F , -1 -v ON_ERROR_STOP=1 -f - < "$PF" 2>&1; }
echo "### $(date -u +%FT%TZ) M1 sha256 $(sha256sum "$M1" | cut -d' ' -f1)"
cd "$S/nsi-i1-sqlvalidate" || exit 2
supabase stop --no-backup >/dev/null 2>&1
supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null 2>&1 || { echo "start failed"; exit 2; }
docker exec "$DB" psql -U postgres -d postgres -X -At -c "select version();"
docker exec -i "$DB" psql -U postgres -d postgres -X -q < public_schema_dump.sql > "$S/d1/restore.out" 2> "$S/d1/restore.err"
echo "restore errors: $(sort -u "$S/d1/restore.err" | tr '\n' ' ')"
echo "intake objects before: $(docker exec "$DB" psql -U postgres -d postgres -X -At -c "select count(*) from pg_class where relname like 'intake\_%';")"
echo "### apply M1 (1st)"; out=$(run "$M1"); echo "output=[${out}]"
echo "### postflight after 1st apply"; pf > "$S/d1/local_pf1.csv"; cat "$S/d1/local_pf1.csv"
echo "### re-apply M1 (2nd)"; out=$(run "$M1"); echo "output=[${out}]"
pf > "$S/d1/local_pf2.csv"
diff "$S/d1/local_pf1.csv" "$S/d1/local_pf2.csv" > /dev/null && echo "RE-APPLY: postflight identical" || { echo "RE-APPLY DIFF:"; diff "$S/d1/local_pf1.csv" "$S/d1/local_pf2.csv"; }
echo "### local rollback eligibility probe (M1 rollback, then re-apply)"
out=$(run "$R1"); echo "rollback output=[${out}]"
echo "intake objects after rollback: $(docker exec "$DB" psql -U postgres -d postgres -X -At -c "select (select count(*) from pg_class where relname like 'intake\_%') + (select count(*) from pg_proc where proname like 'intake\_%') + (select count(*) from pg_namespace where nspname='intake_private') + (select count(*) from pg_roles where rolname='intake_destructive');")"
out=$(run "$M1"); echo "re-apply after rollback output=[${out}]"
pf > "$S/d1/local_pf3.csv"
diff "$S/d1/local_pf1.csv" "$S/d1/local_pf3.csv" > /dev/null && echo "AFTER ROLLBACK+RE-APPLY: postflight identical" || { echo "DIFF:"; diff "$S/d1/local_pf1.csv" "$S/d1/local_pf3.csv"; }
echo "### $(date -u +%FT%TZ) done"
