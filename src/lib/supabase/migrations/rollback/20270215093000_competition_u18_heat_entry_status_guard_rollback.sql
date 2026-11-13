-- Rollback of U18: remove the heat-entry status guard (no data was changed by the migration).
drop trigger if exists cf1_u18_guard_heat_entry_status on public.event_competition_heat_entries;
drop function if exists public.cf1_u18_guard_heat_entry_status();
