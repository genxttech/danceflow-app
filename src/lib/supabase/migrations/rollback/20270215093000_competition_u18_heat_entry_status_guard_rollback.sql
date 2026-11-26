-- Rollback of U18: remove the heat-entry status guard and restore the default TRIGGER privilege for the client roles (no data was changed).
grant trigger on public.event_competition_heat_entries to anon, authenticated, service_role;
drop trigger if exists cf1_u18_guard_heat_entry_status on public.event_competition_heat_entries;
drop function if exists public.cf1_u18_guard_heat_entry_status();
