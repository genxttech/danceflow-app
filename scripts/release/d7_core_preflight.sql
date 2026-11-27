-- D7 core Organizer Suite release: PREFLIGHT (read-only; safe to run on DEV and PROD, before the migrations).
-- Run:  supabase db query --linked -f scripts/release/d7_core_preflight.sql -o json   (workdir linked to the target project)
-- Every row must have ok = true (info rows are always true). Save the output as release evidence. Re-run immediately before the apply.
-- Reads catalog metadata and aggregate counts only: no row contents, no customer data.
with
 rel as (select c.oid, c.relrowsecurity, c.relacl::text as acl from pg_class c where c.oid = to_regclass('public.usage_addon_entitlements')),
 checks(seq, check_name, ok, detail) as (
  select 1, 'entitlements table exists', to_regclass('public.usage_addon_entitlements') is not null, null
  union all select 2, 'entitlements RLS enabled', coalesce((select relrowsecurity from rel), false), null
  union all select 3, 'entitlements has exactly 2 RLS policies (studio, organizer SELECT)',
        (select count(*) from pg_policy p join rel on p.polrelid = rel.oid) = 2, (select count(*)::text from pg_policy p join rel on p.polrelid = rel.oid)
  union all select 4, 'no column-level grants on entitlements (migration 20270203100000 refuses otherwise)',
        not exists (select 1 from pg_attribute a join rel on a.attrelid = rel.oid where a.attacl is not null), null
  union all select 5, 'entitlements ACL is the known PRE-state (anon/authenticated/service_role = arwdDxtm)',
        (select acl from rel) = '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}',
        (select acl from rel)
  union all select 6, 'studios.timezone exists (end-instant rule needs it)',
        exists (select 1 from information_schema.columns where table_schema='public' and table_name='studios' and column_name='timezone'), null
  union all select 7, 'organizers table exists', to_regclass('public.organizers') is not null, null
  union all select 8, 'D7 audit table is ABSENT (not yet applied)', to_regclass('public.usage_addon_entitlement_events') is null, null
  union all select 9, 'D7 functions are ABSENT (not yet applied)',
        not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname='public' and (p.proname like 'usage_addon_entitlement%' or p.proname = 'expire_due_usage_addon_entitlements')),
        (select string_agg(p.proname, ',') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname='public' and (p.proname like 'usage_addon_entitlement%' or p.proname = 'expire_due_usage_addon_entitlements'))
  union all select 10, 'D7 partial unique indexes are ABSENT (not yet applied)',
        not exists (select 1 from pg_indexes where schemaname='public' and indexname like 'usage_addon_entitlements_one_active_manual_grant%'), null
  union all select 11, 'no workspace holds more than one ACTIVE manual_grant (the unique indexes would fail to build)',
        not exists (select 1 from public.usage_addon_entitlements where source='manual_grant' and status='active' and studio_id is not null
                    group by studio_id, feature_key having count(*) > 1)
        and not exists (select 1 from public.usage_addon_entitlements where source='manual_grant' and status='active' and organizer_id is not null
                    group by organizer_id, feature_key having count(*) > 1), null
  union all select 12, 'competition desk RPC exists (the app gate relies on it)',
        to_regprocedure('public.record_competition_checkin_payment(uuid,uuid,numeric,text,text)') is not null, null
  union all select 13, 'INFO entitlement rows by source/status',
        true, (select coalesce(string_agg(source || '/' || status || '/' || feature_key || '=' || n, '; ' order by source, status, feature_key), 'none')
               from (select source, status, feature_key, count(*) n from public.usage_addon_entitlements group by 1,2,3) s)
  union all select 14, 'INFO active manual grants with no period_end (never expire until a date is set)',
        true, (select count(*)::text from public.usage_addon_entitlements where source='manual_grant' and status='active' and period_end is null)
  union all select 15, 'INFO day-one impact: organizers / organizer events / organizer orders in the last 90 days',
        true, (select count(*) from public.organizers)::text || ' / ' || (select count(*) from public.events where organizer_id is not null)::text || ' / ' ||
              (select count(*) from public.event_orders o join public.events e on e.id = o.event_id where e.organizer_id is not null and o.created_at > now() - interval '90 days')::text
  union all select 16, 'INFO supabase migration history table', true, coalesce(to_regclass('supabase_migrations.schema_migrations')::text, 'absent')
 )
select seq, check_name, ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(ok), false), null from checks
order by seq;
