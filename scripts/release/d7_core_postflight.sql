-- D7 core Organizer Suite release: POSTFLIGHT (read-only; run on DEV and PROD immediately after BOTH migrations).
-- Run via scripts/release/d7_core_flight.sh (asserts row 99 and stores the raw output with a sha256), or directly:
--   supabase db query --linked -f scripts/release/d7_core_postflight.sql -o json
-- Every row must have ok = true. Reads catalog metadata and aggregate counts only. Safe on an unapplied or partial target:
-- it reports failing rows instead of erroring (missing objects evaluate to false).
-- Exact ACLs are compared as SORTED sets, so the order PostgreSQL stored them in does not matter.
with
 ent as (select to_regclass('public.usage_addon_entitlements') as oid),
 ev  as (select to_regclass('public.usage_addon_entitlement_events') as oid),
 acl_ent as (select coalesce((select array_agg(a::text order by a::text) from pg_class c, unnest(c.relacl) a where c.oid = (select oid from ent)), '{}') as v),
 acl_ev  as (select coalesce((select array_agg(a::text order by a::text) from pg_class c, unnest(c.relacl) a where c.oid = (select oid from ev)), '{}') as v),
 fn(name, expected) as (values
   ('expire_due_usage_addon_entitlements(timestamptz,text)', array['postgres=X/postgres','service_role=X/postgres']),
   ('usage_addon_entitlement_end_instant(date,text)', array['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']),
   ('usage_addon_entitlement_start_instant(date,text)', array['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']),
   ('usage_addon_entitlement_safe_timezone(text)', array['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']),
   ('usage_addon_entitlement_is_current(text,date,date,text,timestamptz)', array['authenticated=X/postgres','postgres=X/postgres','service_role=X/postgres']),
   ('usage_addon_entitlement_events_guard()', array['postgres=X/postgres']),
   ('usage_addon_entitlements_audit()', array['postgres=X/postgres'])),
 fn_state as (
   select f.name, f.expected,
          coalesce((select array_agg(a::text order by a::text) from pg_proc p, unnest(p.proacl) a where p.oid = to_regprocedure('public.' || f.name)), '{}') as actual,
          to_regprocedure('public.' || f.name) is not null as present
   from fn f),
 checks(seq, check_name, ok, detail) as (
  select 1, 'audit table exists with RLS enabled',
         coalesce((select relrowsecurity from pg_class c where c.oid = (select oid from ev)), false), null
  union all select 2, 'audit table ACL is exactly postgres (owner) + service_role SELECT/INSERT',
         (select oid from ev) is not null and (select v from acl_ev) = array['postgres=arwdDxtm/postgres','service_role=ar/postgres'], (select v::text from acl_ev)
  union all select 3, 'audit table: anon and authenticated have no privilege of any kind',
         (select oid from ev) is not null and not exists (select 1 from pg_class c, aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
                                                          where c.oid = (select oid from ev) and r.rolname in ('anon','authenticated')), null
  union all select 4, 'entitlements: anon has NO privilege of any kind (was arwdDxtm before; REFERENCES/TRIGGER/MAINTAIN included)',
         (select oid from ent) is not null and not exists (select 1 from pg_class c, aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
                                                           where c.oid = (select oid from ent) and r.rolname = 'anon'), null
  union all select 5, 'entitlements ACL is exactly: owner full, authenticated SELECT, service_role SELECT/INSERT/UPDATE',
         (select oid from ent) is not null and (select v from acl_ent) = array['authenticated=r/postgres','postgres=arwdDxtm/postgres','service_role=arw/postgres'], (select v::text from acl_ent)
  union all select 6, 'entitlements RLS still enabled with its 2 policies',
         coalesce((select relrowsecurity from pg_class c where c.oid = (select oid from ent)), false)
         and (select count(*) from pg_policy p where p.polrelid = (select oid from ent)) = 2, null
  union all select 7, 'both partial unique indexes on active manual grants exist, are valid and are partial',
         (select count(*) from pg_index i join pg_class ic on ic.oid = i.indexrelid
           where i.indrelid = (select oid from ent) and ic.relname in ('usage_addon_entitlements_one_active_manual_grant_studio','usage_addon_entitlements_one_active_manual_grant_organizer')
             and i.indisvalid and i.indisunique and i.indpred is not null) = 2, null
  union all select 8, 'audit trigger is attached to the entitlements table and ENABLED',
         exists (select 1 from pg_trigger t where t.tgrelid = (select oid from ent) and t.tgname = 'usage_addon_entitlements_audit_trg' and not t.tgisinternal and t.tgenabled = 'O'), null
  union all select 9, 'append-only guard and no-truncate triggers are attached to the audit table and ENABLED',
         (select count(*) from pg_trigger t where t.tgrelid = (select oid from ev) and not t.tgisinternal and t.tgenabled = 'O'
            and t.tgname in ('usage_addon_entitlement_events_guard_trg','usage_addon_entitlement_events_no_truncate_trg')) = 2, null
  union all select 10, 'all 7 D7 functions exist',
         (select count(*) filter (where present) from fn_state) = 7, (select string_agg(name, ', ') from fn_state where not present)
  union all select 11, 'every D7 function has exactly the intended EXECUTE grants (expiry: service_role only; helpers: authenticated + service_role; triggers: none)',
         (select bool_and(present and actual = (select array_agg(e order by e) from unnest(expected) e)) from fn_state),
         (select string_agg(name || ' => ' || actual::text, '; ') from fn_state where actual <> (select array_agg(e order by e) from unnest(expected) e))
  union all select 12, 'anon cannot execute any D7 function',
         not exists (select 1 from fn_state f where present and has_function_privilege('anon', to_regprocedure('public.' || f.name), 'EXECUTE')), null
  union all select 13, 'INFO entitlement rows by source/status (compare with the preflight: nothing may be lost or changed)',
         true, (select coalesce(string_agg(source || '/' || status || '/' || feature_key || '=' || n, '; ' order by source, status, feature_key), 'none')
                from (select source, status, feature_key, count(*) n from public.usage_addon_entitlements group by 1,2,3) s)
  union all select 14, 'INFO audit events written so far (0 right after apply: the migration backfills nothing; record each grant below as the audit baseline)',
         true, case when (select oid from ev) is null then 'audit table missing'
              -- dynamic SQL: a static reference would make the whole script error on a target where the table does not exist yet
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.usage_addon_entitlement_events', false, true, '')))[1]::text end
  union all select 15, 'INFO active manual grants with no period_end', true,
         (select count(*)::text from public.usage_addon_entitlements where source='manual_grant' and status='active' and period_end is null)
  union all select 16, 'INFO audit baseline: every manual grant (id / status / period) as it stands after apply', true,
         (select coalesce(string_agg(id::text || ' ' || status || ' ' || coalesce(period_start::text,'-') || '..' || coalesce(period_end::text,'-'), '; ' order by id), 'none')
          from public.usage_addon_entitlements where source = 'manual_grant')
 )
select seq, check_name, coalesce(ok, false) as ok, detail from checks
union all select 99, 'ALL CHECKS PASS', coalesce(bool_and(coalesce(ok, false)), false), null from checks
order by seq;
