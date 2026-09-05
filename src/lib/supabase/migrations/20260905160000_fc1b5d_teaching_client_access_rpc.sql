-- FC-1B5D Phase A: get_teaching_clients_for_instructor
--
-- Introduces the first of two controlled instructor interfaces designed in
-- the FC-1B5D containment audit/design. This function does NOT change any
-- existing RLS policy on public.clients -- Phase B (a separate, later,
-- explicitly-authorized slice) will narrow direct clients RLS access once
-- every instructor-facing raw clients dependency has migrated to these
-- controlled interfaces and that migration is verified live in production.
--
-- Purpose: let an authenticated studio instructor retrieve a field-minimized
-- projection of clients they have a genuine, current/recent teaching
-- relationship with -- never the full clients row, and never another
-- instructor's roster.
--
-- Identity resolution: derived entirely from auth.uid() via the instructors
-- table (user_id column) -- the function never accepts an instructor id
-- parameter, so there is no parameter surface to request another
-- instructor's roster through.
--
-- Qualifying relationship (per the approved FC-1B5D lifecycle rule):
--   A. Current/future -- status in (scheduled, confirmed, rescheduled) AND
--      the appointment's effective end time (ends_at, falling back to
--      starts_at + duration_minutes when ends_at is null) is still >= now().
--      This is what prevents a stale appointment that never transitioned
--      out of "scheduled" from granting indefinite access -- the boundary
--      is real elapsed time, not just status.
--   B. Historical -- status = attended AND the effective end time is
--      strictly less than 14 days in the past (effective_end_at > now() -
--      interval '14 days'). Exactly 14 days does not qualify. no_show and
--      cancelled never satisfy either branch -- neither status string
--      appears in either branch's condition, so there is nothing to
--      separately exclude.
--
-- Field minimization happens inside this function, not left to caller
-- discipline: the RETURNS TABLE column list is the entire teaching-safe
-- field set approved for this slice (name, dance_goals, skill_level,
-- photo_url) -- notes, referral_source, address, birthday, financial/lead
-- fields, import metadata, and the QR token are never selected here at all.
--
-- No platform_admin bypass is included: this function represents an actual
-- teaching relationship, not a general administrative override, and no
-- caller in this design needs one.
create or replace function public.get_teaching_clients_for_instructor(
  target_studio_id uuid,
  target_client_id uuid default null
)
returns table (
  id uuid,
  first_name text,
  last_name text,
  dance_goals text[],
  skill_level text,
  photo_url text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select distinct on (c.id)
    c.id,
    c.first_name,
    c.last_name,
    c.dance_goals,
    c.skill_level,
    c.photo_url
  from public.appointments a
  join public.instructors i
    on i.id = a.instructor_id
  join public.clients c
    on c.id = a.client_id
  where i.user_id = auth.uid()
    and i.studio_id = target_studio_id
    and i.active = true
    and a.studio_id = target_studio_id
    and c.studio_id = target_studio_id
    and (target_client_id is null or c.id = target_client_id)
    and (
      (
        a.status in ('scheduled', 'confirmed', 'rescheduled')
        and coalesce(
          a.ends_at,
          a.starts_at + (coalesce(a.duration_minutes, 0) * interval '1 minute')
        ) >= now()
      )
      or
      (
        a.status = 'attended'
        and coalesce(
          a.ends_at,
          a.starts_at + (coalesce(a.duration_minutes, 0) * interval '1 minute')
        ) > now() - interval '14 days'
      )
    )
  order by c.id, c.last_name, c.first_name;
$$;

-- Supabase creates functions with an explicit per-role EXECUTE grant for
-- `anon`, not merely an inherited PUBLIC grant -- revoking from PUBLIC alone
-- does not remove it (matches the established convention in
-- 20260831090000_user_has_client_portal_access_helper.sql). This function
-- has no reason to ever be invoked by an unauthenticated caller.
revoke all on function public.get_teaching_clients_for_instructor(uuid, uuid) from public;
revoke all on function public.get_teaching_clients_for_instructor(uuid, uuid) from anon;
grant execute on function public.get_teaching_clients_for_instructor(uuid, uuid) to authenticated;
grant execute on function public.get_teaching_clients_for_instructor(uuid, uuid) to service_role;
