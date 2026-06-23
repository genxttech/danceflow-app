begin;

create or replace function public.set_wave_posting_entitlement(
  target_studio_id uuid,
  target_status text,
  target_notes text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_connection public.studio_wave_connections%rowtype;
begin
  if not exists (
    select 1
    from public.platform_admins administrator
    where administrator.user_id = auth.uid()
      and administrator.active = true
  ) then
    raise exception 'Platform administrator access is required';
  end if;

  if target_status not in ('pilot', 'active', 'suspended') then
    raise exception 'Invalid Wave rollout status';
  end if;

  select *
  into target_connection
  from public.studio_wave_connections
  where studio_id = target_studio_id
  for update;

  if target_connection.id is null then
    raise exception 'The studio does not have a Wave connection';
  end if;

  insert into public.studio_wave_posting_entitlements (
    studio_id,
    status,
    notes,
    granted_by,
    granted_at,
    updated_at
  ) values (
    target_studio_id,
    target_status,
    nullif(btrim(coalesce(target_notes, '')), ''),
    auth.uid(),
    now(),
    now()
  )
  on conflict (studio_id) do update
  set status = excluded.status,
      notes = excluded.notes,
      granted_by = auth.uid(),
      updated_at = now();

  if target_status = 'suspended' and target_connection.posting_enabled then
    perform set_config('app.wave_posting_toggle', 'allowed', true);
    update public.studio_wave_connections
    set posting_enabled = false,
        posting_disabled_at = now(),
        updated_at = now()
    where id = target_connection.id;
  end if;

  insert into public.studio_wave_audit_events (
    studio_id,
    connection_id,
    event_type,
    outcome,
    actor_user_id,
    details
  ) values (
    target_studio_id,
    target_connection.id,
    'posting_entitlement_changed',
    'succeeded',
    auth.uid(),
    jsonb_build_object(
      'rollout_status', target_status,
      'notes', nullif(btrim(coalesce(target_notes, '')), '')
    )
  );
end;
$$;

revoke all on function public.set_wave_posting_entitlement(uuid, text, text) from public;
grant execute on function public.set_wave_posting_entitlement(uuid, text, text) to authenticated;

commit;
