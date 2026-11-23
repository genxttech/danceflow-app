#!/usr/bin/env bash
# D-5 local baseline: fresh disposable stack, M1-M4 then M5 (same order as DEV), full-foundation postflight, DEV-safe suite.
set -u
export MSYS_NO_PATHCONV=1
S=/c/Users/mcurt/AppData/Local/Temp/claude/C--Dev-studioapp/909fbce0-6240-4c27-9f3d-a0dac5eec5aa/scratchpad
M=/c/Dev/studioapp-intake-audit/src/lib/supabase/migrations
DB=supabase_db_nsi-i1-sqlvalidate
cd "$S/nsi-i1-sqlvalidate" || exit 2
supabase stop --no-backup >/dev/null 2>&1
supabase start -x gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null 2>&1 || { echo "start failed"; exit 2; }
docker exec -i "$DB" psql -U postgres -d postgres -X -q < public_schema_dump.sql > /dev/null 2> "$S/d5/restore.err"
echo "### $(date -u +%FT%TZ) M5 $(sha256sum $M/20261118094000_nsi_i1_m5_functions.sql | cut -d' ' -f1)"
bash "$S/nsi_apply.sh" a 4
echo "M4 state: $(docker exec "$DB" psql -U postgres -d postgres -X -At -c 'select intake_private.assert_catalog();' 2>&1)[ok if empty]"
out=$(docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$M/20261118094000_nsi_i1_m5_functions.sql" 2>&1 | grep -v '^[[:space:]]*$' | grep -v NOTICE | grep -iv '^ *assert_catalog\|^-*$\|(1 row)')
echo "M5 apply output=[$out]"
docker exec -i "$DB" psql -U postgres -d postgres -X -At -F , -1 -v ON_ERROR_STOP=1 -f - < "$S/d5/d5_postflight_full.sql" > "$S/d5/local_pf.csv" 2>&1
cat "$S/d5/local_pf.csv"
FP=$(docker exec "$DB" psql -U postgres -d postgres -X -At -c "select md5((select string_agg(tgname||pg_get_triggerdef(oid),'|' order by tgname) from pg_trigger where tgrelid='public.appointments'::regclass and not tgisinternal) || (select string_agg(conname||pg_get_constraintdef(oid),'|' order by conname) from pg_constraint where conrelid='public.appointments'::regclass) || (select string_agg(indexdef,'|' order by indexname) from pg_indexes where schemaname='public' and tablename='appointments') || (select coalesce(string_agg(conrelid::regclass::text||conname,'|' order by conname),'') from pg_constraint where confrelid='public.appointments'::regclass));")
docker exec -i -e PGOPTIONS="-c nsi.appointments_fp=$FP" "$DB" psql -U postgres -d postgres -X -q -f - < "$M/sql-tests/test_T_nsi_i1_foundation.sql" 2>&1 | grep SUITE
supabase stop --no-backup >/dev/null 2>&1
echo "### done (stack removed)"
