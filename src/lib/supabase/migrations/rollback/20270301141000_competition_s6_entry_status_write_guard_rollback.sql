-- Rollback of 20270301141000: remove the entry guards, restore service_role EXECUTE on the two internal R2 functions, and restore the client TRIGGER privilege the state before had
-- (anon, authenticated and service_role). If the S4/R15 eligibility write guard is installed it revoked TRIGGER from anon and authenticated itself, so only service_role is re-granted then.
-- No data to repair. Roll back in this order: 20270301141000 first, then 20270301140000.
begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status') then
    raise exception 'S6 guard rollback refused: the guard is not installed.';
  end if;
end $$;

drop trigger if exists cf1_s6_guard_entry_delete on public.event_competition_entries;
drop trigger if exists cf1_s6_guard_entry_links on public.event_competition_entries;
drop trigger if exists cf1_s6_guard_entry_status on public.event_competition_entries;
drop function if exists public.cf1_s6_guard_entry_status();
grant execute on function public._r2_withdraw_entry(uuid, text, text) to service_role;
grant execute on function public._r2_apply_participation(uuid) to service_role;

do $$
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'r15_guard_entry_eligibility_write') then
    grant trigger on public.event_competition_entries to service_role;
  else
    grant trigger on public.event_competition_entries to anon, authenticated, service_role;
  end if;
end $$;
commit;
