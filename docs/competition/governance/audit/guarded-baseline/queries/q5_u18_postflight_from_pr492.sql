-- CF1 U18 / U18-S release package -- POSTFLIGHT (catalog-only, read-only). Expect: ok = true after BOTH migrations are applied.
select jsonb_build_object(
  'ok', (
    (select tgenabled from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname = 'cf1_u18_guard_heat_entry_status') = 'A'
    and (select tgenabled from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname = 'cf1_u18s_guard_heat_entry_scratch') = 'A'
    -- AFTER row triggers
    and (select bool_and((tgtype & 2) = 0 and (tgtype & 1) = 1) from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass and tgname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
    -- SECURITY INVOKER, owned by the migration role, not executable by clients
    and (select bool_and(not prosecdef and pg_get_userbyid(proowner) in ('postgres', 'supabase_admin')) from pg_proc where proname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
    and not has_function_privilege('authenticated', 'public.cf1_u18_guard_heat_entry_status()', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.cf1_u18s_guard_heat_entry_scratch()', 'EXECUTE')
    -- TRIGGER privilege revoked from client roles
    and not has_table_privilege('anon', 'public.event_competition_heat_entries', 'TRIGGER')
    and not has_table_privilege('authenticated', 'public.event_competition_heat_entries', 'TRIGGER')
    and not has_table_privilege('service_role', 'public.event_competition_heat_entries', 'TRIGGER')
    -- the RPC and audit trigger are unchanged by this package
    and (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = 'change_competition_entry_lifecycle' and pronamespace = 'public'::regnamespace) = '3b4622d846fa2e6b223b3005d2425650'
    and (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = 'audit_competition_entry_change' and pronamespace = 'public'::regnamespace) = '31caa2246c0e9ae52e09efe44eb00b68'
    -- the pre-existing guards are still in place
    and (select count(*) from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass
         and tgname in ('cf1_guard_final_heat_entry', 'cf1_guard_withdrawn_heat_entry', 'cf1_od17_guard_heat_entry', 'comp10d_guard_heat_entry', 'protect_locked_competition_heat_entry')) = 5
  ),
  'function_md5', (select jsonb_object_agg(proname, md5(replace(prosrc, E'\r', ''))) from pg_proc where proname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
);
