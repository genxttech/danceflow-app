-- Landmark 1A -- Slice 8 -- Migration B: counted-seat authority and
-- over-limit protection.
--
-- Policy (locked): downgrades are allowed; over-limit is DERIVED (counted
-- non-owner usage > effective limit), never persisted; existing instructors
-- and work are untouched; nothing is auto-deactivated/revoked/unlinked; and
-- the STRICT rule holds: no transition INTO the counted set may result in
-- counted usage above the effective seat limit. Reductions, deactivation,
-- revocation and neutral edits are always allowed.
--
-- Before this migration the rule was enforced only inside the Slice 6 RPCs.
-- Two DB-level bypasses existed and are closed here:
--   1. Direct writes to instructors (PostgREST as owner/admin/front_desk, or
--      service role) could set active/can_instruct/user_id and create a
--      counted seat without any seat check.
--   2. Ownership changes alter counted usage without touching instructors:
--      the counted predicate excludes the active studio owner, so an owner
--      who is also a capable instructor becomes a counted seat the moment
--      they stop being owner (e.g. upsertTeamMemberRoleAction can demote an
--      owner row).
--
-- Single source of truth (no duplicated predicate):
--   _landmark1a_seat_counted(active, can_instruct, user_id, is_owner)
--   _landmark1a_is_studio_owner(studio, user)   -- canonical owner source:
--        user_studio_roles.role = 'studio_owner' AND active
--   _landmark1a_count_counted_seats(studio, exclude_instructor)
--   _landmark1a_assert_seat_available(studio, exclude_instructor)
--        -- exclusive studio seat lock (same key as Slice 6/7), resolve limit
--        -- via the existing _landmark1a_resolve_studio_seat_limit, then
--        -- require count(others) < limit, i.e. resulting usage <= limit.
-- _landmark1a_authorize_counted_transition (Slice 6) is replaced to delegate
-- to them with identical behavior (owner free; same limit; same message).
-- Two triggers then apply the SAME assertion at the canonical write
-- boundaries: instructors (INSERT / UPDATE OF active, can_instruct, user_id,
-- studio_id) and user_studio_roles (owner losing owner status).
--
-- Lock order is unchanged (linkage lock -> seat lock); the seat lock is the
-- last lock taken. Entitlement writers do not take it: seat transitions read
-- the entitlement after acquiring the lock, so a concurrent downgrade
-- serializes to either "grant then downgrade" (a permitted over-limit state)
-- or "downgrade then grant" (grant sees the lower limit).
--
-- get_instructor_seat_status(p_studio_id) exposes the derived state to staff
-- (limit, usage, over_limit) for the UI notice. No table, column, or data
-- change; no persisted over-limit flag.

begin;

-- 1. Canonical helpers ------------------------------------------------------------

create or replace function public._landmark1a_seat_counted(
  p_active boolean,
  p_can_instruct boolean,
  p_user_id uuid,
  p_is_owner boolean
)
returns boolean
language sql
immutable
security definer
set search_path = 'public'
as $$
  select coalesce(p_active, false)
     and coalesce(p_can_instruct, false)
     and p_user_id is not null
     and not coalesce(p_is_owner, false);
$$;

revoke all on function public._landmark1a_seat_counted(boolean, boolean, uuid, boolean)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_is_studio_owner(
  p_studio_id uuid,
  p_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $$
  select p_user_id is not null
     and exists (
       select 1
       from public.user_studio_roles usr
       where usr.user_id = p_user_id
         and usr.studio_id = p_studio_id
         and usr.role = 'studio_owner'
         and usr.active = true
     );
$$;

revoke all on function public._landmark1a_is_studio_owner(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public._landmark1a_count_counted_seats(
  p_studio_id uuid,
  p_exclude_instructor_id uuid default null
)
returns int
language sql
stable
security definer
set search_path = 'public'
as $$
  select count(*)::int
  from public.instructors i
  where i.studio_id = p_studio_id
    and (p_exclude_instructor_id is null or i.id <> p_exclude_instructor_id)
    and public._landmark1a_seat_counted(
      i.active, i.can_instruct, i.user_id,
      public._landmark1a_is_studio_owner(i.studio_id, i.user_id)
    );
$$;

revoke all on function public._landmark1a_count_counted_seats(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Strict result check: the transition being authorized will ADD one counted
-- seat, so the seats already used by everyone else must be strictly below the
-- effective limit (resulting usage <= limit). Takes the exclusive studio seat
-- lock itself (re-entrant when the caller already holds it).
create or replace function public._landmark1a_assert_seat_available(
  p_studio_id uuid,
  p_exclude_instructor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_limit int;
  v_usage int;
begin
  perform pg_advisory_xact_lock(hashtext(p_studio_id::text || ':instructor_seat'));

  v_limit := public._landmark1a_resolve_studio_seat_limit(p_studio_id);
  v_usage := public._landmark1a_count_counted_seats(p_studio_id, p_exclude_instructor_id);

  if v_usage >= v_limit then
    raise exception 'This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.';
  end if;
end;
$$;

revoke all on function public._landmark1a_assert_seat_available(uuid, uuid)
  from public, anon, authenticated, service_role;

-- 2. Slice 6 authorization, refactored onto the canonical helpers ----------------------

create or replace function public._landmark1a_authorize_counted_transition(
  p_studio_id uuid,
  p_instructor public.instructors
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if public._landmark1a_is_studio_owner(p_studio_id, p_instructor.user_id) then
    return; -- owner never counted, never blocked
  end if;

  perform public._landmark1a_assert_seat_available(p_studio_id, p_instructor.id);
end;
$$;

revoke all on function public._landmark1a_authorize_counted_transition(uuid, public.instructors)
  from public, anon, authenticated, service_role;

-- 3. Instructor-row transition gate ----------------------------------------------------

-- Authorizes a write only when it moves a row INTO the counted set (or into a
-- different studio's counted set). Reductions, deactivation, revocation,
-- unlinking, metadata edits, and edits to an already-counted row in the same
-- studio never validate. SECURITY DEFINER so it can call the private helpers.
create or replace function public._landmark1a_enforce_instructor_seat_gate()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_new_counted boolean;
  v_old_counted boolean;
begin
  v_new_counted := public._landmark1a_seat_counted(
    new.active, new.can_instruct, new.user_id,
    public._landmark1a_is_studio_owner(new.studio_id, new.user_id)
  );

  if not v_new_counted then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    v_old_counted := public._landmark1a_seat_counted(
      old.active, old.can_instruct, old.user_id,
      public._landmark1a_is_studio_owner(old.studio_id, old.user_id)
    );

    if v_old_counted and old.studio_id = new.studio_id then
      return new; -- already consuming a seat in this studio: no increase
    end if;

    perform public._landmark1a_assert_seat_available(new.studio_id, new.id);
  else
    perform public._landmark1a_assert_seat_available(new.studio_id, null);
  end if;

  return new;
end;
$$;

revoke all on function public._landmark1a_enforce_instructor_seat_gate()
  from public, anon, authenticated, service_role;

drop trigger if exists landmark1a_enforce_instructor_seat_gate on public.instructors;

create trigger landmark1a_enforce_instructor_seat_gate
before insert or update of active, can_instruct, user_id, studio_id
on public.instructors
for each row
execute function public._landmark1a_enforce_instructor_seat_gate();

-- 4. Ownership-transition gate ---------------------------------------------------------

-- An active studio owner who is also an active, capable, linked instructor is
-- free. When that user stops being an active owner of that studio (role
-- changed, deactivated, moved, or the row deleted) the instructor becomes a
-- counted seat, which is a transition into the counted set and must pass the
-- same seat authorization. Becoming an owner only reduces usage and is never
-- checked. Deletions that are part of a parent cascade (the profile/user or
-- the studio is already gone) are skipped so account/studio deletion is never
-- blocked by this gate.
create or replace function public._landmark1a_enforce_owner_seat_gate()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  r public.instructors;
begin
  if not (old.role = 'studio_owner' and old.active = true) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'UPDATE'
     and new.role = 'studio_owner'
     and new.active = true
     and new.studio_id = old.studio_id
     and new.user_id = old.user_id then
    return new; -- still the active owner
  end if;

  if tg_op = 'DELETE'
     and (not exists (select 1 from public.profiles where id = old.user_id)
          or not exists (select 1 from public.studios where id = old.studio_id)) then
    return old; -- cascade from account or studio deletion
  end if;

  for r in
    select * from public.instructors
    where studio_id = old.studio_id and user_id = old.user_id
  loop
    if public._landmark1a_seat_counted(r.active, r.can_instruct, r.user_id, false) then
      perform public._landmark1a_assert_seat_available(old.studio_id, r.id);
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public._landmark1a_enforce_owner_seat_gate()
  from public, anon, authenticated, service_role;

drop trigger if exists landmark1a_enforce_owner_seat_gate on public.user_studio_roles;

create trigger landmark1a_enforce_owner_seat_gate
before update or delete
on public.user_studio_roles
for each row
execute function public._landmark1a_enforce_owner_seat_gate();

-- 5. Derived seat status for the UI ------------------------------------------------------

create or replace function public.get_instructor_seat_status(p_studio_id uuid)
returns table (seat_limit int, counted_usage int, over_limit boolean)
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_caller uuid := auth.uid();
  v_limit int;
  v_usage int;
begin
  if v_caller is null then
    raise exception 'Not authenticated.';
  end if;

  if not (
    exists (
      select 1 from public.profiles p
      where p.id = v_caller and p.platform_role = 'platform_admin'
    )
    or exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = v_caller
        and usr.studio_id = p_studio_id
        and usr.active = true
        and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
    )
  ) then
    raise exception 'Not authorized to view instructor seat status for this studio.';
  end if;

  v_limit := public._landmark1a_resolve_studio_seat_limit(p_studio_id);
  v_usage := public._landmark1a_count_counted_seats(p_studio_id, null);

  return query select v_limit, v_usage, v_usage > v_limit;
end;
$$;

revoke all on function public.get_instructor_seat_status(uuid)
  from public, anon, service_role;
grant execute on function public.get_instructor_seat_status(uuid) to authenticated;

commit;
