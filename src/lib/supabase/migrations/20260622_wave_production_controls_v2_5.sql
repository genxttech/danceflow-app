begin;

create table if not exists public.studio_wave_posting_entitlements (
  studio_id uuid primary key references public.studios(id) on delete cascade,
  status text not null default 'pilot' check (status in ('pilot', 'active', 'suspended')),
  notes text,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.studio_wave_connections
  add column if not exists posting_enabled boolean not null default false,
  add column if not exists posting_enabled_by uuid references auth.users(id) on delete set null,
  add column if not exists posting_enabled_at timestamptz,
  add column if not exists posting_disabled_at timestamptz;

alter table public.studio_wave_sync_runs
  add column if not exists reconciliation_status text not null default 'not_started',
  add column if not exists reconciliation_note text,
  add column if not exists reconciled_by uuid references auth.users(id) on delete set null,
  add column if not exists reconciled_at timestamptz;

alter table public.studio_wave_sync_runs drop constraint if exists studio_wave_sync_runs_reconciliation_status_check;
alter table public.studio_wave_sync_runs add constraint studio_wave_sync_runs_reconciliation_status_check
  check (reconciliation_status in ('not_started', 'matched', 'variance', 'needs_review'));

create table if not exists public.studio_wave_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  connection_id uuid references public.studio_wave_connections(id),
  run_id uuid references public.studio_wave_sync_runs(id),
  line_id uuid references public.studio_wave_sync_lines(id),
  event_type text not null,
  outcome text not null check (outcome in ('started', 'succeeded', 'failed', 'uncertain', 'blocked')),
  actor_user_id uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists studio_wave_audit_events_studio_created_idx
  on public.studio_wave_audit_events(studio_id, created_at desc);
create index if not exists studio_wave_audit_events_run_idx
  on public.studio_wave_audit_events(run_id, created_at);

alter table public.studio_wave_posting_entitlements enable row level security;
alter table public.studio_wave_audit_events enable row level security;

drop policy if exists studio_wave_posting_entitlements_select on public.studio_wave_posting_entitlements;
create policy studio_wave_posting_entitlements_select on public.studio_wave_posting_entitlements
for select to authenticated using (public.can_manage_studio_wave(studio_id));

drop policy if exists studio_wave_posting_entitlements_platform_insert on public.studio_wave_posting_entitlements;
drop policy if exists studio_wave_posting_entitlements_platform_update on public.studio_wave_posting_entitlements;
drop policy if exists studio_wave_posting_entitlements_platform_delete on public.studio_wave_posting_entitlements;
create policy studio_wave_posting_entitlements_platform_insert on public.studio_wave_posting_entitlements
for insert to authenticated with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.active = true));
create policy studio_wave_posting_entitlements_platform_update on public.studio_wave_posting_entitlements
for update to authenticated using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.active = true))
with check (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.active = true));
create policy studio_wave_posting_entitlements_platform_delete on public.studio_wave_posting_entitlements
for delete to authenticated using (exists (select 1 from public.platform_admins pa where pa.user_id = auth.uid() and pa.active = true));

drop policy if exists studio_wave_audit_events_select on public.studio_wave_audit_events;
create policy studio_wave_audit_events_select on public.studio_wave_audit_events
for select to authenticated using (public.can_manage_studio_wave(studio_id));

create or replace function public.protect_wave_audit_event()
returns trigger language plpgsql as $$
begin
  raise exception 'Wave audit events are immutable';
end;
$$;

drop trigger if exists protect_wave_audit_events on public.studio_wave_audit_events;
create trigger protect_wave_audit_events before update on public.studio_wave_audit_events
for each row execute function public.protect_wave_audit_event();

create or replace function public.protect_wave_posting_toggle()
returns trigger language plpgsql as $$
begin
  if (
       new.posting_enabled is distinct from old.posting_enabled
       or new.posting_enabled_by is distinct from old.posting_enabled_by
       or new.posting_enabled_at is distinct from old.posting_enabled_at
       or new.posting_disabled_at is distinct from old.posting_disabled_at
     )
     and coalesce(current_setting('app.wave_posting_toggle', true), '') <> 'allowed'
  then raise exception 'Use the controlled Wave posting toggle'; end if;
  return new;
end;
$$;

drop trigger if exists protect_wave_posting_toggle on public.studio_wave_connections;
create trigger protect_wave_posting_toggle before update on public.studio_wave_connections
for each row execute function public.protect_wave_posting_toggle();

create or replace function public.set_studio_wave_posting_enabled(target_studio_id uuid, desired_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
declare target_connection public.studio_wave_connections%rowtype;
begin
  if not public.can_manage_studio_wave(target_studio_id) then raise exception 'Wave connection is unavailable'; end if;
  select * into target_connection from public.studio_wave_connections where studio_id = target_studio_id for update;
  if target_connection.id is null or target_connection.status <> 'connected' then raise exception 'Wave is not connected'; end if;
  if desired_enabled and not exists (
    select 1 from public.studio_wave_posting_entitlements entitlement
    where entitlement.studio_id = target_studio_id and entitlement.status in ('pilot', 'active')
  ) then raise exception 'Studio is not allowlisted for Wave posting'; end if;

  perform set_config('app.wave_posting_toggle', 'allowed', true);
  update public.studio_wave_connections set
    posting_enabled = desired_enabled,
    posting_enabled_by = case when desired_enabled then auth.uid() else posting_enabled_by end,
    posting_enabled_at = case when desired_enabled then now() else posting_enabled_at end,
    posting_disabled_at = case when desired_enabled then null else now() end,
    updated_at = now()
  where id = target_connection.id;

  insert into public.studio_wave_audit_events (
    studio_id, connection_id, event_type, outcome, actor_user_id, details
  ) values (
    target_studio_id, target_connection.id,
    case when desired_enabled then 'posting_enabled' else 'posting_disabled' end,
    'succeeded', auth.uid(), jsonb_build_object('enabled', desired_enabled)
  );
end;
$$;

create or replace function public.set_wave_run_reconciliation(
  target_run_id uuid,
  target_status text,
  target_note text default null
)
returns void language plpgsql security definer set search_path = public as $$
declare target_run public.studio_wave_sync_runs%rowtype;
begin
  select * into target_run from public.studio_wave_sync_runs where id = target_run_id for update;
  if target_run.id is null or not public.can_manage_studio_wave(target_run.studio_id) then raise exception 'Wave run is unavailable'; end if;
  if target_run.status <> 'posted' then raise exception 'Only fully posted runs can be reconciled'; end if;
  if target_status not in ('matched', 'variance', 'needs_review') then raise exception 'Invalid reconciliation status'; end if;
  if target_status <> 'matched' and nullif(btrim(coalesce(target_note, '')), '') is null then
    raise exception 'A reconciliation note is required';
  end if;

  update public.studio_wave_sync_runs set
    reconciliation_status = target_status,
    reconciliation_note = nullif(btrim(coalesce(target_note, '')), ''),
    reconciled_by = auth.uid(), reconciled_at = now(), updated_at = now()
  where id = target_run.id;

  insert into public.studio_wave_audit_events (
    studio_id, connection_id, run_id, event_type, outcome, actor_user_id, details
  ) values (
    target_run.studio_id, target_run.connection_id, target_run.id,
    'run_reconciled', 'succeeded', auth.uid(),
    jsonb_build_object('reconciliation_status', target_status, 'note', target_note)
  );
end;
$$;

revoke all on function public.set_studio_wave_posting_enabled(uuid, boolean) from public;
revoke all on function public.set_wave_run_reconciliation(uuid, text, text) from public;
grant execute on function public.set_studio_wave_posting_enabled(uuid, boolean) to authenticated;
grant execute on function public.set_wave_run_reconciliation(uuid, text, text) to authenticated;

commit;
