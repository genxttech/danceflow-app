-- Rollback of 20270301140000: restore the June SECURITY INVOKER definition (text identical to 20260620_competition_generation_operations_v1.sql) and the previous ACL in its recorded order
-- (PUBLIC, postgres, anon, authenticated, service_role). Run AFTER rolling back 20270301141000. "Exact" is relative to the repository text: the hosted body carries CR characters from the
-- original apply, which the repository text does not.
begin;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if exists (select 1 from pg_trigger where tgrelid = 'public.event_competition_entries'::regclass and tgname = 'cf1_s6_guard_entry_status') then
    raise exception 'S6 rollback refused: roll back 20270301141000 first.'; end if;
  if v_oid is null or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) is distinct from '25fdb16ba0e23069254c249c3a738aac' then
    raise exception 'S6 rollback refused: change_competition_entry_lifecycle is not the 20270301140000 definition (another change would be overwritten).'; end if;
end $$;

create or replace function public.change_competition_entry_lifecycle(
  selected_entry_id uuid,
  selected_status text,
  selected_reason text,
  selected_fee_handling text default 'retain'
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare entry_event_id uuid;
begin
  if selected_status not in ('scratched', 'withdrawn') then
    raise exception 'Lifecycle action must be scratch or withdraw.';
  end if;
  if selected_fee_handling not in ('retain', 'refund', 'partial_refund', 'waive', 'not_applicable') then
    raise exception 'Invalid fee handling.';
  end if;

  select event_id into entry_event_id from public.event_competition_entries where id = selected_entry_id;
  if entry_event_id is null or not public.can_manage_event_competition(entry_event_id) then
    raise exception 'Entry was not found or cannot be managed.';
  end if;
  if exists (
    select 1
    from public.event_competition_heat_entries he
    join public.event_competition_heats h on h.id = he.heat_id
    where he.entry_id = selected_entry_id and h.lock_state in ('locked', 'certified')
  ) then
    raise exception 'This entry is in a locked or certified heat and requires the correction workflow.';
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

revoke all on function public.change_competition_entry_lifecycle(uuid, text, text, text) from public, postgres, anon, authenticated, service_role;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to public;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to postgres;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to anon;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to authenticated;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to service_role;
commit;
