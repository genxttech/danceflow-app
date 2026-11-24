-- Competition S6 (1 of 2) -- change_competition_entry_lifecycle becomes SECURITY DEFINER (slot 20270301140000). NOT APPLIED; apply only with owner approval of this file hash.
--
-- Why: the next migration (20270301141000) refuses every direct client write of event_competition_entries.status. This RPC is the one existing
-- manager-facing way to scratch or withdraw an entry (it also scratches the entry's heat entries in one transaction). As SECURITY INVOKER it would be
-- refused by that guard, because its UPDATE would run as the calling client role. As SECURITY DEFINER it runs as the function owner (postgres), which the
-- guard's owner allowlist admits, and it does not depend on any client-settable marker: authorization is the explicit can_manage_event_competition()
-- check already in the body (auth.uid() is read from the request claims, unchanged inside a definer function).
--
-- The BODY is byte-identical to the June definition (20260620_competition_generation_operations_v1.sql, md5 3b4622d846fa2e6b223b3005d2425650 after
-- removing CR characters, the same pin as the U18 preflight); only the SECURITY attribute changes. Privileges are tightened from the default
-- (PUBLIC, anon, authenticated, service_role) to authenticated only: anon and service_role have no auth.uid() and were always refused by the body.
-- Rollback: rollback/20270301140000_competition_s6_entry_lifecycle_definer_rollback.sql restores the invoker definition and the previous ACL.

begin;

do $$
declare v_md5 text; v_sec boolean; v_owner text;
begin
  select md5(replace(p.prosrc, chr(13), '')), p.prosecdef, pg_get_userbyid(p.proowner) into v_md5, v_sec, v_owner
  from pg_proc p where p.oid = to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
  if v_md5 is distinct from '3b4622d846fa2e6b223b3005d2425650' then raise exception 'S6 preflight failed: change_competition_entry_lifecycle is not the reviewed June definition (md5 %).', v_md5; end if;
  if v_sec then raise exception 'S6 preflight failed: change_competition_entry_lifecycle is already SECURITY DEFINER.'; end if;
  if v_owner not in ('postgres', 'supabase_admin') then raise exception 'S6 preflight failed: unexpected function owner %.', v_owner; end if;
  if to_regprocedure('public.can_manage_event_competition(uuid)') is null then raise exception 'S6 preflight failed: can_manage_event_competition is missing.'; end if;
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

revoke all on function public.change_competition_entry_lifecycle(uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.change_competition_entry_lifecycle(uuid, text, text, text) to authenticated;

do $$
declare v_oid oid := to_regprocedure('public.change_competition_entry_lifecycle(uuid, text, text, text)');
begin
  if not (select prosecdef from pg_proc where oid = v_oid)
     or (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = v_oid) <> '3b4622d846fa2e6b223b3005d2425650'
     or has_function_privilege('anon', v_oid, 'execute')
     or has_function_privilege('service_role', v_oid, 'execute')
     or not has_function_privilege('authenticated', v_oid, 'execute') then
    raise exception 'S6 postflight failed (lifecycle definer).';
  end if;
end $$;

commit;
