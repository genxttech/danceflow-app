begin;

alter table public.studio_wave_connections
  add column if not exists posting_mode text not null default 'manual_review';

alter table public.studio_wave_connections
  drop constraint if exists studio_wave_connections_posting_mode_check;

alter table public.studio_wave_connections
  add constraint studio_wave_connections_posting_mode_check
  check (posting_mode in ('manual_review', 'approval_required', 'auto_post_safe'));

create or replace function public.set_studio_wave_posting_mode(
  target_studio_id uuid,
  target_mode text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_connection public.studio_wave_connections%rowtype;
begin
  if target_mode not in ('manual_review', 'approval_required', 'auto_post_safe') then
    raise exception 'Invalid Wave posting mode';
  end if;

  if not public.can_manage_studio_wave(target_studio_id) then
    raise exception 'Not authorized to manage this Wave connection';
  end if;

  select * into target_connection
  from public.studio_wave_connections
  where studio_id = target_studio_id
  for update;

  if target_connection.id is null then
    raise exception 'Wave connection not found';
  end if;

  if target_connection.status <> 'connected' then
    raise exception 'Wave must be connected before changing posting mode';
  end if;

  if not exists (
    select 1
    from public.studio_wave_posting_entitlements entitlement
    where entitlement.studio_id = target_studio_id
      and entitlement.status in ('pilot', 'active')
  ) then
    raise exception 'Studio is not allowlisted for Wave posting';
  end if;

  if target_mode in ('approval_required', 'auto_post_safe') and target_connection.posting_enabled is not true then
    raise exception 'Enable Wave posting before selecting this posting mode';
  end if;

  if target_mode = 'auto_post_safe' then
    if target_connection.is_classic_accounting is distinct from false then
      raise exception 'Auto-post safe mode is not available for this Wave business';
    end if;

    if target_connection.scopes is null or not ('transaction:write' = any(target_connection.scopes)) then
      raise exception 'Reconnect Wave with transaction write access before enabling auto-post safe mode';
    end if;
  end if;

  update public.studio_wave_connections
  set posting_mode = target_mode,
      updated_at = now()
  where studio_id = target_studio_id;

  insert into public.studio_wave_audit_events (
    studio_id,
    connection_id,
    event_type,
    outcome,
    actor_user_id,
    details
  )
  values (
    target_studio_id,
    target_connection.id,
    'posting_mode_changed',
    'succeeded',
    auth.uid(),
    jsonb_build_object('postingMode', target_mode)
  );
end;
$$;

revoke all on function public.set_studio_wave_posting_mode(uuid, text) from public;
grant execute on function public.set_studio_wave_posting_mode(uuid, text) to authenticated;

commit;
