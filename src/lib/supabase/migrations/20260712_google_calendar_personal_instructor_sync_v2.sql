-- 20260712_google_calendar_personal_instructor_sync_v2.sql
-- Adds durable user-to-instructor identity and supports both shared studio
-- Google Calendar connections and personal instructor Google Calendar connections.
--
-- IMPORTANT:
-- 1. Run in development before deploying the related code changes.
-- 2. Run in production before deploying the related code changes.
-- 3. Existing studio Google Calendar connections remain studio-scoped.

begin;

-- ---------------------------------------------------------------------------
-- Instructor account identity
-- ---------------------------------------------------------------------------

alter table public.instructors
  add column if not exists user_id uuid references auth.users(id) on delete set null;

create unique index if not exists instructors_studio_user_unique_idx
  on public.instructors (studio_id, user_id)
  where user_id is not null;

create index if not exists instructors_user_id_idx
  on public.instructors (user_id)
  where user_id is not null;

-- Safely backfill only unambiguous email matches:
-- - instructor has no user_id yet
-- - auth user email matches instructor email case-insensitively
-- - only one instructor in that studio uses the email
-- - the same user is not already linked to another instructor in that studio
with candidate_matches as (
  select
    i.id as instructor_id,
    i.studio_id,
    u.id as user_id,
    count(*) over (
      partition by i.studio_id, lower(trim(i.email))
    ) as instructor_email_count
  from public.instructors i
  join auth.users u
    on lower(trim(u.email)) = lower(trim(i.email))
  where i.user_id is null
    and i.email is not null
    and trim(i.email) <> ''
),
safe_matches as (
  select cm.*
  from candidate_matches cm
  where cm.instructor_email_count = 1
    and not exists (
      select 1
      from public.instructors existing
      where existing.studio_id = cm.studio_id
        and existing.user_id = cm.user_id
    )
)
update public.instructors i
set user_id = sm.user_id
from safe_matches sm
where i.id = sm.instructor_id
  and i.user_id is null;

-- ---------------------------------------------------------------------------
-- Google Calendar connection scopes
-- ---------------------------------------------------------------------------

alter table public.studio_google_calendar_connections
  add column if not exists connection_scope text not null default 'studio',
  add column if not exists instructor_id uuid references public.instructors(id) on delete cascade,
  add column if not exists connected_user_id uuid references auth.users(id) on delete set null;

update public.studio_google_calendar_connections
set connection_scope = 'studio'
where connection_scope is null;

update public.studio_google_calendar_connections
set connected_user_id = coalesce(updated_by, created_by)
where connected_user_id is null;

alter table public.studio_google_calendar_connections
  drop constraint if exists studio_google_calendar_connections_studio_unique;

alter table public.studio_google_calendar_connections
  drop constraint if exists studio_google_calendar_connections_scope_check;

alter table public.studio_google_calendar_connections
  add constraint studio_google_calendar_connections_scope_check
  check (
    (connection_scope = 'studio' and instructor_id is null)
    or
    (connection_scope = 'instructor' and instructor_id is not null)
  );

alter table public.studio_google_calendar_connections
  drop constraint if exists studio_google_calendar_connections_connection_scope_check;

alter table public.studio_google_calendar_connections
  add constraint studio_google_calendar_connections_connection_scope_check
  check (connection_scope in ('studio', 'instructor'));

create unique index if not exists studio_google_calendar_connections_shared_unique_idx
  on public.studio_google_calendar_connections (studio_id)
  where connection_scope = 'studio';

create unique index if not exists studio_google_calendar_connections_instructor_unique_idx
  on public.studio_google_calendar_connections (studio_id, instructor_id)
  where connection_scope = 'instructor';

create index if not exists studio_google_calendar_connections_instructor_id_idx
  on public.studio_google_calendar_connections (instructor_id)
  where instructor_id is not null;

create index if not exists studio_google_calendar_connections_connected_user_idx
  on public.studio_google_calendar_connections (connected_user_id)
  where connected_user_id is not null;

-- Ensure an instructor-scoped connection cannot point to an instructor
-- from another studio.
create or replace function public.validate_google_calendar_connection_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  instructor_studio_id uuid;
  instructor_user_id uuid;
begin
  if new.connection_scope = 'studio' then
    new.instructor_id := null;
    return new;
  end if;

  select studio_id, user_id
    into instructor_studio_id, instructor_user_id
  from public.instructors
  where id = new.instructor_id;

  if instructor_studio_id is null or instructor_studio_id <> new.studio_id then
    raise exception 'Instructor Google Calendar connection must belong to the same studio.';
  end if;

  if instructor_user_id is null then
    raise exception 'Instructor must be linked to a DanceFlow user before connecting Google Calendar.';
  end if;

  if new.connected_user_id is null then
    new.connected_user_id := instructor_user_id;
  end if;

  if new.connected_user_id <> instructor_user_id then
    raise exception 'Personal Google Calendar connection must be owned by the linked instructor user.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_google_calendar_connection_scope_trigger
  on public.studio_google_calendar_connections;

create trigger validate_google_calendar_connection_scope_trigger
before insert or update of studio_id, connection_scope, instructor_id, connected_user_id
on public.studio_google_calendar_connections
for each row
execute function public.validate_google_calendar_connection_scope();

-- ---------------------------------------------------------------------------
-- RLS: shared connections remain manager-controlled; personal connections are
-- controlled only by the linked instructor user. Platform admin behavior remains.
-- ---------------------------------------------------------------------------

drop policy if exists "Studio admins can read google calendar connections"
  on public.studio_google_calendar_connections;
drop policy if exists "Studio admins can manage google calendar connections"
  on public.studio_google_calendar_connections;
drop policy if exists "Google calendar connections are readable by authorized users"
  on public.studio_google_calendar_connections;
drop policy if exists "Google calendar connections are manageable by authorized users"
  on public.studio_google_calendar_connections;

create policy "Google calendar connections are readable by authorized users"
on public.studio_google_calendar_connections
for select
to authenticated
using (
  (
    connection_scope = 'studio'
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = studio_google_calendar_connections.studio_id
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin')
    )
  )
  or
  (
    connection_scope = 'instructor'
    and connected_user_id = auth.uid()
    and exists (
      select 1
      from public.instructors i
      where i.id = studio_google_calendar_connections.instructor_id
        and i.studio_id = studio_google_calendar_connections.studio_id
        and i.user_id = auth.uid()
        and i.active = true
    )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Google calendar connections are manageable by authorized users"
on public.studio_google_calendar_connections
for all
to authenticated
using (
  (
    connection_scope = 'studio'
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = studio_google_calendar_connections.studio_id
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin')
    )
  )
  or
  (
    connection_scope = 'instructor'
    and connected_user_id = auth.uid()
    and exists (
      select 1
      from public.instructors i
      where i.id = studio_google_calendar_connections.instructor_id
        and i.studio_id = studio_google_calendar_connections.studio_id
        and i.user_id = auth.uid()
        and i.active = true
    )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  (
    connection_scope = 'studio'
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = studio_google_calendar_connections.studio_id
        and usr.active = true
        and usr.role in ('studio_owner', 'studio_admin')
    )
  )
  or
  (
    connection_scope = 'instructor'
    and connected_user_id = auth.uid()
    and exists (
      select 1
      from public.instructors i
      where i.id = studio_google_calendar_connections.instructor_id
        and i.studio_id = studio_google_calendar_connections.studio_id
        and i.user_id = auth.uid()
        and i.active = true
    )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

drop policy if exists "Studio admins can read google calendar sync items"
  on public.studio_google_calendar_sync_items;
drop policy if exists "Studio admins can manage google calendar sync items"
  on public.studio_google_calendar_sync_items;
drop policy if exists "Google calendar sync items are readable by authorized users"
  on public.studio_google_calendar_sync_items;
drop policy if exists "Google calendar sync items are manageable by authorized users"
  on public.studio_google_calendar_sync_items;

create policy "Google calendar sync items are readable by authorized users"
on public.studio_google_calendar_sync_items
for select
to authenticated
using (
  exists (
    select 1
    from public.studio_google_calendar_connections c
    where c.id = studio_google_calendar_sync_items.connection_id
      and c.studio_id = studio_google_calendar_sync_items.studio_id
      and (
        (
          c.connection_scope = 'studio'
          and exists (
            select 1
            from public.user_studio_roles usr
            where usr.user_id = auth.uid()
              and usr.studio_id = c.studio_id
              and usr.active = true
              and usr.role in ('studio_owner', 'studio_admin')
          )
        )
        or
        (
          c.connection_scope = 'instructor'
          and c.connected_user_id = auth.uid()
        )
      )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

create policy "Google calendar sync items are manageable by authorized users"
on public.studio_google_calendar_sync_items
for all
to authenticated
using (
  exists (
    select 1
    from public.studio_google_calendar_connections c
    where c.id = studio_google_calendar_sync_items.connection_id
      and c.studio_id = studio_google_calendar_sync_items.studio_id
      and (
        (
          c.connection_scope = 'studio'
          and exists (
            select 1
            from public.user_studio_roles usr
            where usr.user_id = auth.uid()
              and usr.studio_id = c.studio_id
              and usr.active = true
              and usr.role in ('studio_owner', 'studio_admin')
          )
        )
        or
        (
          c.connection_scope = 'instructor'
          and c.connected_user_id = auth.uid()
        )
      )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
)
with check (
  exists (
    select 1
    from public.studio_google_calendar_connections c
    where c.id = studio_google_calendar_sync_items.connection_id
      and c.studio_id = studio_google_calendar_sync_items.studio_id
      and (
        (
          c.connection_scope = 'studio'
          and exists (
            select 1
            from public.user_studio_roles usr
            where usr.user_id = auth.uid()
              and usr.studio_id = c.studio_id
              and usr.active = true
              and usr.role in ('studio_owner', 'studio_admin')
          )
        )
        or
        (
          c.connection_scope = 'instructor'
          and c.connected_user_id = auth.uid()
        )
      )
  )
  or exists (
    select 1
    from public.profiles
    where profiles.id = auth.uid()
      and profiles.platform_role = 'platform_admin'
  )
);

commit;
