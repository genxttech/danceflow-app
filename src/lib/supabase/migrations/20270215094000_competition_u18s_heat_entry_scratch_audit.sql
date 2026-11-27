-- Competition U18-S -- a client cannot scratch or un-scratch a heat entry without the audited scratch workflow.
--
-- Problem (CF1 gate U18, second path): the competition_manage RLS policy plus the default grants let a studio manager write
-- event_competition_heat_entries.status = 'scratched' (and back to 'scheduled') straight through the table API. F2 drops scratched heat entries from
-- the ranking set, so such a write removes a couple from the results with NO event_competition_entry_changes audit row, no reason and no change to the
-- parent entry (reproduced locally). The audited path is change_competition_entry_lifecycle (SECURITY INVOKER): it updates the parent entry first (the
-- audit_competition_entry_change trigger then writes the entry_changes row, with the reason and fee handling taken from transaction-local settings) and
-- only then scratches the heat entries.
--
-- Fix: an AFTER INSERT OR UPDATE row trigger on the heat entries that, for any session role other than the owner roles (postgres, supabase_admin;
-- SECURITY DEFINER writers run as their owner and are exempt: _r2_withdraw_entry, the R2 refund cascade, sync_competition_entries_from_registration and the
-- A6 Final withdrawal / reinstatement keep their own audit rows), refuses
--   * a change INTO 'scratched' unless the parent entry is scratched / withdrawn AND an entry_changes row of type scratch / withdraw exists for that entry
--     (the audit trigger wrote it when the parent entry changed, in this or an earlier transaction: the lifecycle RPC can finish scratching the heat entries of an
--     entry that was scratched earlier) AND the workflow marker (app.competition_entry_change_type = scratch / withdraw, set only by the lifecycle RPC) is present;
--   * a change OUT OF 'scratched' (no client workflow un-scratches a placement; A6 reinstatement and corrections run as definers).
-- The checks read the parent entry and the audit rows as the caller (managers read both through RLS). No data changes. The guard is
-- AFTER and the privilege on triggers is revoked for clients by the U18 migration (20270215093000); this migration does not depend on it.
-- Rollback: rollback/20270215094000_competition_u18s_heat_entry_scratch_audit_rollback.sql.

create function public.cf1_u18s_guard_heat_entry_scratch()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'scratched' and new.status is distinct from old.status then
      raise exception 'COMP_U18S_UNSCRATCH_WRITER: a scratched heat entry cannot be restored by a direct table write.' using errcode = '42501';
    end if;
    if old.status = new.status then
      return new;
    end if;
  end if;
  if new.status = 'scratched' then
    -- Evaluated as the caller (a manager reads both tables through RLS); the audit table is append-only and written only by the definer audit trigger.
    if coalesce(nullif(current_setting('app.competition_entry_change_type', true), '') in ('scratch', 'withdraw'), false)
       and exists (select 1 from public.event_competition_entries e where e.id = new.entry_id and e.status in ('scratched', 'withdrawn'))
       and exists (select 1 from public.event_competition_entry_changes c
                   where c.entry_id = new.entry_id and c.change_type in ('scratch', 'withdraw')) then
      return new;
    end if;
    raise exception 'COMP_U18S_SCRATCH_UNAUDITED: a heat entry is scratched only through the audited scratch workflow (change_competition_entry_lifecycle).' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.cf1_u18s_guard_heat_entry_scratch() from public, anon, authenticated, service_role;

create trigger cf1_u18s_guard_heat_entry_scratch
  after insert or update on public.event_competition_heat_entries
  for each row execute function public.cf1_u18s_guard_heat_entry_scratch();
alter table public.event_competition_heat_entries enable always trigger cf1_u18s_guard_heat_entry_scratch;
