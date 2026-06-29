begin;

create or replace function public.claim_next_wave_sync_line_for_autopost(target_run_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  target_run public.studio_wave_sync_runs%rowtype;
  target_connection public.studio_wave_connections%rowtype;
  target_line_id uuid;
begin
  select * into target_run
  from public.studio_wave_sync_runs
  where id = target_run_id
  for update;

  if target_run.id is null then
    raise exception 'Wave sync run is unavailable';
  end if;

  select * into target_connection
  from public.studio_wave_connections
  where id = target_run.connection_id
    and studio_id = target_run.studio_id
  for update;

  if target_connection.id is null then
    raise exception 'Wave connection is unavailable';
  end if;

  if target_connection.status <> 'connected'
    or target_connection.posting_enabled is not true
    or target_connection.posting_mode <> 'auto_post_safe'
    or target_connection.is_classic_accounting is distinct from false
    or target_connection.wave_business_id is null
    or target_connection.scopes is null
    or not ('transaction:write' = any(target_connection.scopes)) then
    raise exception 'Wave auto-post is not enabled for this connection';
  end if;

  if not exists (
    select 1
    from public.studio_wave_posting_entitlements entitlement
    where entitlement.studio_id = target_run.studio_id
      and entitlement.status in ('pilot', 'active')
  ) then
    raise exception 'Studio is not allowlisted for Wave posting';
  end if;

  if target_run.status not in ('approved', 'posting') then
    return null;
  end if;

  if (target_run.configuration_snapshot->>'waveBusinessId') is distinct from target_connection.wave_business_id then
    update public.studio_wave_sync_runs
    set status = 'attention_required',
        posting_error = 'Wave business changed after this run was created.',
        updated_at = now()
    where id = target_run.id;
    return null;
  end if;

  if exists (
    select 1
    from public.studio_wave_sync_lines
    where run_id = target_run.id
      and posting_status in ('posting', 'uncertain', 'failed')
  ) then
    return null;
  end if;

  select id into target_line_id
  from public.studio_wave_sync_lines
  where run_id = target_run.id
    and posting_status = 'pending'
  order by entry_date, id
  limit 1
  for update skip locked;

  if target_line_id is null then
    if not exists (
      select 1
      from public.studio_wave_sync_lines
      where run_id = target_run.id
        and posting_status <> 'posted'
    ) then
      update public.studio_wave_sync_runs
      set status = 'posted',
          posting_completed_at = coalesce(posting_completed_at, now()),
          posting_error = null,
          updated_at = now()
      where id = target_run.id;
    end if;
    return null;
  end if;

  update public.studio_wave_sync_lines
  set posting_status = 'posting',
      posting_attempts = posting_attempts + 1,
      posting_started_at = now(),
      posting_error = null
  where id = target_line_id;

  update public.studio_wave_sync_runs
  set status = 'posting',
      posting_started_at = coalesce(posting_started_at, now()),
      posting_error = null,
      updated_at = now()
  where id = target_run.id;

  return target_line_id;
end;
$$;

revoke all on function public.claim_next_wave_sync_line_for_autopost(uuid) from public;
grant execute on function public.claim_next_wave_sync_line_for_autopost(uuid) to service_role;

commit;
