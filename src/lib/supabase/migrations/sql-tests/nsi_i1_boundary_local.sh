#!/usr/bin/env bash
# NSI I1 -- migration-boundary, idempotency and rollback harness. LOCAL DISPOSABLE STACKS ONLY.
#
# Usage: nsi_i1_boundary_local.sh <docker-db-container> <migrations-dir>
#   The container must be a disposable local Supabase DB container whose name starts with "supabase_db_nsi"
#   (refuses otherwise). NEVER point this at shared DEV or PROD: it applies and rolls back the NSI migrations and,
#   in its last step, writes the permanent first-use marker on purpose.
# Checks:
#   B1  rollback M5..M1 to a clean state (no intake objects, schema or role)
#   B0  fingerprint self-test: a component-less table yields MISSING (fail closed, never an empty match)
#   B2  pre-apply fingerprints (appointments triggers/constraints/indexes/inbound FKs, all present; non-intake catalog)
#   B3  each boundary M1..Mk applies alone, passes assert_catalog, and rolls back cleanly (k = 1..5)
#   B4  full apply twice -> identical NSI catalog fingerprint (idempotent)
#   B5  appointments and non-intake catalog fingerprints unchanged by M1..M5
#   B6  rollback refused while configuration rows exist without the export acknowledgment; allowed with it
#   B7  rollback aborts cleanly on lock timeout while another session holds an NSI table lock
#   B9  each migration re-applied ALONE after the full apply (M1 after M5 included) leaves the catalog fingerprint
#       unchanged and assert_catalog passing (no stripped grants)
#   B10 a reference-free operational audit event (e.g. a dark drift report) keeps the rollback eligible
#   B11 a security audit event that references a client blocks the rollback (forward-fix only)
#   B8  rollback refused permanently once the environment first-use marker exists
set -u
DB="${1:?container}"; M="${2:?migrations dir}"
case "$DB" in supabase_db_nsi*) ;; *) echo "refused: container must be a disposable local stack named supabase_db_nsi*"; exit 2;; esac
export MSYS_NO_PATHCONV=1
q() { docker exec -i "$DB" psql -U postgres -d postgres -X -At -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
f() { docker exec -i "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$1" 2>&1 | grep -v '^[[:space:]]*$' | grep -v NOTICE | grep -iv '^ *assert_catalog\|^-*$\|(1 row)'; }
fa() { docker exec -i -e PGOPTIONS="${2:-}" "$DB" psql -U postgres -d postgres -X -q -v ON_ERROR_STOP=1 -f - < "$1" 2>&1 | grep -v '^[[:space:]]*$' | grep -v NOTICE | grep -iv '^ *assert_catalog\|^-*$\|(1 row)'; }
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
ko() { echo "FAIL $1 :: $2"; fail=$((fail+1)); }
MIG=(20261118090000_nsi_i1_m1_config_helpers 20261118091000_nsi_i1_m2_governance 20261118092000_nsi_i1_m3_live_personal 20261118093000_nsi_i1_m4_retained_evidence 20261118094000_nsi_i1_m5_functions)
nsi_objects() { q "select (select count(*) from pg_class where relname like 'intake\_%') + (select count(*) from pg_proc where proname like 'intake\_%') + (select count(*) from pg_namespace where nspname='intake_private') + (select count(*) from pg_roles where rolname='intake_destructive');"; }
nsi_fp() { q "select md5(coalesce(string_agg(x, '|' order by x), '')) from (
  select 'rel:'||c.relname||':'||coalesce(c.relacl::text,'')||':'||c.relrowsecurity as x from pg_class c where c.relname like 'intake\_%'
  union all select 'fn:'||n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||'):'||pg_get_userbyid(p.proowner)||':'||coalesce(p.proacl::text,'')||':'||md5(p.prosrc)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname like 'intake\_%' or n.nspname='intake_private'
  union all select 'pol:'||tablename||'.'||policyname||':'||roles::text||':'||coalesce(qual,'') from pg_policies where tablename like 'intake\_%'
  union all select 'trg:'||tgrelid::regclass::text||'.'||tgname from pg_trigger where tgrelid::regclass::text like '%intake\_%' and not tgisinternal) s;"; }
# Fingerprint of a table's triggers, constraints, indexes and inbound FKs. Fails closed: if any component is empty
# the result is 'MISSING:<components>' (never an md5 of a partial or empty set), so two empty readings cannot match.
fp_of() { q "select case when tr is null or co is null or ix is null or fk is null
                  then 'MISSING:' || concat_ws(',', case when tr is null then 'triggers' end, case when co is null then 'constraints' end,
                                               case when ix is null then 'indexes' end, case when fk is null then 'inbound_fks' end)
                  else md5(tr || co || ix || fk) end
  from (select (select string_agg(tgname||pg_get_triggerdef(oid),'|' order by tgname) from pg_trigger where tgrelid='public.$1'::regclass and not tgisinternal) tr,
               (select string_agg(conname||pg_get_constraintdef(oid),'|' order by conname) from pg_constraint where conrelid='public.$1'::regclass) co,
               (select string_agg(indexdef,'|' order by indexname) from pg_indexes where schemaname='public' and tablename='$1') ix,
               (select string_agg(conrelid::regclass::text||conname,'|' order by conname) from pg_constraint where confrelid='public.$1'::regclass) fk) s;"; }
appt_fp() { fp_of appointments; }
other_fp() { q "select md5(string_agg(relname||':'||coalesce(relacl::text,''), '|' order by relname)) from pg_class where relnamespace='public'::regnamespace and relname not like 'intake\_%';"; }
rollback_all() { for ((i=${#MIG[@]}-1; i>=0; i--)); do out=$(f "$M/rollback/${MIG[$i]}_rollback.sql"); [ -n "$out" ] && echo "   rollback ${MIG[$i]}: $out"; done; }

# B1
if [ "$(nsi_objects)" != "0" ]; then rollback_all; fi
[ "$(nsi_objects)" = "0" ] && ok "B1 rollback M5..M1 leaves no intake object, schema or role" || ko "B1" "objects remain: $(nsi_objects)"
# B0 fingerprint self-test: a table with no triggers, indexes or inbound FKs must yield MISSING, never a value
q "create table public.nsi_zz_fp_probe (id int);" >/dev/null
probe=$(fp_of nsi_zz_fp_probe)
q "drop table public.nsi_zz_fp_probe;" >/dev/null
case "$probe" in MISSING:*triggers*indexes*inbound_fks*) ok "B0 fingerprint fails closed when a component is missing ($probe)";; *) ko "B0" "probe fingerprint=[$probe]";; esac
# B2 (every component of the pre-apply appointments fingerprint must be present)
APPT0=$(appt_fp); OTHER0=$(other_fp); echo "info appointments fp=$APPT0 other fp=$OTHER0"
case "$APPT0" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) [ ${#APPT0} -eq 32 ] && ok "B2 pre-apply appointments fingerprint complete" || ko "B2" "$APPT0";; *) ko "B2 pre-apply appointments fingerprint incomplete" "$APPT0";; esac
# B3
for k in 1 2 3 4 5; do
  err=""
  for ((i=0; i<k; i++)); do out=$(f "$M/${MIG[$i]}.sql"); [ -n "$out" ] && err="$err apply ${MIG[$i]}: $out"; done
  cat=$(q "select intake_private.assert_catalog();")
  for ((i=k-1; i>=0; i--)); do out=$(f "$M/rollback/${MIG[$i]}_rollback.sql"); [ -n "$out" ] && err="$err rollback ${MIG[$i]}: $out"; done
  left=$(nsi_objects)
  if [ -z "$err" ] && [ -z "$cat" ] && [ "$left" = "0" ]; then ok "B3 boundary M1..M$k applies, self-checks and rolls back cleanly"; else ko "B3 boundary M1..M$k" "err=[$err] catalog=[$cat] left=$left"; fi
done
# B4
for i in 0 1 2 3 4; do out=$(f "$M/${MIG[$i]}.sql"); [ -n "$out" ] && echo "   apply#1 ${MIG[$i]}: $out"; done
FP1=$(nsi_fp)
for i in 0 1 2 3 4; do out=$(f "$M/${MIG[$i]}.sql"); [ -n "$out" ] && echo "   apply#2 ${MIG[$i]}: $out"; done
FP2=$(nsi_fp)
[ "$FP1" = "$FP2" ] && ok "B4 re-applying M1..M5 is idempotent (NSI catalog fp $FP1)" || ko "B4" "$FP1 vs $FP2"
# B5
APPT1=$(appt_fp)
if [ ${#APPT0} -eq 32 ] && [ "$APPT1" = "$APPT0" ]; then ok "B5a appointments triggers/constraints/indexes/inbound FKs unchanged"; else ko "B5a" "$APPT1 vs $APPT0"; fi
[ "$(other_fp)" = "$OTHER0" ] && ok "B5b non-intake public relations and ACLs unchanged" || ko "B5b" "$(other_fp) vs $OTHER0"
# B9
for i in 0 1 2 3 4; do
  out=$(f "$M/${MIG[$i]}.sql"); fp=$(nsi_fp); cat=$(q "select intake_private.assert_catalog();")
  if [ -z "$out" ] && [ "$fp" = "$FP1" ] && [ -z "$cat" ]; then ok "B9 re-applying ${MIG[$i]} alone after M5 leaves the catalog unchanged"
  else ko "B9 ${MIG[$i]}" "out=[$out] fp=$fp cat=[$cat]"; fi
done
# B10
q "insert into public.studios (id, name, slug) values ('a5300000-0000-0000-0000-00000000000a', 'NSI boundary studio', 'nsi-boundary-a53') on conflict do nothing;
   select intake_private.audit_write('a5300000-0000-0000-0000-00000000000a', 'drift_report_run', 'staff', null, 'studio_owner', null, null, null, null, null, '{}'::jsonb, 'operational');" >/dev/null
out=$(f "$M/rollback/${MIG[4]}_rollback.sql")
[ -z "$out" ] && ok "B10 reference-free operational audit event keeps the rollback eligible" || ko "B10" "$out"
out=$(f "$M/${MIG[4]}.sql"); [ -n "$out" ] && echo "   re-apply M5: $out"
# B6
q "insert into public.intake_templates (studio_id, name) values ('a5300000-0000-0000-0000-00000000000a', 'cfg');" >/dev/null
out=$(f "$M/rollback/${MIG[4]}_rollback.sql")
case "$out" in *nsi_rollback_refused_data_present*configuration*) ok "B6a rollback refused while configuration rows exist without acknowledgment";; *) ko "B6a" "$out";; esac
out=$(fa "$M/rollback/${MIG[4]}_rollback.sql" "-c nsi.rollback_config_export=$(printf 'cfg' | sha256sum | cut -c1-64)")
[ -z "$out" ] && ok "B6b rollback allowed with an exported-config acknowledgment" || ko "B6b" "$out"
out=$(f "$M/${MIG[4]}.sql"); [ -n "$out" ] && echo "   re-apply M5: $out"
# B7
docker exec -d "$DB" psql -U postgres -d postgres -X -c "begin; lock table public.intake_requests in access share mode; select pg_sleep(15); commit;"
sleep 2
out=$(fa "$M/rollback/${MIG[4]}_rollback.sql" "-c nsi.rollback_config_export=$(printf 'cfg' | sha256sum | cut -c1-64)")
case "$out" in *"lock timeout"*|*"canceling statement due to lock timeout"*) ok "B7 rollback aborts cleanly on lock timeout";; *) ko "B7" "$out";; esac
[ "$(q "select count(*) from pg_proc where proname='intake_submit_response';")" = "1" ] && ok "B7b nothing was dropped by the aborted rollback" || ko "B7b" "M5 function missing"
sleep 14
# B11 (writes a permanent security event: runs after B6/B7)
q "insert into public.clients (id, studio_id, first_name, last_name) values ('a5300000-0000-0000-0000-0000000000c1', 'a5300000-0000-0000-0000-00000000000a', 'B', '11') on conflict do nothing;
   select intake_private.audit_write('a5300000-0000-0000-0000-00000000000a', 'tenant_drift_detected', 'system', null, null, null, 'a5300000-0000-0000-0000-0000000000c1', null, null, null, '{}'::jsonb, 'security');" >/dev/null
out=$(fa "$M/rollback/${MIG[4]}_rollback.sql" "-c nsi.rollback_config_export=$(printf 'cfg' | sha256sum | cut -c1-64)")
case "$out" in *"non-configuration audit events"*) ok "B11 a client-referencing security event blocks the rollback";; *) ko "B11" "$out";; esac
# B8 (writes the permanent marker: run last)
q "insert into public.intake_audit_events (studio_id, event_type, actor_type, retention_class, retention_state) values (null, 'environment_first_personal_use', 'system', 'environment_marker', 'permanent_marker');" >/dev/null
out=$(fa "$M/rollback/${MIG[4]}_rollback.sql" "-c nsi.rollback_config_export=$(printf 'cfg' | sha256sum | cut -c1-64)")
case "$out" in *"environment first-use marker"*) ok "B8 rollback refused permanently once the first-use marker exists";; *) ko "B8" "$out";; esac
echo "SUMMARY boundary: $pass passed, $fail failed"
[ "$fail" = "0" ]
