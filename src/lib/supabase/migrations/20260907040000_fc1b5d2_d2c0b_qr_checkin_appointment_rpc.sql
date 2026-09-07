-- FC-1B5D2 D2C-0B: QR check-in appointment boundary.
--
-- The client-identity QR check-in flow (src/app/app/client-identity/[token]/
-- page.tsx, .../actions.ts) already resolves client identity through the
-- token-bound, SECURITY DEFINER get_client_by_qr_token_for_checkin RPC
-- (20260905160200). That RPC does NOT cover the flow's second raw read: two
-- direct `.from("appointments")` queries (the page's same-day display list,
-- the action's pre-attendance-mutation validation) that are deliberately
-- cross-instructor -- an ordinary instructor must be able to check in a
-- colleague's client for a colleague's class, the entire point of a shared
-- front-desk/QR scanning capability. Both reads depend today on the current,
-- not-yet-tightened appointments RLS granting any active studio member
-- broad SELECT visibility. Appointment RLS tightening (FC-1B5D2 D2C, not
-- yet implemented) will scope an ordinary instructor's own session to only
-- their own assigned/linked appointments, which would silently break this
-- flow. This migration adds the RPCs FC-1B5D2 D2C-0's reconciliation report
-- designed for that boundary -- no appointments RLS policy is touched here.
--
-- CORRECTED DESIGN (post-independent-review): an earlier version of this
-- migration accepted a caller-supplied `target_client_id uuid` directly,
-- authorized only by "auth.uid() has an active user_studio_roles row at
-- target_studio_id". That let ANY active studio member invoke either RPC
-- with any other real client's UUID (client ids are plain, non-secret
-- UUIDs visible in this app's own URLs) and receive that client's full
-- appointment list -- a materially broader direct capability than the
-- QR-token-gated flow these RPCs exist to preserve, and not what
-- `get_client_by_qr_token_for_checkin` (the precedent this migration's own
-- design comment claimed to follow) actually does. That version was never
-- committed; this file replaces it in place rather than leaving the
-- insecure signatures to accumulate as a second migration.
--
-- Both RPCs now take `qr_token text` instead of `target_client_id uuid`.
-- Neither accepts a client id as an authority-bearing parameter -- the
-- authorized client is resolved INTERNALLY from the token, using exactly
-- the same predicate `get_client_by_qr_token_for_checkin` already uses
-- (studio-scoped token match + an independently re-verified active
-- user_studio_roles row). That predicate is factored into a single private
-- helper, _resolve_qr_checkin_client_id, so the hardened logic exists in
-- exactly one place rather than being duplicated (and risking drifting)
-- across three functions. The helper is deliberately granted to NO role at
-- all (not even `authenticated`) -- it is reachable only from inside the
-- two SECURITY DEFINER functions below, which execute as the helper's own
-- owner and therefore retain their owner-implicit privilege to call it
-- regardless of its ACL. This keeps the externally-callable surface at
-- exactly two functions, identical to before, while eliminating the
-- caller-supplied-client-id authority gap. The helper itself is NOT a
-- generic "resolve any client by id" capability -- it only ever resolves a
-- client from a possessed token, the same property the approved identity
-- RPC already has.
--
-- Two outer RPCs, not one, per the reconciliation report's own instruction
-- to prefer two narrowly-scoped functions over one that would over-return
-- data to whichever caller needs less:
--
--   1. get_client_appointments_for_checkin -- serves the page's same-day
--      display list. Returns the fuller, already-reviewed display field set
--      (title, appointment_type, status, starts_at, ends_at, instructor
--      name, room name) that the page has always rendered.
--   2. get_client_appointment_for_checkin_validation -- serves the action's
--      pre-attendance-mutation existence/ownership check. Returns only
--      id/appointment_type/status -- title and instructor/room identity are
--      not needed to validate that a specific appointment id genuinely
--      belongs to the token-resolved client before writing an
--      attendance_records row, and returning them there would be
--      unjustified over-exposure for a validation-only call site.
--      studio_id/client_id are deliberately NOT returned by either
--      function.
--
-- Both outer RPCs:
--   - accept only target_studio_id + qr_token (+ a range or a single
--     appointment id) -- never a caller-supplied client id or instructor
--     id, so there is no way to widen results by claiming to be a
--     different client or instructor;
--   - resolve the authorized client via the private helper, which
--     independently re-verifies auth.uid() has an active user_studio_roles
--     row at target_studio_id -- they do not trust that the page/action
--     already called the QR-identity RPC first, this is enforced again
--     inside the function body every time;
--   - constrain every returned row to appointments.studio_id =
--     target_studio_id AND appointments.client_id = <token-resolved client
--     id>, so neither function can ever return another client's or another
--     studio's appointment, regardless of what the caller additionally
--     supplies -- and there is no client-id parameter left to supply in
--     the first place;
--   - apply NO status filter, matching the existing, unmodified raw queries
--     they replace exactly (the page has never filtered by status; the
--     action separately checks status = 'cancelled' after the fetch, and
--     that check remains entirely in application code, unchanged).
--
-- This migration creates exactly three functions (one private helper, two
-- externally-callable RPCs) and modifies no table, no RLS policy, and no
-- existing function. attendance_records permissions and RLS are untouched
-- -- the attendance write itself remains a separate operation, gated by
-- application code only after a successful RPC validation result, exactly
-- as today.

-- ============================================================================
-- 0. _resolve_qr_checkin_client_id -- private helper. Not granted to any
--    role; reachable only via owner-implicit privilege from the two
--    SECURITY DEFINER functions below.
-- ============================================================================
create or replace function public._resolve_qr_checkin_client_id(
  target_studio_id uuid,
  qr_token text
)
returns uuid
language sql
stable
security definer
set search_path = 'public'
as $$
  select c.id
  from public.clients c
  where c.studio_id = target_studio_id
    and c.client_qr_token = qr_token
    and exists (
      select 1
      from public.user_studio_roles usr
      where usr.user_id = auth.uid()
        and usr.studio_id = target_studio_id
        and usr.active = true
    );
$$;

-- Deliberately no grants to public/anon/authenticated/service_role at all
-- -- this must never become a second, independently reachable "resolve a
-- client from a token" entry point. The owner (postgres) can always call
-- functions it owns regardless of ACL, which is what lets the two RPCs
-- below invoke it while running as their own SECURITY DEFINER context.
revoke all on function public._resolve_qr_checkin_client_id(uuid, text) from public;
revoke all on function public._resolve_qr_checkin_client_id(uuid, text) from anon;
revoke all on function public._resolve_qr_checkin_client_id(uuid, text) from authenticated;
revoke all on function public._resolve_qr_checkin_client_id(uuid, text) from service_role;

-- ============================================================================
-- 1. get_client_appointments_for_checkin -- page display list.
-- ============================================================================
create or replace function public.get_client_appointments_for_checkin(
  target_studio_id uuid,
  qr_token text,
  range_start timestamptz,
  range_end timestamptz
)
returns table (
  id uuid,
  title text,
  appointment_type text,
  status text,
  starts_at timestamptz,
  ends_at timestamptz,
  instructor_first_name text,
  instructor_last_name text,
  room_name text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.title,
    a.appointment_type,
    a.status,
    a.starts_at,
    a.ends_at,
    i.first_name as instructor_first_name,
    i.last_name as instructor_last_name,
    r.name as room_name
  from public.appointments a
  left join public.instructors i on i.id = a.instructor_id
  left join public.rooms r on r.id = a.room_id
  where a.studio_id = target_studio_id
    and a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token)
    and a.starts_at >= range_start
    and a.starts_at < range_end
  order by a.starts_at asc;
$$;

revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) from anon;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to authenticated;
grant execute on function public.get_client_appointments_for_checkin(uuid, text, timestamptz, timestamptz) to service_role;

-- ============================================================================
-- 2. get_client_appointment_for_checkin_validation -- action pre-mutation
--    validation. Single appointment, minimal fields.
-- ============================================================================
create or replace function public.get_client_appointment_for_checkin_validation(
  target_studio_id uuid,
  qr_token text,
  target_appointment_id uuid
)
returns table (
  id uuid,
  appointment_type text,
  status text
)
language sql
stable
security definer
set search_path = 'public'
as $$
  select
    a.id,
    a.appointment_type,
    a.status
  from public.appointments a
  where a.id = target_appointment_id
    and a.studio_id = target_studio_id
    and a.client_id = public._resolve_qr_checkin_client_id(target_studio_id, qr_token);
$$;

revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from public;
revoke all on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) from anon;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to authenticated;
grant execute on function public.get_client_appointment_for_checkin_validation(uuid, text, uuid) to service_role;
