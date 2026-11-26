-- Competition S6 (1 of 2) -- change_competition_entry_lifecycle: SECURITY DEFINER with mandatory integrity rules (slot 20270301140000). NOT APPLIED; apply only with owner approval of this file hash.
--
-- Why DEFINER: the next migration (20270301141000) refuses every direct client write of event_competition_entries.status. This RPC is the one existing manager-facing way to scratch or withdraw
-- an entry (it also scratches the entry's heat entries in one transaction). As SECURITY INVOKER it would be refused by that guard; as DEFINER it runs as the function owner (postgres), which the
-- guard's owner allowlist admits, without any client-settable marker. Authorization is the explicit can_manage_event_competition() check (auth.uid() comes from the request claims).
-- Signature unchanged. EXECUTE is limited to authenticated (anon and service_role have no auth.uid() and were always refused by the body).
--
-- Rules the June body lacked, mandatory because a definer function must not widen what a manager could do (each is a behaviour change from June):
--   1. Source states: only pending, confirmed, waitlisted entries can be scratched or withdrawn (COMP_ENTRY_LIFECYCLE_STATE). June accepted any state, so a manager could clear a
--      disqualification or turn complete into scratched.
--   2. Placed entries refused (COMP_ENTRY_LIFECYCLE_PLACED): the R2 participation class locked/certified (danced or disqualified heat entry, or heat active/complete), in addition to the
--      existing refusal for locked or certified heats.
--   3. Repeating the call for the state the entry is already in writes no second audit row and no version bump; after the same checks it completes the heat-entry cascade.
--   4. Concurrency: the entry's heats are locked FOR SHARE (id order) and then the entry FOR NO KEY UPDATE, and the decision uses the values read under those locks.
-- Rollback: rollback/20270301140000_competition_s6_entry_lifecycle_definer_rollback.sql (run after 20270301141000's rollback).

begin;
set local lock_timeout = '5s';

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if v_oid is null then raise exception 'S6 preflight failed: change_competition_entry_lifecycle is missing.'; end if;
  if (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '3b4622d846fa2e6b223b3005d2425650' then
    raise exception 'S6 preflight failed: change_competition_entry_lifecycle is not the reviewed June definition.'; end if;
  if (select prosecdef from pg_proc where oid = v_oid) then raise exception 'S6 preflight failed: change_competition_entry_lifecycle is already SECURITY DEFINER.'; end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid = v_oid) not in ('postgres', 'supabase_admin') then raise exception 'S6 preflight failed: unexpected function owner.'; end if;
  -- never re-grant a function another slice retired: managers must currently hold EXECUTE and the SC1-branch replacement must not be installed
  if not has_function_privilege('authenticated', v_oid, 'execute') then raise exception 'S6 preflight failed: authenticated no longer holds EXECUTE (retired by another slice); do not re-grant.'; end if;
  -- the rollback restores exactly this ACL, so refuse any other prior state (for example a privilege another change has revoked)
  if (select array_agg(a::text order by a::text collate "C") from pg_proc p, unnest(p.proacl) a where p.oid = v_oid)
     is distinct from array['=X/postgres', 'anon=X/postgres', 'authenticated=X/postgres', 'postgres=X/postgres', 'service_role=X/postgres'] then
    raise exception 'S6 preflight failed: the lifecycle function ACL is not the recorded prior ACL; reconcile before applying.'; end if;
  if exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'scratch_competition_entry') then
    raise exception 'S6 preflight failed: scratch_competition_entry is installed; reconcile the scratch workflow ownership first.'; end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null or to_regprocedure('public._r2_entry_participation_class(uuid)') is null then
    raise exception 'S6 preflight failed: a required helper function is missing.'; end if;
  if not has_function_privilege((select proowner from pg_proc where oid = v_oid), 'public._r2_entry_participation_class(uuid)', 'execute') then
    raise exception 'S6 preflight failed: the lifecycle function owner cannot execute _r2_entry_participation_class.'; end if;
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

  -- refuse a locked, certified or placed entry BEFORE taking any row lock (a refused call must not lock an advanced couple: CF1 rows U55 / U22)
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

  -- lock order: the entry's heats (FOR SHARE, id order, so a concurrent start or lock cannot slip between the checks and the writes), then the entry row
  perform 1 from public.event_competition_heats h
  where h.id in (select he.heat_id from public.event_competition_heat_entries he where he.entry_id = selected_entry_id)
  order by h.id
  for share;
  select status into v_current from public.event_competition_entries
  where id = selected_entry_id and event_id = entry_event_id
  for no key update;
  if not found then
    raise exception 'Entry was not found or cannot be managed.';
  end if;

  -- the same refusals again, now under the locks
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

  if v_current = selected_status then
    -- already in the requested state: no second audit row, no lifecycle_version bump; the heat-entry cascade is still completed for an entry whose
    -- heat entries were left scheduled (the same checks as a first transition have passed above)
    update public.event_competition_heat_entries
    set status = 'scratched', updated_at = now()
    where entry_id = selected_entry_id and status in ('scheduled', 'checked_in');
    return;
  end if;
  if v_current not in ('pending', 'confirmed', 'waitlisted') then
    raise exception 'COMP_ENTRY_LIFECYCLE_STATE: an entry that is % cannot be %.', v_current, selected_status;
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

revoke all on function public.change_competition_entry_lifecycle(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to authenticated;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if not (select prosecdef from pg_proc where oid = v_oid)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '25fdb16ba0e23069254c249c3a738aac'
     or has_function_privilege('anon', v_oid, 'execute') or has_function_privilege('service_role', v_oid, 'execute')
     or not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'S6 postflight failed (lifecycle definer).';
  end if;
end $$;

commit;
