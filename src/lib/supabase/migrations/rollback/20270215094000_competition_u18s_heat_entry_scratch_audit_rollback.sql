-- Rollback of U18-S: remove the heat-entry scratch audit guard (no data was changed by the migration).
drop trigger if exists cf1_u18s_guard_heat_entry_scratch on public.event_competition_heat_entries;
drop function if exists public.cf1_u18s_guard_heat_entry_scratch();
