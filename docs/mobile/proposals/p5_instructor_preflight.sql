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
-- columns the teaching function reads for its caller conditions (expect true before the apply)
select 'teaching_function_columns_present', count(*) = 5, false, false, false
  from information_schema.columns
 where table_schema = 'public'
   and ((table_name = 'instructors' and column_name = 'can_instruct')
     or (table_name = 'user_studio_roles' and column_name in ('user_id', 'studio_id', 'role', 'active')))
union all
-- the installed body checks instructor capability and the studio role (expect false before the apply, true after)
select 'teaching_function_checks_capability_and_role',
       exists (select 1 from pg_proc t where t.proname = 'get_teaching_clients_for_instructor' and t.pronamespace = 'public'::regnamespace
                 and position('i.can_instruct = true' in t.prosrc) > 0 and position('public.user_studio_roles' in t.prosrc) > 0),
       false, false, false
union all
select 'phase_b_clients_policy_present', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'clients' and policyname = 'studio staff manage clients'), false, false, false
order by 1;
