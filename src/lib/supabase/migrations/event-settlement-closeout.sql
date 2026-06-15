-- Run in dev first. Run in production too before deploying the closeout UI/action.

create table if not exists public.event_settlements (
  id uuid primary key default gen_random_uuid(),

  studio_id uuid,
  organizer_id uuid,
  event_id uuid not null references public.events(id) on delete cascade,

  status text not null default 'open',
  notes text,

  gross_ticket_revenue numeric not null default 0,
  refunds numeric not null default 0,
  processing_and_platform_fees numeric not null default 0,
  net_ticket_revenue numeric not null default 0,
  event_expenses numeric not null default 0,
  event_labor_costs numeric not null default 0,
  total_event_costs numeric not null default 0,
  event_profit_loss numeric not null default 0,
  margin numeric,

  paid_registrations integer not null default 0,
  tickets_issued integer not null default 0,
  tickets_checked_in integer not null default 0,
  unpaid_registrations integer not null default 0,
  pending_registrations integer not null default 0,
  refunded_registrations integer not null default 0,

  settled_at timestamp with time zone,
  settled_by uuid,
  created_by uuid,
  updated_by uuid,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),

  constraint event_settlements_event_unique unique (event_id),
  constraint event_settlements_workspace_check check (studio_id is not null or organizer_id is not null),
  constraint event_settlements_status_check check (status in ('open', 'ready_to_settle', 'settled', 'reopened')),
  constraint event_settlements_nonnegative_counts_check check (
    paid_registrations >= 0
    and tickets_issued >= 0
    and tickets_checked_in >= 0
    and unpaid_registrations >= 0
    and pending_registrations >= 0
    and refunded_registrations >= 0
  )
);

create index if not exists idx_event_settlements_event_id
on public.event_settlements (event_id);

create index if not exists idx_event_settlements_studio_id
on public.event_settlements (studio_id);

create index if not exists idx_event_settlements_organizer_id
on public.event_settlements (organizer_id);

create index if not exists idx_event_settlements_status
on public.event_settlements (status);

create or replace function public.touch_event_settlements_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_event_settlements_updated_at
on public.event_settlements;

create trigger trg_touch_event_settlements_updated_at
before update on public.event_settlements
for each row
execute function public.touch_event_settlements_updated_at();

create or replace function public.set_event_settlements_workspace()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_studio_id uuid;
  v_organizer_id uuid;
begin
  select
    e.studio_id,
    e.organizer_id
  into
    v_studio_id,
    v_organizer_id
  from public.events e
  where e.id = new.event_id
  limit 1;

  if v_studio_id is null and v_organizer_id is null then
    raise exception 'Event settlement must be linked to an event with a studio or organizer workspace.';
  end if;

  new.studio_id := v_studio_id;
  new.organizer_id := v_organizer_id;

  return new;
end;
$$;

drop trigger if exists trg_set_event_settlements_workspace
on public.event_settlements;

create trigger trg_set_event_settlements_workspace
before insert or update of event_id
on public.event_settlements
for each row
execute function public.set_event_settlements_workspace();

alter table public.event_settlements enable row level security;

drop policy if exists event_settlements_select on public.event_settlements;
drop policy if exists event_settlements_insert on public.event_settlements;
drop policy if exists event_settlements_update on public.event_settlements;
drop policy if exists event_settlements_delete on public.event_settlements;

create policy event_settlements_select
on public.event_settlements
for select
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_settlements.event_id
      and (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.user_id = auth.uid()
            and usr.studio_id = e.studio_id
            and usr.active = true
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.user_id = auth.uid()
            and ou.organizer_id = e.organizer_id
            and ou.active = true
        )
        or exists (
          select 1
          from public.platform_admins pa
          where pa.user_id = auth.uid()
            and pa.active = true
        )
      )
  )
);

create policy event_settlements_insert
on public.event_settlements
for insert
to authenticated
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_settlements.event_id
      and (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.user_id = auth.uid()
            and usr.studio_id = e.studio_id
            and usr.active = true
            and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.user_id = auth.uid()
            and ou.organizer_id = e.organizer_id
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        )
        or exists (
          select 1
          from public.platform_admins pa
          where pa.user_id = auth.uid()
            and pa.active = true
        )
      )
  )
);

create policy event_settlements_update
on public.event_settlements
for update
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_settlements.event_id
      and (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.user_id = auth.uid()
            and usr.studio_id = e.studio_id
            and usr.active = true
            and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.user_id = auth.uid()
            and ou.organizer_id = e.organizer_id
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        )
        or exists (
          select 1
          from public.platform_admins pa
          where pa.user_id = auth.uid()
            and pa.active = true
        )
      )
  )
)
with check (
  exists (
    select 1
    from public.events e
    where e.id = event_settlements.event_id
      and (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.user_id = auth.uid()
            and usr.studio_id = e.studio_id
            and usr.active = true
            and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.user_id = auth.uid()
            and ou.organizer_id = e.organizer_id
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        )
        or exists (
          select 1
          from public.platform_admins pa
          where pa.user_id = auth.uid()
            and pa.active = true
        )
      )
  )
);

create policy event_settlements_delete
on public.event_settlements
for delete
to authenticated
using (
  exists (
    select 1
    from public.events e
    where e.id = event_settlements.event_id
      and (
        exists (
          select 1
          from public.user_studio_roles usr
          where usr.user_id = auth.uid()
            and usr.studio_id = e.studio_id
            and usr.active = true
            and usr.role = any (array['studio_owner'::app_role, 'studio_admin'::app_role])
        )
        or exists (
          select 1
          from public.organizer_users ou
          where ou.user_id = auth.uid()
            and ou.organizer_id = e.organizer_id
            and ou.active = true
            and ou.role = any (array['organizer_owner'::text, 'organizer_admin'::text, 'organizer_staff'::text])
        )
        or exists (
          select 1
          from public.platform_admins pa
          where pa.user_id = auth.uid()
            and pa.active = true
        )
      )
  )
);

select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname = 'event_settlements';

select
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename = 'event_settlements'
order by policyname;
