-- CF1 U18 / U18-S release package -- PREFLIGHT (catalog-only, read-only; run via sb.sh dev-read / prod-read).
-- Expect: ok = true. Any false value means STOP and re-review before applying 20270215093000 / 20270215094000.
select jsonb_build_object(
  'ok', (
    (select pg_get_userbyid(relowner) from pg_class where oid = 'public.event_competition_heat_entries'::regclass) = 'postgres'
    and not exists (select 1 from pg_proc where proname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
    and not exists (select 1 from pg_trigger where tgname in ('cf1_u18_guard_heat_entry_status', 'cf1_u18s_guard_heat_entry_scratch'))
    -- reviewed baseline definitions the guards were verified against
    and (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = 'change_competition_entry_lifecycle' and pronamespace = 'public'::regnamespace) = '3b4622d846fa2e6b223b3005d2425650'
    and (select md5(replace(prosrc, E'\r', '')) from pg_proc where proname = 'audit_competition_entry_change' and pronamespace = 'public'::regnamespace) = '31caa2246c0e9ae52e09efe44eb00b68'
    -- every SECURITY DEFINER function that touches heat entries is owned by an exempt role
    and not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
                    and pg_get_userbyid(proowner) not in ('postgres', 'supabase_admin') and prosrc ilike '%event_competition_heat_entries%')
    -- the existing heat-entry guards the new triggers sit beside
    and (select count(*) from pg_trigger where tgrelid = 'public.event_competition_heat_entries'::regclass
         and tgname in ('cf1_guard_final_heat_entry', 'cf1_guard_withdrawn_heat_entry', 'cf1_od17_guard_heat_entry', 'comp10d_guard_heat_entry', 'protect_locked_competition_heat_entry')) = 5
  ),
  'heat_entries_total', (select count(*) from public.event_competition_heat_entries),
  'heat_entries_danced_disqualified_scratched', (select count(*) from public.event_competition_heat_entries where status in ('danced', 'disqualified', 'scratched')),
  'client_trigger_privilege', (select jsonb_object_agg(r, has_table_privilege(r, 'public.event_competition_heat_entries', 'TRIGGER')) from unnest(array['anon', 'authenticated', 'service_role']) r),
  'sessions_with_locks_on_table', (select count(*) from pg_locks l where l.relation = 'public.event_competition_heat_entries'::regclass and l.pid <> pg_backend_pid())
);
