set transaction read only;
select 'i0_trigger_fp' k, count(*)::text || ' ' || md5(string_agg(tgname||pg_get_triggerdef(oid), '|' order by tgname)) v from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal
union all select 'i0_constraint_fp', count(*)::text || ' ' || md5(string_agg(conname||pg_get_constraintdef(oid), '|' order by conname)) from pg_constraint where conrelid = 'public.appointments'::regclass
union all select 'i0_inbound_fk_fp', count(*)::text || ' ' || md5(string_agg(conname||pg_get_constraintdef(oid), '|' order by conname)) from pg_constraint where confrelid = 'public.appointments'::regclass and contype = 'f'
union all select 'i0_index_fp', count(*)::text || ' ' || md5(string_agg(indexdef, '|' order by indexname)) from pg_indexes where schemaname = 'public' and tablename = 'appointments'
union all select 'nsi_appointments_fp_canonical', coalesce(md5(
        (select string_agg(tgname || pg_get_triggerdef(oid), '|' order by tgname) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal)
     || (select string_agg(conname || pg_get_constraintdef(oid), '|' order by conname) from pg_constraint where conrelid = 'public.appointments'::regclass)
     || (select string_agg(indexdef, '|' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'appointments')
     || (select coalesce(string_agg(conrelid::regclass::text || conname, '|' order by conname), '') from pg_constraint where confrelid = 'public.appointments'::regclass)), '<NULL: component missing>')
union all select 'component_presence', format('triggers=%s constraints=%s indexes=%s inbound_fks=%s',
     (select count(*) from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal),
     (select count(*) from pg_constraint where conrelid = 'public.appointments'::regclass),
     (select count(*) from pg_indexes where schemaname = 'public' and tablename = 'appointments'),
     (select count(*) from pg_constraint where confrelid = 'public.appointments'::regclass))
union all select 'appointments_trigger_functions_fp', count(*)::text || ' ' || md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc), '|' order by p.oid::regprocedure::text, t.tgname))
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = 'public.appointments'::regclass and not t.tgisinternal
union all select 'appointments_rls', (select format('rls=%s force=%s owner=%s', relrowsecurity, relforcerowsecurity, pg_get_userbyid(relowner)) from pg_class where oid = 'public.appointments'::regclass)
union all select 'appointments_policies_fp', (select count(*)::text || ' ' || md5(string_agg(policyname || cmd || roles::text || coalesce(qual, '') || coalesce(with_check, ''), '|' order by policyname)) from pg_policies where schemaname = 'public' and tablename = 'appointments')
union all select 'appointments_acl', (select coalesce(relacl::text, '<default>') from pg_class where oid = 'public.appointments'::regclass);
