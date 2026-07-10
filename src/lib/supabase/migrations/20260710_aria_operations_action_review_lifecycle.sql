-- ARIA Operations Action Review Lifecycle
-- Run in dev and production.

alter table if exists public.automation_actions
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists skipped_at timestamptz,
  add column if not exists skipped_by uuid references auth.users(id) on delete set null,
  add column if not exists completed_by uuid references auth.users(id) on delete set null,
  add column if not exists dismissed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists snoozed_until timestamptz,
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists review_note text;

-- Replace any older status CHECK constraint so ARIA review states can be persisted.
do $$
declare
  constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'automation_actions'
      and c.contype = 'c'
      and pg_get_constraintdef(c.oid) ilike '%status%'
  loop
    execute format(
      'alter table public.automation_actions drop constraint if exists %I',
      constraint_record.conname
    );
  end loop;
end $$;

alter table public.automation_actions
  add constraint automation_actions_status_check
  check (
    status in (
      'suggested',
      'drafted',
      'approved',
      'queued',
      'completed',
      'dismissed',
      'skipped',
      'snoozed',
      'failed'
    )
  );

create table if not exists public.automation_action_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  automation_action_id uuid not null references public.automation_actions(id) on delete cascade,
  event_type text not null,
  previous_status text,
  new_status text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint automation_action_events_event_type_check check (
    event_type in (
      'created',
      'approved',
      'completed',
      'dismissed',
      'skipped',
      'snoozed',
      'assigned',
      'reopened',
      'failed'
    )
  )
);

create index if not exists automation_action_events_studio_action_idx
  on public.automation_action_events (studio_id, automation_action_id, created_at desc);

create index if not exists automation_actions_review_queue_idx
  on public.automation_actions (studio_id, status, priority, created_at desc);

alter table public.automation_action_events enable row level security;

-- Policies are intentionally scoped through active workspace roles.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_action_events'
      and policyname = 'automation_action_events_select_by_workspace'
  ) then
    create policy automation_action_events_select_by_workspace
      on public.automation_action_events
      for select
      using (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = automation_action_events.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_action_events'
      and policyname = 'automation_action_events_insert_by_workspace'
  ) then
    create policy automation_action_events_insert_by_workspace
      on public.automation_action_events
      for insert
      with check (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.studio_id = automation_action_events.studio_id
            and usr.user_id = auth.uid()
            and usr.active = true
        )
      );
  end if;
end $$;
