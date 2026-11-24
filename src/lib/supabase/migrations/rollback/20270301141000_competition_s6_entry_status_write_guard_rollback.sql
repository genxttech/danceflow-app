-- Rollback of 20270301141000: remove the entry status guard and restore the client TRIGGER privilege on event_competition_entries (the privilege state before: anon, authenticated and
-- service_role held TRIGGER). No data to repair. Roll back in this order: 20270301141000 first, then 20270301140000.
begin;
drop trigger if exists cf1_s6_guard_entry_status on public.event_competition_entries;
drop function if exists public.cf1_s6_guard_entry_status();
grant trigger on public.event_competition_entries to anon, authenticated, service_role;
commit;
