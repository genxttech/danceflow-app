-- Read-only. Run with: sb.sh prod-read docs/mobile/proposals/p5_instructor_preflight.sql  (before AND after the apply; the postflight expects the second column set)
select
  f.name as function_name,
  p.oid is not null as exists,
  coalesce(has_function_privilege('authenticated', p.oid, 'execute'), false) as authenticated_can_execute,
  coalesce(has_function_privilege('anon', p.oid, 'execute'), false) as anon_can_execute,
  p.prosecdef as security_definer
from (values
  ('get_teaching_clients_for_instructor'),
  ('search_bookable_clients_for_instructor'),
  ('get_class_roster_names_for_instructor')
) as f(name)
left join pg_proc p on p.proname = f.name and p.pronamespace = 'public'::regnamespace
union all
select 'instructor_role_rows=' || count(*)::text, true, false, false, false
  from public.user_studio_roles where active and role = 'instructor'
union all
select 'phase_b_clients_policy_present', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clients' and policyname = 'studio staff manage clients'), false, false, false
order by 1;
