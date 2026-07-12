-- DanceFlow Document Operations V1
-- Run in development and production before deploying the accompanying code.

alter table public.document_assignments
  add column if not exists reminder_sent_at timestamptz,
  add column if not exists overdue_reminder_sent_at timestamptz;

create index if not exists idx_document_assignments_pending_due_operations
  on public.document_assignments (due_at)
  where status = 'pending' and due_at is not null;

create table if not exists public.document_operation_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  assignment_id uuid references public.document_assignments(id) on delete cascade,
  event_type text not null check (event_type in (
    'assignment_delivery_queued',
    'reminder_queued',
    'due_soon_reminder_queued',
    'overdue_reminder_queued',
    'delivery_exception',
    'waived',
    'voided'
  )),
  summary text,
  actor_user_id uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_document_operation_events_studio_created
  on public.document_operation_events (studio_id, created_at desc);
create index if not exists idx_document_operation_events_assignment
  on public.document_operation_events (assignment_id, created_at desc);

alter table public.document_operation_events enable row level security;

drop policy if exists "Studio users can view document operation events" on public.document_operation_events;
create policy "Studio users can view document operation events"
  on public.document_operation_events for select to authenticated
  using (exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_operation_events.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
  ));

drop policy if exists "Studio managers can create document operation events" on public.document_operation_events;
create policy "Studio managers can create document operation events"
  on public.document_operation_events for insert to authenticated
  with check (exists (
    select 1 from public.user_studio_roles usr
    where usr.studio_id = document_operation_events.studio_id
      and usr.user_id = auth.uid()
      and coalesce(usr.active, true) = true
      and usr.role::text in ('studio_owner','studio_admin','front_desk','platform_admin')
  ));
