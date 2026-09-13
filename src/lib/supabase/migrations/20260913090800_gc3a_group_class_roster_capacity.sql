-- GC-3.1: Capacity Foundation -- canonical group-class roster capacity
-- invariant.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-continuing-the-streamed-moth.md,
-- Part A1/A3, Part D item 1 (gc3a).
--
-- Three additive pieces, purely backend, no self-service capability
-- introduced here:
--
--   1. appointments.roster_capacity (nullable integer; NULL = unlimited,
--      only valid for appointment_type='group_class') -- enforced by
--      EXTENDING the existing enforce_group_class_canonical_shape()
--      trigger (GC-1.4A) rather than adding a second, parallel shape
--      trigger. That function already owns "what may/must not appear on a
--      group_class row" (and the reverse: what a group_class row must
--      never carry); a group_class-only column belongs in the exact same
--      place, not a new CHECK constraint or a second trigger function.
--   2. _group_class_roster_reserved_count(p_appointment_id) -- canonical
--      reserved-seat count. GC-3.1 scope: 'booked' appointment_attendees
--      rows only (the payment-hold table this will later widen for does
--      not exist until GC-3.5).
--   3. enforce_group_class_roster_capacity -- a new BEFORE INSERT/UPDATE
--      trigger on appointment_attendees itself, so every enrollment path
--      (staff broad, instructor auto-resolved, any future self-service
--      writer) is governed by the identical invariant with no bypass.
--
-- Audited live before writing this file (confirmed against DEV,
-- 20260913090800 is the next free migration slot):
--   - appointment_attendees_status_check allows exactly two values,
--     'booked' and 'cancelled' -- there is no third "confirmed" or
--     "pending" status to worry about miscounting. 'booked' is the sole
--     counting state; 'cancelled' never counts, matching
--     appointment_attendees_cancellation_check's own booked/cancelled
--     dichotomy.
--   - appointment_id can never change on an appointment_attendees UPDATE
--     (enforce_appointment_attendee_integrity, GC-1.1, raises first --
--     alphabetically first trigger on this table). This trigger never
--     needs to consider a roster-changing UPDATE.
--   - Every appointment_attendees row is already guaranteed
--     group_class-scoped by that same GC-1.1 trigger -- no separate
--     appointment_type check is needed here, matching GC-2c's own
--     established precedent for this exact reasoning.
--   - No existing trigger on appointment_attendees or appointments
--     enforces roster capacity today.
--
-- Created and ENABLED immediately, matching P3c's and GC-2c's own
-- precedent: this is a pure validation gate with no prior conflicting
-- writer. roster_capacity is NULL on every row (new column, no writer
-- populates it until a later GC-3 slice), so this trigger is a structural
-- no-op the instant it lands and only ever starts mattering once something
-- actually sets a non-null capacity.

begin;

-- ============================================================================
-- 1. appointments.roster_capacity.
-- ============================================================================
alter table public.appointments
  add column roster_capacity integer null;

comment on column public.appointments.roster_capacity is
  'GC-3.1: group_class-only roster capacity. NULL = unlimited (default/'
  'existing behavior for every appointment). Never valid on a non-'
  'group_class row -- enforced by enforce_group_class_canonical_shape.';

-- Extend the existing canonical-shape trigger (GC-1.4A) rather than
-- duplicating a second shape-validation trigger on appointments. Original
-- body (both branches) reproduced verbatim; the only addition is the new
-- `else` branch guarding roster_capacity's group_class-only scope.
create or replace function public.enforce_group_class_canonical_shape()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  if new.appointment_type = 'group_class'::public.appointment_type then
    if new.client_id is not null
       or new.partner_client_id is not null
       or new.client_package_id is not null
       or new.client_membership_id is not null
       or new.price_amount is not null
    then
      raise exception 'A shared group class cannot carry a singular attendee, package, membership, or price -- use appointment_attendees.';
    end if;
  else
    -- GC-3.1: roster_capacity is a group_class-only concept. Any other
    -- appointment_type must never carry a non-null value -- NULL (the
    -- column default) remains valid everywhere, including here.
    if new.roster_capacity is not null then
      raise exception 'Only a group class may carry a roster capacity.';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.appointment_type is distinct from new.appointment_type then
    if old.appointment_type = 'group_class'::public.appointment_type
       or new.appointment_type = 'group_class'::public.appointment_type
    then
      raise exception 'Appointment type cannot be changed to or from group_class -- create a new appointment through the canonical class-creation path instead.';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_canonical_shape() from public;
revoke all on function public.enforce_group_class_canonical_shape() from anon;
revoke all on function public.enforce_group_class_canonical_shape() from authenticated;
revoke all on function public.enforce_group_class_canonical_shape() from service_role;
-- No grant execute statement follows: reachable only as a trigger body
-- (unchanged from GC-1.4A's own posture for this function). The trigger
-- itself (appointments_enforce_group_class_shape) already exists and does
-- not need to be re-created -- CREATE OR REPLACE FUNCTION is sufficient to
-- swap the body a live trigger executes.

-- ============================================================================
-- 2. _group_class_roster_reserved_count -- canonical reserved-seat count.
--
-- GC-3.1 scope: counts confirmed/current roster occupancy only --
-- appointment_attendees rows with status='booked'. Deliberately narrow and
-- self-contained (single p_appointment_id argument, integer return) so
-- GC-3.5 -- once group_class_enrollment_holds exists -- can widen this via
-- CREATE OR REPLACE to add active/unexpired payment holds to the count,
-- with no change needed in any caller (enforce_group_class_roster_capacity
-- below, or any future funding-resolution code).
--
-- VOLATILE, matching _group_class_finite_balance's (GC-2b) own precedent:
-- must reflect appointment_attendees rows already written earlier in the
-- same statement, which a STABLE function's fixed-per-statement snapshot
-- would not guarantee.
-- ============================================================================
create or replace function public._group_class_roster_reserved_count(
  p_appointment_id uuid
)
returns integer
language sql
volatile
security definer
set search_path = 'public'
as $$
  select count(*)::integer
  from public.appointment_attendees
  where appointment_id = p_appointment_id
    and status = 'booked';
$$;

revoke all on function public._group_class_roster_reserved_count(uuid) from public, anon, authenticated, service_role;
-- Deliberately granted to no role at all -- reachable only from inside
-- SECURITY DEFINER trigger functions via owner-implicit privilege, matching
-- the established convention for internal-only helpers in this codebase
-- (_gc1_4_has_broad_studio_authority, _group_class_finite_balance).

-- ============================================================================
-- 3. enforce_group_class_roster_capacity -- universal capacity trigger.
--
-- Lives at the canonical roster-write boundary (appointment_attendees
-- itself), so every enrollment path is governed identically -- staff
-- (enroll_class_attendee 'broad' branch), instructor (enroll_class_attendee
-- 'own_instructor' branch), and any future self-service writer all funnel
-- through the same insert/update on this one table. No RPC has, or can
-- have, a capacity-bypass parameter; there is no separate "staff override"
-- code path anywhere for this trigger to miss, matching GC-2c's own
-- "no hidden staff bypass" posture for the analogous membership-capacity
-- invariant.
--
-- Only performs the real check on a transition INTO a counting ('booked')
-- state -- a fresh INSERT, or an UPDATE from 'cancelled' to 'booked'
-- (re-booking a previously-cancelled row instead of inserting a new one,
-- which uq_appointment_attendees_active's partial unique index allows).
-- An already-'booked' row being updated for an unrelated reason (billing
-- fields, notes, etc.) is a no-op -- it already holds its seat, not a new
-- reservation. Moving OUT of 'booked' (cancellation) always releases
-- capacity and needs no check at all -- symmetric with P3c's and GC-2c's
-- own shape for the identical kind of invariant.
--
-- Locks the group-class appointment row (`for update`) BEFORE counting --
-- this is what serializes two concurrent enrollment attempts for the last
-- seat: whichever transaction acquires the row lock first counts, inserts,
-- and commits (or rolls back); the second blocks until the first's
-- transaction ends, then re-counts against the now-final committed state
-- and correctly sees whether the seat is actually still available.
--
-- NULL roster_capacity = unlimited (the default, and the state of every
-- appointment created before this migration) -- no count, no check, return
-- immediately after the lock confirms NULL.
-- ============================================================================
create or replace function public.enforce_group_class_roster_capacity()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_was_booked boolean;
  v_roster_capacity integer;
  v_reserved_count integer;
begin
  -- Not entering a counting state at all: nothing to check. Covers both
  -- "moving OUT of booked" (cancellation, always releases capacity) and
  -- "already not booked, staying not booked".
  if new.status <> 'booked' then
    return new;
  end if;

  v_was_booked := (tg_op = 'UPDATE') and (old.status = 'booked');

  -- No-op: already booked, still booked -- this write is not a new
  -- reservation (e.g. a billing-field correction on an active enrollment).
  if v_was_booked then
    return new;
  end if;

  -- Lock the group-class appointment row first -- this is what serializes
  -- concurrent enrollment attempts against the same class's roster.
  select roster_capacity into v_roster_capacity
    from public.appointments
    where id = new.appointment_id
    for update;

  if v_roster_capacity is null then
    return new;
  end if;

  v_reserved_count := public._group_class_roster_reserved_count(new.appointment_id);

  if v_reserved_count >= v_roster_capacity then
    raise exception 'This class has no available seats remaining.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_roster_capacity() from public, anon, authenticated, service_role;
-- No grant execute statement follows: reachable only as a trigger body,
-- matching enforce_appointment_attendee_integrity's (GC-1.1) and
-- enforce_group_class_membership_capacity's (GC-2c) established posture.

create trigger appointment_attendees_enforce_roster_capacity
  before insert or update on public.appointment_attendees
  for each row
  execute function public.enforce_group_class_roster_capacity();

commit;
