-- D7 core Organizer Suite release: POSTFLIGHT (read-only; run on DEV and PROD immediately after BOTH migrations).
-- Run:  supabase db query --linked -f scripts/release/d7_core_postflight.sql -o json
-- Every row must have ok = true. Reads catalog metadata and aggregate counts only.
with
 ent as (select oid from pg_class where oid = to_regclass('public.usage_addon_entitlements')),
 ev  as (select oid from pg_class where oid = to_regclass('public.usage_addon_entitlement_events')),
 checks(seq, check_name, ok, detail) as (
  select 1, 'audit table exists with RLS enabled', coalesce((select relrowsecurity from pg_class c join ev on ev.oid = c.oid), false), null
  union all select 2, 'audit table: service_role has SELECT+INSERT only',
        has_table_privilege('service_role','public.usage_addon_entitlement_events','SELECT') and has_table_privilege('service_role','public.usage_addon_entitlement_events','INSERT')
        and not has_table_privilege('service_role','public.usage_addon_entitlement_events','UPDATE')
        and not has_table_privilege('service_role','public.usage_addon_entitlement_events','DELETE')
        and not has_table_privilege('service_role','public.usage_addon_entitlement_events','TRUNCATE'), null
  union all select 3, 'audit table: anon and authenticated have no privileges',
        not has_table_privilege('anon','public.usage_addon_entitlement_events','SELECT') and not has_table_privilege('authenticated','public.usage_addon_entitlement_events','SELECT')
        and not has_table_privilege('anon','public.usage_addon_entitlement_events','INSERT') and not has_table_privilege('authenticated','public.usage_addon_entitlement_events','INSERT'), null
  union all select 4, 'entitlements: anon has NO privileges (was arwdDxtm before)',
        not (has_table_privilege('anon','public.usage_addon_entitlements','SELECT') or has_table_privilege('anon','public.usage_addon_entitlements','INSERT')
          or has_table_privilege('anon','public.usage_addon_entitlements','UPDATE') or has_table_privilege('anon','public.usage_addon_entitlements','DELETE')
          or has_table_privilege('anon','public.usage_addon_entitlements','TRUNCATE')), null
  union all select 5, 'entitlements: authenticated has SELECT only',
        has_table_privilege('authenticated','public.usage_addon_entitlements','SELECT')
        and not (has_table_privilege('authenticated','public.usage_addon_entitlements','INSERT') or has_table_privilege('authenticated','public.usage_addon_entitlements','UPDATE')
          or has_table_privilege('authenticated','public.usage_addon_entitlements','DELETE') or has_table_privilege('authenticated','public.usage_addon_entitlements','TRUNCATE')), null
  union all select 6, 'entitlements: service_role has SELECT, INSERT, UPDATE and not DELETE/TRUNCATE',
        has_table_privilege('service_role','public.usage_addon_entitlements','SELECT') and has_table_privilege('service_role','public.usage_addon_entitlements','INSERT')
        and has_table_privilege('service_role','public.usage_addon_entitlements','UPDATE')
        and not (has_table_privilege('service_role','public.usage_addon_entitlements','DELETE') or has_table_privilege('service_role','public.usage_addon_entitlements','TRUNCATE')), null
  union all select 7, 'entitlements RLS still enabled with its 2 policies',
        (select relrowsecurity from pg_class c join ent on ent.oid = c.oid) and (select count(*) from pg_policy p join ent on p.polrelid = ent.oid) = 2, null
  union all select 8, 'both partial unique indexes on active manual grants exist',
        (select count(*) from pg_indexes where schemaname='public' and indexname in
          ('usage_addon_entitlements_one_active_manual_grant_studio','usage_addon_entitlements_one_active_manual_grant_organizer')) = 2, null
  union all select 9, 'audit, no-truncate and guard triggers exist',
        (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname in ('usage_addon_entitlement_events_guard_trg','usage_addon_entitlement_events_no_truncate_trg','usage_addon_entitlements_audit_trg')) = 3,
        (select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t where not t.tgisinternal and t.tgrelid in (select oid from ent union all select oid from ev))
  union all select 10, 'the 5 end-instant / expiry functions exist',
        (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='public'
           and p.proname in ('usage_addon_entitlement_safe_timezone','usage_addon_entitlement_end_instant','usage_addon_entitlement_start_instant','usage_addon_entitlement_is_current','expire_due_usage_addon_entitlements')) = 5, null
  union all select 11, 'expiry function is executable by service_role only',
        has_function_privilege('service_role','public.expire_due_usage_addon_entitlements(timestamptz,text)','EXECUTE')
        and not has_function_privilege('authenticated','public.expire_due_usage_addon_entitlements(timestamptz,text)','EXECUTE')
        and not has_function_privilege('anon','public.expire_due_usage_addon_entitlements(timestamptz,text)','EXECUTE'), null
  union all select 12, 'audit guard / trigger functions are not executable by clients',
        not has_function_privilege('anon','public.usage_addon_entitlement_events_guard()','EXECUTE') and not has_function_privilege('authenticated','public.usage_addon_entitlement_events_guard()','EXECUTE')
        and not has_function_privilege('anon','public.usage_addon_entitlements_audit()','EXECUTE') and not has_function_privilege('authenticated','public.usage_addon_entitlements_audit()','EXECUTE'), null
  union all select 13, 'no entitlement row was lost or changed by the migration (INFO: rows by source/status; compare with the preflight)',
        true, (select coalesce(string_agg(source || '/' || status || '/' || feature_key || '=' || n, '; ' order by source, status, feature_key), 'none')
               from (select source, status, feature_key, count(*) n from public.usage_addon_entitlements group by 1,2,3) s)
  union all select 14, 'INFO audit events written so far (0 right after apply; the migration backfills nothing)', true, (select count(*)::text from public.usage_addon_entitlement_events)
  union all select 15, 'INFO active manual grants with no period_end', true, (select count(*)::text from public.usage_addon_entitlements where source='manual_grant' and status='active' and period_end is null)
 )
select seq, check_name, ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(ok), false), null from checks
order by seq;
