-- READ-ONLY postflight for 20270221090000 (claim function) + 20270221091000 (index). Counts and catalog facts only; no emails.
-- Run with: bash C:/Users/mcurt/danceflow-ops/sb.sh prod-read <this file>   (one jsonb result row)
-- Compare unclaimed_counts with the preflight: an apply of the migrations alone must change NOTHING (the function is not called by SQL).
select jsonb_build_object(
  'function', (select to_jsonb(t) from (select
      p.proname, p.pronargs as nargs, p.prorettype::regtype::text as returns, p.prosecdef as security_definer,
      pg_get_userbyid(p.proowner) as owner, p.proconfig as config,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
      has_function_privilege('anon', p.oid, 'execute') as anon_exec,
      has_function_privilege('service_role', p.oid, 'execute') as service_role_exec,
      (select count(*) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_grants,
      (select coalesce(jsonb_agg(distinct pg_get_userbyid(a.grantee)), '[]'::jsonb) from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> 0) as grantees
      from pg_proc p where p.oid = to_regprocedure('public.claim_my_event_registrations()')) t),
  'index', (select to_jsonb(t) from (select c.relname, i.indisvalid as valid, i.indisready as ready, pg_get_indexdef(i.indexrelid) as definition
      from pg_index i join pg_class c on c.oid = i.indexrelid where c.oid = to_regclass('public.event_registrations_unclaimed_email_idx')) t),
  'invalid_indexes_on_table', (select count(*) from pg_index i where i.indrelid = 'public.event_registrations'::regclass and not i.indisvalid),
  'unclaimed_counts', (select to_jsonb(t) from (select
      count(*) as total_registrations,
      count(*) filter (where user_id is null) as unclaimed,
      count(*) filter (where user_id is not null) as owned,
      max(updated_at) as max_updated_at
      from public.event_registrations) t)
) as postflight;
