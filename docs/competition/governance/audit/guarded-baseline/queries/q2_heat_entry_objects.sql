select jsonb_build_object(
 'triggers', (select coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'fn',p.proname,'fn_md5',md5(p.prosrc),'secdef',p.prosecdef,'owner',pg_get_userbyid(p.proowner),'def',pg_get_triggerdef(t.oid)) order by t.tgname),'[]'::jsonb)
   from pg_trigger t join pg_proc p on p.oid=t.tgfoid where t.tgrelid='public.event_competition_heat_entries'::regclass and not t.tgisinternal),
 'table_owner', (select pg_get_userbyid(relowner) from pg_class where oid='public.event_competition_heat_entries'::regclass),
 'rls', (select jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity) from pg_class where oid='public.event_competition_heat_entries'::regclass),
 'policies', (select coalesce(jsonb_agg(jsonb_build_object('name',polname,'cmd',polcmd,'roles',(select array_agg(case when r=0 then 'public' else pg_get_userbyid(r) end) from unnest(polroles) r),'qual',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid))),'[]'::jsonb) from pg_policy where polrelid='public.event_competition_heat_entries'::regclass),
 'privs', (select jsonb_object_agg(r, jsonb_build_object('select',has_table_privilege(r,'public.event_competition_heat_entries','select'),'insert',has_table_privilege(r,'public.event_competition_heat_entries','insert'),'update',has_table_privilege(r,'public.event_competition_heat_entries','update'),'delete',has_table_privilege(r,'public.event_competition_heat_entries','delete'),'trigger',has_table_privilege(r,'public.event_competition_heat_entries','trigger'),'truncate',has_table_privilege(r,'public.event_competition_heat_entries','truncate'))) from unnest(array['anon','authenticated','service_role']) r),
 'status_check', (select coalesce(jsonb_agg(pg_get_constraintdef(oid)),'[]'::jsonb) from pg_constraint where conrelid='public.event_competition_heat_entries'::regclass and contype='c'),
 'status_counts', (select coalesce(jsonb_object_agg(status,n),'{}'::jsonb) from (select status::text, count(*) n from public.event_competition_heat_entries group by 1) s),
 'heat_entries_total', (select count(*) from public.event_competition_heat_entries)
) as r;
