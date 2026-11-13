-- Competition U18 -- close the direct table-write bypass of the heat-entry danced / disqualified statuses.
--
-- Problem (CF1 gate U18): the competition_manage RLS policy plus the default table grants let a studio manager write
-- event_competition_heat_entries.status = 'danced' | 'disqualified' straight through the table API. HL1 treats such a placement as proof
-- that the heat was danced (_hl1_heat_is_danced), so a block-mode round could be ballot-locked without any floor event, and R2 treats the
-- same statuses as "locked" for refunds. No app code and no migration function writes these two statuses today (verified), so nothing
-- legitimate depends on a client writing them.
--
-- Fix: an AFTER INSERT OR UPDATE row trigger refuses a row that ENDS UP in danced / disqualified, and a row that LEAVES either status (the status changed) unless the
-- session role is one of the owner roles (postgres, supabase_admin): an allowlist, so any other role, including a future client-like role, is refused.
-- AFTER, not BEFORE, so it sees the final status even if another BEFORE trigger rewrites it (a client holding the default TRIGGER privilege could
-- otherwise add one; that privilege is revoked below as well). SECURITY INVOKER on purpose, so current_user is the caller; a SECURITY DEFINER writer
-- runs as its owner and is unaffected. Setting the same value again is not a change. Other statuses are untouched. 'scratched' is deliberately NOT
-- covered here (the scratch RPCs and A6 withdrawal write it, some as invoker); see the U18 note in the QA addendum.
-- Also revokes the table TRIGGER privilege from the client roles (Supabase default grants hand it out; no client use exists). No data changes. Rollback: rollback/20270215093000_competition_u18_heat_entry_status_guard_rollback.sql.

create function public.cf1_u18_guard_heat_entry_status()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if new.status in ('danced', 'disqualified') and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    raise exception 'COMP_U18_HEAT_ENTRY_STATUS_WRITER: a heat entry cannot be set to % by a direct table write.', new.status
      using errcode = '42501';
  end if;
  -- The reverse is refused too: a client could otherwise un-dance a placement and undo the HL1 / R2 "danced" evidence.
  if tg_op = 'UPDATE' and old.status in ('danced', 'disqualified') and new.status is distinct from old.status then
    raise exception 'COMP_U18_HEAT_ENTRY_STATUS_WRITER: a % heat entry cannot be changed by a direct table write.', old.status
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u18_guard_heat_entry_status() from public, anon, authenticated, service_role;

create trigger cf1_u18_guard_heat_entry_status
  after insert or update on public.event_competition_heat_entries
  for each row execute function public.cf1_u18_guard_heat_entry_status();
alter table public.event_competition_heat_entries enable always trigger cf1_u18_guard_heat_entry_status;

revoke trigger on public.event_competition_heat_entries from anon, authenticated, service_role;
