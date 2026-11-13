-- Competition U18 -- close the direct table-write bypass of the heat-entry danced / disqualified statuses.
--
-- Problem (CF1 gate U18): the competition_manage RLS policy plus the default table grants let a studio manager write
-- event_competition_heat_entries.status = 'danced' | 'disqualified' straight through the table API. HL1 treats such a placement as proof
-- that the heat was danced (_hl1_heat_is_danced), so a block-mode round could be ballot-locked without any floor event, and R2 treats the
-- same statuses as "locked" for refunds. No app code and no migration function writes these two statuses today (verified), so nothing
-- legitimate depends on a client writing them.
--
-- Fix: a BEFORE INSERT OR UPDATE OF status trigger refuses a change INTO danced / disqualified when the session role is a client role
-- (authenticated, anon, service_role). SECURITY INVOKER on purpose, so current_user is the caller; a future SECURITY DEFINER writer runs as
-- its owner and is unaffected. Setting the same value again is not a change. Other statuses are untouched. 'scratched' is deliberately NOT
-- covered here (the scratch RPCs and A6 withdrawal write it, some as invoker); see the U18 note in the QA addendum.
-- No data changes. Rollback: rollback/20270215093000_competition_u18_heat_entry_status_guard_rollback.sql.

create function public.cf1_u18_guard_heat_entry_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.status in ('danced', 'disqualified')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and current_user in ('authenticated', 'anon', 'service_role') then
    raise exception 'COMP_U18_HEAT_ENTRY_STATUS_WRITER: a heat entry cannot be set to % by a direct table write.', new.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u18_guard_heat_entry_status() from public, anon, authenticated, service_role;

create trigger cf1_u18_guard_heat_entry_status
  before insert or update of status on public.event_competition_heat_entries
  for each row execute function public.cf1_u18_guard_heat_entry_status();
alter table public.event_competition_heat_entries enable always trigger cf1_u18_guard_heat_entry_status;
