-- Rollback for 20260918080000_landmark1a_slice8_seat_authority.sql
--
-- Restores the exact pre-Slice-8 Slice 6 authorization body
-- (_landmark1a_authorize_counted_transition), and removes the Slice 8 seat
-- helpers, the two seat-gate triggers, and get_instructor_seat_status.
-- Slice 7 objects and the platform-role guard are untouched. No data or audit
-- rows are changed.
--
-- WARNING: rolling this back removes the DB-level seat authority: direct
-- writes to instructors and ownership demotions can again create counted
-- seats without a seat check (the Slice 6 RPCs still enforce the limit).
-- Use only under a separately approved decision.
--
-- Order matters: the triggers and status RPC are dropped first, then the
-- Slice 6 body is restored (it no longer references the helpers), then the
-- helpers are dropped last.

begin;

drop function if exists public.get_instructor_seat_status(uuid);

drop trigger if exists landmark1a_enforce_owner_seat_gate on public.user_studio_roles;
drop function if exists public._landmark1a_enforce_owner_seat_gate();

drop trigger if exists landmark1a_enforce_instructor_seat_gate on public.instructors;
drop function if exists public._landmark1a_enforce_instructor_seat_gate();

-- Slice 6 authorization body, restored verbatim.
create or replace function public._landmark1a_authorize_counted_transition(
  p_studio_id uuid,
  p_instructor public.instructors
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_is_owner boolean;
  v_seat_limit int;
  v_counted_seats int;
begin
  select exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = p_instructor.user_id
      and usr.studio_id = p_studio_id
      and usr.role = 'studio_owner'
      and usr.active = true
  ) into v_is_owner;

  if v_is_owner then
    return; -- owner never counted, never blocked
  end if;

  select public._landmark1a_resolve_studio_seat_limit(p_studio_id) into v_seat_limit;

  select count(*) into v_counted_seats
  from public.instructors i
  where i.studio_id = p_studio_id
    and i.active = true
    and i.can_instruct = true
    and i.user_id is not null
    and i.id is distinct from p_instructor.id -- defense in depth, not
      -- load-bearing: the caller only reaches this function when
      -- p_instructor's own pre-state already fails this WHERE clause by
      -- construction (its can_instruct/active is exactly the field about
      -- to transition true), so it could never legitimately self-match.
    and not exists (
      select 1 from public.user_studio_roles usr
      where usr.user_id = i.user_id
        and usr.studio_id = p_studio_id
        and usr.role = 'studio_owner'
        and usr.active = true
    );

  if v_counted_seats >= v_seat_limit then
    raise exception 'This studio has reached its instructor seat limit for the current plan. Remove or deactivate an existing instructor, or upgrade your plan, before granting capability to a new one.';
  end if;
end;
$$;

revoke all on function public._landmark1a_authorize_counted_transition(uuid, public.instructors)
  from public, anon, authenticated, service_role;

drop function if exists public._landmark1a_assert_seat_available(uuid, uuid);
drop function if exists public._landmark1a_count_counted_seats(uuid, uuid);
drop function if exists public._landmark1a_is_studio_owner(uuid, uuid);
drop function if exists public._landmark1a_seat_counted(boolean, boolean, uuid, boolean);

commit;
