-- 20270223130000_integration_audit_events.sql
-- Integrations Slice 0 / S0-g2. Provider-neutral, append-only audit trail for connect / disconnect / scope failures / revoke outcomes
-- (Google Calendar had no audit table; Wave keeps its richer studio_wave_audit_events for posting). Rows are written by the server with the
-- service role only. Studio owners/admins read their own studio's rows; nobody can update or delete a row. details must never hold tokens or
-- client data (the writer in src/lib/integrations/audit.ts drops such keys).
begin;

create table if not exists public.integration_audit_events (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  provider text not null,
  connection_id uuid,
  event_type text not null,
  outcome text not null default 'succeeded',
  actor_user_id uuid references auth.users(id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint integration_audit_events_provider_check check (provider ~ '^[a-z][a-z0-9_]{1,40}$'),
  constraint integration_audit_events_event_type_check check (event_type ~ '^[a-z][a-z0-9_]{1,60}$'),
  constraint integration_audit_events_outcome_check check (outcome in ('succeeded', 'failed', 'skipped')),
  constraint integration_audit_events_details_object check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096)
);

create index if not exists integration_audit_events_studio_created_idx
  on public.integration_audit_events (studio_id, created_at desc);
create index if not exists integration_audit_events_connection_idx
  on public.integration_audit_events (connection_id) where connection_id is not null;

alter table public.integration_audit_events enable row level security;

revoke all on public.integration_audit_events from public, anon, authenticated;
grant select on public.integration_audit_events to authenticated;
grant select, insert on public.integration_audit_events to service_role;

drop policy if exists "Studio owners and admins can read integration audit events" on public.integration_audit_events;
create policy "Studio owners and admins can read integration audit events"
on public.integration_audit_events
for select
to authenticated
using (
  exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = integration_audit_events.studio_id
      and usr.active = true
      and usr.role in ('studio_owner', 'studio_admin')
  )
);

-- update-only on purpose: a delete trigger would also block the ON DELETE CASCADE from studios. Authenticated roles hold no delete privilege.
create or replace function public.protect_integration_audit_event()
returns trigger language plpgsql
set search_path = public
as $$
begin
  -- The one permitted change: deleting a user clears actor_user_id (ON DELETE SET NULL runs as an update). Anything else is refused.
  if old.actor_user_id is not null and new.actor_user_id is null
     and (to_jsonb(new) - 'actor_user_id') = (to_jsonb(old) - 'actor_user_id') then
    return new;
  end if;
  raise exception 'Integration audit events are immutable';
end;
$$;

drop trigger if exists protect_integration_audit_events on public.integration_audit_events;
create trigger protect_integration_audit_events
before update on public.integration_audit_events
for each row execute function public.protect_integration_audit_event();

commit;
