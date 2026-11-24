select jsonb_build_object(
 'tables', (select jsonb_object_agg(t.rel, jsonb_build_object(
   'owner', pg_get_userbyid(c.relowner),
   'rls', jsonb_build_object('enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity),
   'relacl', coalesce((select jsonb_agg(a::text order by a::text) from unnest(c.relacl) a), '[]'::jsonb),
   'privs', (select jsonb_object_agg(r, (select jsonb_agg(p order by p) from unnest(array['select','insert','update','delete','truncate','references','trigger']) p where has_table_privilege(r, c.oid, p))) from unnest(array['anon','authenticated','service_role']) r),
   'policies', (select coalesce(jsonb_agg(jsonb_build_object('n',polname,'cmd',polcmd,'roles',(select array_agg(case when x=0 then 'public' else pg_get_userbyid(x) end) from unnest(polroles) x),'qual',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) order by polname),'[]'::jsonb) from pg_policy where polrelid=c.oid),
   'status_check', (select coalesce(jsonb_agg(pg_get_constraintdef(k.oid) order by k.conname),'[]'::jsonb) from pg_constraint k where k.conrelid=c.oid and k.contype='c' and pg_get_constraintdef(k.oid) ilike '%status%'),
   'triggers', (select coalesce(jsonb_agg(jsonb_build_object('name',g.tgname,'enabled',g.tgenabled::text,'def',pg_get_triggerdef(g.oid),'fn',p.proname,'fn_md5',md5(p.prosrc),'secdef',p.prosecdef,'fn_owner',pg_get_userbyid(p.proowner),'fn_config',p.proconfig,'fn_acl',p.proacl::text) order by g.tgname),'[]'::jsonb) from pg_trigger g join pg_proc p on p.oid=g.tgfoid where g.tgrelid=c.oid and not g.tgisinternal)
 )) from (values ('event_competition_heat_entries'),('event_competition_entries')) t(rel) join pg_class c on c.oid=('public.'||t.rel)::regclass)
) as r;
