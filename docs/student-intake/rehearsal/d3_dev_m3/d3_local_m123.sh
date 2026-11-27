#!/usr/bin/env bash
# D-3 local M1+M2+M3 validation on a FRESH disposable stack (nsi-i1-sqlvalidate). Never touches shared DEV/PROD.
set -u
export MSYS_NO_PATHCONV=1
S=/c/Users/mcurt/AppData/Local/Temp/claude/C--Dev-studioapp/909fbce0-6240-4c27-9f3d-a0dac5eec5aa/scratchpad
M=/c/Dev/studioapp-intake-audit/src/lib/supabase/migrations
M1=$M/20261118090000_nsi_i1_m1_config_helpers.sql; M2=$M/20261118091000_nsi_i1_m2_governance.sql; M3=$M/20261118092000_nsi_i1_m3_live_personal.sql
R1=$M/rollback/20261118090000_nsi_i1_m1_config_helpers_rollback.sql; R2=$M/rollback/20261118091000_nsi_i1_m2_governance_rollback.sql; R3=$M/rollback/20261118092000_nsi_i1_m3_live_personal_rollback.sql
DB=supabase_db_nsi-i1-sqlvalidate
PF=$S/d3/d3_postflight_m123.sql
run() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$1" 2>&1 | grep -v '^[[:space:]]*$' | grep -v NOTICE | grep -iv '^ *assert_catalog\|^-*$\|(1 row)'; }
pf() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -F , -1 -v ON_ERROR_STOP=1 -f - < "$1" 2>&1; }
cnt() { docker exec "$DB" psql -U postgres -d postgres -X -At -c "select (select count(*) from pg_class where relname like 'intake\_%' and relkind = 'r') || ' tables / ' || (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'intake_private' or p.proname like 'intake\_%') || ' functions / role=' || (select count(*) from pg_roles where rolname = 'intake_destructive');"; }
echo "### $(date -u +%FT%TZ) M1 $(sha256sum "$M1" | cut -c1-12)  M2 $(sha256sum "$M2" | cut -c1-12)  M3 $(sha256sum "$M3" | cut -d' ' -f1)"
cd "$S/nsi-i1-sqlvalidate" || exit 2
supabase stop --no-backup >/dev/null 2>&1
supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null 2>&1 || { echo "start failed"; exit 2; }
docker exec "$DB" psql -U postgres -d postgres -X -At -c "select version();"
docker exec -i "$DB" psql -U postgres -d postgres -X -q < public_schema_dump.sql > "$S/d3/restore.out" 2> "$S/d3/restore.err"
echo "restore errors: $(sort -u "$S/d3/restore.err" | tr '\n' ' ')"
echo "before: $(cnt)"
echo "### apply M1, M2, M3"; echo "M1 output=[$(run "$M1")]"; echo "M2 output=[$(run "$M2")]"; echo "M3 output=[$(run "$M3")]"
echo "after: $(cnt)"
echo "### postflight (pf1)"; pf "$PF" > "$S/d3/local_pf1.csv"; cat "$S/d3/local_pf1.csv"
echo "### governance behaviour probe (rolled back)"; docker exec -i "$DB" psql -U postgres -d postgres -X -q -f - < "$S/d3/d3_local_behavior.sql" 2>&1 | grep -E "BEHAVIOUR"
pf "$PF" > "$S/d3/local_pf1b.csv"; diff -q "$S/d3/local_pf1.csv" "$S/d3/local_pf1b.csv" >/dev/null && echo "probe left no trace: postflight identical" || { echo "PROBE LEFT A TRACE"; diff "$S/d3/local_pf1.csv" "$S/d3/local_pf1b.csv"; }
echo "### re-apply M3"; echo "M3 output=[$(run "$M3")]"; pf "$PF" > "$S/d3/local_pf2.csv"
diff -q "$S/d3/local_pf1.csv" "$S/d3/local_pf2.csv" >/dev/null && echo "RE-APPLY M3: postflight identical" || { echo "RE-APPLY DIFF"; diff "$S/d3/local_pf1.csv" "$S/d3/local_pf2.csv"; }
echo "### guarded M3 rollback on the unused database"; echo "R3 output=[$(run "$R3")]"; echo "after M3 rollback: $(cnt)"
echo "assert_catalog with M1+M2 only: [$(docker exec "$DB" psql -U postgres -d postgres -X -At -c 'select intake_private.assert_catalog();' 2>&1)]"
echo "M3 output=[$(run "$M3")]"; pf "$PF" > "$S/d3/local_pf3.csv"
diff -q "$S/d3/local_pf1.csv" "$S/d3/local_pf3.csv" >/dev/null && echo "M3 ROLLBACK + RE-APPLY: postflight identical" || { echo "DIFF"; diff "$S/d3/local_pf1.csv" "$S/d3/local_pf3.csv"; }
echo "### guarded M3+M2+M1 rollback"; echo "R3=[$(run "$R3")] R2=[$(run "$R2")] R1=[$(run "$R1")]"; echo "after full rollback: $(cnt)"
echo "M1=[$(run "$M1")] M2=[$(run "$M2")] M3=[$(run "$M3")]"; pf "$PF" > "$S/d3/local_pf4.csv"
diff -q "$S/d3/local_pf1.csv" "$S/d3/local_pf4.csv" >/dev/null && echo "FULL ROLLBACK + RE-APPLY: postflight identical" || { echo "DIFF"; diff "$S/d3/local_pf1.csv" "$S/d3/local_pf4.csv"; }
echo "### $(date -u +%FT%TZ) done"
