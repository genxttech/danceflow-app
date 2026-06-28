begin;

alter table public.studio_settings
  add column if not exists portal_self_scheduling_reschedule_mode text not null default 'request_only',
  add column if not exists portal_self_scheduling_cancellation_mode text not null default 'request_only',
  add column if not exists portal_self_scheduling_slot_interval_minutes integer not null default 15,
  add column if not exists portal_self_scheduling_default_duration_minutes integer not null default 45,
  add column if not exists portal_self_scheduling_require_active_credit boolean not null default false,
  add column if not exists portal_self_scheduling_allow_unlinked_requests boolean not null default false,
  add column if not exists portal_self_scheduling_auto_assign_room boolean not null default false,
  add column if not exists portal_self_scheduling_requires_payment_method boolean not null default false,
  add column if not exists portal_self_scheduling_updated_at timestamptz;

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_mode_check;
alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_mode_check
  check (
    portal_self_scheduling_mode is null
    or portal_self_scheduling_mode in ('disabled', 'request_only', 'approval_required', 'instant')
  );

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_reschedule_mode_check;
alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_reschedule_mode_check
  check (portal_self_scheduling_reschedule_mode in ('disabled', 'request_only', 'approval_required', 'instant'));

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_cancellation_mode_check;
alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_cancellation_mode_check
  check (portal_self_scheduling_cancellation_mode in ('disabled', 'request_only', 'approval_required', 'instant'));

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_slot_interval_check;
alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_slot_interval_check
  check (portal_self_scheduling_slot_interval_minutes in (5, 10, 15, 20, 30, 45, 60));

alter table public.studio_settings
  drop constraint if exists studio_settings_portal_self_scheduling_duration_check;
alter table public.studio_settings
  add constraint studio_settings_portal_self_scheduling_duration_check
  check (portal_self_scheduling_default_duration_minutes in (30, 45, 60, 75, 90, 120));

create table if not exists public.studio_booking_availability_windows (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  lesson_type text,
  weekday integer not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null,
  effective_start_date date,
  effective_end_date date,
  approval_required boolean,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_time < end_time),
  check (effective_end_date is null or effective_start_date is null or effective_end_date >= effective_start_date)
);

create index if not exists studio_booking_availability_windows_lookup_idx
  on public.studio_booking_availability_windows(studio_id, active, weekday, instructor_id, lesson_type);

create table if not exists public.studio_booking_blackouts (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  instructor_id uuid references public.instructors(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text,
  source text not null default 'manual' check (source in ('manual', 'studio_closed', 'instructor_unavailable', 'room_unavailable', 'event', 'system')),
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (starts_at < ends_at)
);

create index if not exists studio_booking_blackouts_lookup_idx
  on public.studio_booking_blackouts(studio_id, active, starts_at, ends_at, instructor_id, room_id);

create table if not exists public.student_booking_action_requests (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid references public.clients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  booking_request_id uuid references public.booking_requests(id) on delete set null,
  action_type text not null check (action_type in ('book', 'reschedule', 'cancel')),
  source text not null default 'portal' check (source in ('portal', 'mobile_app', 'staff', 'aria')),
  mode text not null check (mode in ('request_only', 'approval_required', 'instant')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'executed', 'cancelled', 'expired', 'failed')),
  lesson_type text,
  instructor_id uuid references public.instructors(id) on delete set null,
  room_id uuid references public.rooms(id) on delete set null,
  requested_starts_at timestamptz,
  requested_ends_at timestamptz,
  previous_starts_at timestamptz,
  previous_ends_at timestamptz,
  reason text,
  student_note text,
  staff_note text,
  decision_by uuid references auth.users(id) on delete set null,
  decision_at timestamptz,
  executed_by uuid references auth.users(id) on delete set null,
  executed_at timestamptz,
  failure_reason text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    action_type = 'cancel'
    or (requested_starts_at is not null and requested_ends_at is not null and requested_starts_at < requested_ends_at)
  )
);

create index if not exists student_booking_action_requests_studio_status_idx
  on public.student_booking_action_requests(studio_id, status, created_at desc);
create index if not exists student_booking_action_requests_client_idx
  on public.student_booking_action_requests(client_id, created_at desc);
create index if not exists student_booking_action_requests_appointment_idx
  on public.student_booking_action_requests(appointment_id, created_at desc);

create table if not exists public.student_booking_action_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  action_request_id uuid references public.student_booking_action_requests(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  event_type text not null,
  outcome text not null check (outcome in ('started', 'succeeded', 'failed', 'blocked', 'skipped')),
  actor_user_id uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists student_booking_action_audit_events_request_idx
  on public.student_booking_action_audit_events(action_request_id, created_at);
create index if not exists student_booking_action_audit_events_studio_idx
  on public.student_booking_action_audit_events(studio_id, created_at desc);

alter table public.studio_booking_availability_windows enable row level security;
alter table public.studio_booking_blackouts enable row level security;
alter table public.student_booking_action_requests enable row level security;
alter table public.student_booking_action_audit_events enable row level security;

create or replace function public.can_manage_studio_self_service_booking(target_studio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = target_studio_id
      and usr.active = true
      and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role, 'front_desk'::app_role])
  ) or exists (
    select 1
    from public.platform_admins pa
    where pa.user_id = auth.uid()
      and pa.active = true
  );
$$;

create or replace function public.is_portal_client_for_studio(target_studio_id uuid, target_client_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.clients client
    where client.id = target_client_id
      and client.studio_id = target_studio_id
      and client.portal_user_id = auth.uid()
  );
$$;

revoke all on function public.can_manage_studio_self_service_booking(uuid) from public;
revoke all on function public.is_portal_client_for_studio(uuid, uuid) from public;
grant execute on function public.can_manage_studio_self_service_booking(uuid) to authenticated, service_role;
grant execute on function public.is_portal_client_for_studio(uuid, uuid) to authenticated, service_role;

drop policy if exists studio_booking_availability_windows_manage on public.studio_booking_availability_windows;
create policy studio_booking_availability_windows_manage
on public.studio_booking_availability_windows
for all to authenticated
using (public.can_manage_studio_self_service_booking(studio_id))
with check (public.can_manage_studio_self_service_booking(studio_id));

drop policy if exists studio_booking_availability_windows_portal_select on public.studio_booking_availability_windows;
create policy studio_booking_availability_windows_portal_select
on public.studio_booking_availability_windows
for select to authenticated
using (active = true);

drop policy if exists studio_booking_blackouts_manage on public.studio_booking_blackouts;
create policy studio_booking_blackouts_manage
on public.studio_booking_blackouts
for all to authenticated
using (public.can_manage_studio_self_service_booking(studio_id))
with check (public.can_manage_studio_self_service_booking(studio_id));

drop policy if exists studio_booking_blackouts_portal_select on public.studio_booking_blackouts;
create policy studio_booking_blackouts_portal_select
on public.studio_booking_blackouts
for select to authenticated
using (active = true);

drop policy if exists student_booking_action_requests_staff_manage on public.student_booking_action_requests;
create policy student_booking_action_requests_staff_manage
on public.student_booking_action_requests
for all to authenticated
using (public.can_manage_studio_self_service_booking(studio_id))
with check (public.can_manage_studio_self_service_booking(studio_id));

drop policy if exists student_booking_action_requests_client_select on public.student_booking_action_requests;
create policy student_booking_action_requests_client_select
on public.student_booking_action_requests
for select to authenticated
using (client_id is not null and public.is_portal_client_for_studio(studio_id, client_id));

drop policy if exists student_booking_action_requests_client_insert on public.student_booking_action_requests;
create policy student_booking_action_requests_client_insert
on public.student_booking_action_requests
for insert to authenticated
with check (client_id is not null and public.is_portal_client_for_studio(studio_id, client_id));

drop policy if exists student_booking_action_audit_events_staff_select on public.student_booking_action_audit_events;
create policy student_booking_action_audit_events_staff_select
on public.student_booking_action_audit_events
for select to authenticated
using (public.can_manage_studio_self_service_booking(studio_id));

drop policy if exists student_booking_action_audit_events_client_select on public.student_booking_action_audit_events;
create policy student_booking_action_audit_events_client_select
on public.student_booking_action_audit_events
for select to authenticated
using (
  exists (
    select 1
    from public.student_booking_action_requests request
    where request.id = action_request_id
      and request.client_id is not null
      and public.is_portal_client_for_studio(request.studio_id, request.client_id)
  )
);

create or replace function public.protect_student_booking_action_audit_event()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Student booking action audit events are immutable';
end;
$$;

drop trigger if exists protect_student_booking_action_audit_events on public.student_booking_action_audit_events;
create trigger protect_student_booking_action_audit_events
before update or delete on public.student_booking_action_audit_events
for each row execute function public.protect_student_booking_action_audit_event();

commit;
