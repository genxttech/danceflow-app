-- Competition S6 (3 of 3, OPTIONAL, separable) -- harden change_competition_entry_lifecycle (slot 20270301142000). NOT APPLIED. Requires 20270301140000.
--
-- Requested by the SC1 port session (its UI calls this RPC as the signed-in manager) and by the S6 requirement to preserve eligibility / refund (R2) / roster / heat-entry invariants.
-- Signature, grants (authenticated only), security attribute (DEFINER), search_path and the audit mechanics are unchanged. Four behaviour changes, each of which can be reviewed on its own:
--   1. Placed entries are refused: an entry with a danced or disqualified heat entry, or in a heat that is active or complete, is refused (the R2 participation class locked/certified),
--      in addition to the existing refusal for locked or certified heats. (Before: only lock_state was checked.)
--   2. Idempotent: scratching an entry that is already scratched (or withdrawing one already withdrawn) returns without writing a second audit row or bumping lifecycle_version.
--   3. Serialized: the entry row is locked FOR UPDATE after the authorization check and the decision uses the status read under that lock, so two concurrent submits cannot both pass.
--   4. Source states: only pending, confirmed and waitlisted entries can be scratched or withdrawn through this RPC; scratched <-> withdrawn and disqualified/complete are refused with
--      COMP_ENTRY_LIFECYCLE_STATE. (Before: any current status was accepted, e.g. disqualified -> scratched.) A scratched entry cannot be un-scratched here (as before; no un-scratch exists).
-- Behaviour change 4 is a policy choice for the owner: drop this file to keep the June semantics.
-- Rollback: rollback/20270301142000_competition_s6_entry_lifecycle_hardening_rollback.sql restores the 20270301140000 definition exactly.

begin;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if v_oid is null or not (select prosecdef from pg_proc where oid = v_oid)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '3b4622d846fa2e6b223b3005d2425650' then
    raise exception 'S6 hardening preflight failed: 20270301140000 (definer conversion, June body) is not the current definition.';
  end if;
  if to_regprocedure('public._r2_entry_participation_class(uuid)') is null then
    raise exception 'S6 hardening preflight failed: _r2_entry_participation_class is missing.';
  end if;
end $$;

create or replace function public.change_competition_entry_lifecycle(
  selected_entry_id uuid,
  selected_status text,
  selected_reason text,
  selected_fee_handling text default 'retain'
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare entry_event_id uuid; v_current text;
begin
  if selected_status not in ('scratched', 'withdrawn') then
    raise exception 'Lifecycle action must be scratch or withdraw.';
  end if;
  if selected_fee_handling not in ('retain', 'refund', 'partial_refund', 'waive', 'not_applicable') then
    raise exception 'Invalid fee handling.';
  end if;

  -- authorization first and without a lock: a caller who does not manage the event learns nothing and blocks nobody
  select event_id into entry_event_id from public.event_competition_entries where id = selected_entry_id;
  if entry_event_id is null or not public.can_manage_event_competition(entry_event_id) then
    raise exception 'Entry was not found or cannot be managed.';
  end if;

  -- serialize concurrent submits on the entry row (same lock order as before: entry row first, heat entries after) and decide on the state read under the lock
  select status into v_current from public.event_competition_entries where id = selected_entry_id for update;
  if v_current = selected_status then
    return; -- already in the requested state: no second audit row, no lifecycle_version bump
  end if;
  if v_current not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'COMP_ENTRY_LIFECYCLE_STATE: an entry that is % cannot be %.', v_current, selected_status;
  end if;

  if exists (
    select 1
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id
    where he.entry_id = selected_entry_id and h.lock_state in ('locked', 'certified')
  ) then
    raise exception 'This entry is in a locked or certified heat and requires the correction workflow.';
  end if;
  -- the refund (R2) participation rule: a danced or disqualified placement, or a heat that is active or complete, is not a plain scratch
  if public._r2_entry_participation_class(selected_entry_id) in ('locked', 'certified') then
    raise exception 'COMP_ENTRY_LIFECYCLE_PLACED: this entry has danced, been placed or is in an active or completed heat; use the correction or refund workflow.';
  end if;

  perform set_config('app.competition_entry_change_type', case when selected_status = 'scratched' then 'scratch' else 'withdraw' end, true);
  perform set_config('app.competition_entry_change_reason', coalesce(selected_reason, ''), true);
  perform set_config('app.competition_entry_fee_handling', selected_fee_handling, true);
  update public.event_competition_entries
  set
    status = selected_status,
    scratched_at = case when selected_status = 'scratched' then now() else scratched_at end,
    scratch_reason = case when selected_status = 'scratched' then selected_reason else scratch_reason end,
    withdrawn_at = case when selected_status = 'withdrawn' then now() else withdrawn_at end,
    withdrawal_reason = case when selected_status = 'withdrawn' then selected_reason else withdrawal_reason end,
    lifecycle_version = lifecycle_version + 1,
    updated_at = now()
  where id = selected_entry_id;

  update public.event_competition_heat_entries
  set status = 'scratched', updated_at = now()
  where entry_id = selected_entry_id and status in ('scheduled', 'checked_in');
end;
$$;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if not (select prosecdef from pg_proc where oid = v_oid)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from 'e50181fa049cea40dc031495409130bd'
     or has_function_privilege('anon', v_oid, 'execute') or has_function_privilege('service_role', v_oid, 'execute')
     or not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'S6 hardening postflight failed.';
  end if;
end $$;

commit;
