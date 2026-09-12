-- Membership Usage-Period Alignment -- P6b: fix a generated-column write
-- defect in the already-applied P6 migration.
--
-- DEFECT (confirmed live on DEV before writing this file): every call to
-- either P6 core function failed with
--   ERROR 428C9: cannot insert a non-DEFAULT value into column
--   "duration_minutes" -- Column "duration_minutes" is a generated column.
-- because public.appointments.duration_minutes is a live
-- `GENERATED ALWAYS AS (((EXTRACT(epoch FROM (ends_at - starts_at)) /
-- (60)::numeric))::integer) STORED` column (attgenerated = 's'), confirmed
-- directly via pg_attribute/pg_attrdef against DEV. This fact is not
-- reflected anywhere in the tracked migration history that introduced
-- P1-P6, and P6's authors (this same effort, in a prior local phase)
-- explicitly wrote a computed value into that column in both the INSERT
-- (create) and UPDATE (reschedule) statements -- Postgres rejects ANY
-- explicit value for a generated column, including one that matches the
-- computed result exactly. This made the entire atomic RPC family
-- (staff create/update, student self-service create/update) fail on
-- every invocation, since all four public wrappers funnel through these
-- two shared private cores.
--
-- REPOSITORY-WIDE AUDIT (before writing this file): grepped every
-- occurrence of `duration_minutes` in src/. Exactly one pair of writers
-- targets public.appointments.duration_minutes with an explicit value --
-- the two P6 core functions corrected below. Every other occurrence is
-- either (a) a read of this same generated column for compensation/
-- reporting/availability math (unaffected -- reads of a generated column
-- work exactly like reads of any other column), or (b) a write to an
-- entirely different table/column that happens to share the name --
-- `studios.portal_self_scheduling_default_duration_minutes`,
-- `studios.intro_lesson_duration_minutes`, and
-- `event_private_lesson_blocks.duration_minutes` (a plain, non-generated
-- column on an unrelated table) -- all pre-existing, safe, historical
-- code, none of which needed any change. No other live defect was found.
--
-- FIX: CREATE OR REPLACE the two P6 core functions with IDENTICAL
-- signatures (no signature change -- both public wrappers above them and
-- P6's own rollback continue to resolve them by the same name/argument
-- types), removing `duration_minutes` from the INSERT column/value list
-- and removing the `duration_minutes = ...` assignment from the UPDATE
-- SET clause. Postgres derives the value automatically from starts_at/
-- ends_at via the column's own generation expression on every INSERT and
-- on every UPDATE that changes either timestamp -- exactly the behavior
-- this feature already relies on for every other appointment-creating
-- code path in the application. No other line in either function changes:
-- authorization is enforced entirely in the callers (unchanged here);
-- scheduling locks, membership locks, balance-check arithmetic,
-- confirmation-reset behavior, and every field carried by either wrapper
-- family are byte-for-byte identical to the P6 migration this replaces.
--
-- This is a FUNCTIONAL CHANGE that preserves the intended, already-
-- reviewed P6 product behavior -- it fixes an implementation
-- incompatibility with the live schema, not a design change.
--
-- P6 itself (20260911120600_p6_atomic_private_lesson_membership_rpcs.sql)
-- is preserved as-is and NOT edited in place -- it is an already-applied
-- migration artifact on DEV. This file is a new, separate forward
-- migration so the repository preserves the exact sequence DEV
-- experienced, and so PROD can later execute the identical sequence
-- (P6 then P6b) rather than a silently-rewritten P6.

begin;

create or replace function public._lesson_membership_reservation_core_create(
  p_studio_id uuid, p_client_id uuid, p_client_membership_id uuid,
  p_instructor_id uuid, p_room_id uuid, p_appointment_type text, p_title text,
  p_starts_at timestamptz, p_ends_at timestamptz,
  p_notes text default null, p_location_name text default null,
  p_partner_client_id uuid default null, p_billing_note text default null
) returns uuid
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_benefit_id uuid;
  v_balance record;
  v_result uuid;
begin
  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = p_client_membership_id and cm.client_id = p_client_id and cm.studio_id = p_studio_id
  ) then
    raise exception 'This membership does not belong to this client.';
  end if;

  perform 1 from public.client_memberships where id = p_client_membership_id for update;

  select mpb.id into v_benefit_id
    from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = p_client_membership_id and mpb.benefit_type = 'included_private_lessons';
  if v_benefit_id is null then
    raise exception 'This membership has no private-lesson benefit.';
  end if;

  select * into v_balance from public._private_lesson_finite_balance(
    p_client_membership_id, v_benefit_id, p_starts_at, null
  );
  if v_balance.available <= 0 then
    raise exception 'No allowance remaining in this membership''s billing period for a private lesson.';
  end if;

  -- P6b fix: duration_minutes removed from both the column list and the
  -- values list -- it is a GENERATED ALWAYS STORED column on
  -- public.appointments; Postgres derives it from starts_at/ends_at.
  insert into public.appointments (
    studio_id, client_id, client_membership_id, instructor_id, room_id,
    appointment_type, title, starts_at, ends_at, billing_type, status,
    notes, location_name, partner_client_id, billing_note
  ) values (
    p_studio_id, p_client_id, p_client_membership_id, p_instructor_id, p_room_id,
    p_appointment_type::public.appointment_type, p_title, p_starts_at, p_ends_at,
    'membership', 'scheduled',
    p_notes, p_location_name, p_partner_client_id, p_billing_note
  ) returning id into v_result;

  return v_result;
end;
$$;

revoke all on function public._lesson_membership_reservation_core_create(uuid, uuid, uuid, uuid, uuid, text, text, timestamptz, timestamptz, text, text, uuid, text) from public, anon, authenticated, service_role;

create or replace function public._lesson_membership_reservation_core_update(
  p_appointment_id uuid,
  p_new_client_id uuid,
  p_new_appointment_type text,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_new_billing_type text,
  p_new_client_membership_id uuid,
  p_new_instructor_id uuid,
  p_new_room_id uuid,
  p_new_status text,
  p_new_notes text default null,
  p_new_location_name text default null,
  p_new_partner_client_id uuid default null,
  p_new_billing_note text default null,
  p_reset_confirmation boolean default true
) returns void
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_old record;
  v_benefit_id uuid;
  v_balance record;
begin
  select * into v_old from public.appointments where id = p_appointment_id for update;
  if not found then
    raise exception 'Appointment not found.';
  end if;

  if p_new_billing_type = 'membership' then
    if p_new_client_membership_id is null then
      raise exception 'A membership must be specified for a membership-funded appointment.';
    end if;
    if not exists (
      select 1 from public.client_memberships cm
      where cm.id = p_new_client_membership_id and cm.client_id = p_new_client_id and cm.studio_id = v_old.studio_id
    ) then
      raise exception 'This membership does not belong to this client.';
    end if;

    perform 1 from public.client_memberships where id = p_new_client_membership_id for update;

    select mpb.id into v_benefit_id
      from public.membership_plan_benefits mpb
      join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
      where cm.id = p_new_client_membership_id and mpb.benefit_type = 'included_private_lessons';
    if v_benefit_id is null then
      raise exception 'This membership has no private-lesson benefit.';
    end if;

    select * into v_balance from public._private_lesson_finite_balance(
      p_new_client_membership_id, v_benefit_id, p_new_starts_at, p_appointment_id
    );
    if v_balance.available <= 0 then
      raise exception 'No allowance remaining in this membership''s billing period for a private lesson.';
    end if;
  end if;

  -- One atomic update -- every field the caller is authorized to set (or
  -- has derived from trusted DB state) is written in this single
  -- statement, never a core call followed by a second, separate
  -- `.update()` from the wrapper.
  --
  -- P6b fix: the `duration_minutes = ...` assignment removed -- it is a
  -- GENERATED ALWAYS STORED column; Postgres regenerates it automatically
  -- whenever starts_at/ends_at change in this same statement.
  update public.appointments
    set client_id = p_new_client_id,
        appointment_type = p_new_appointment_type::public.appointment_type,
        starts_at = p_new_starts_at,
        ends_at = p_new_ends_at,
        billing_type = p_new_billing_type,
        client_membership_id = p_new_client_membership_id,
        instructor_id = p_new_instructor_id,
        room_id = p_new_room_id,
        status = p_new_status::public.appointment_status,
        notes = p_new_notes,
        location_name = p_new_location_name,
        partner_client_id = p_new_partner_client_id,
        billing_note = p_new_billing_note,
        confirmed_at = case when p_reset_confirmation then null else confirmed_at end,
        confirmation_source = case when p_reset_confirmation then null else confirmation_source end,
        confirmation_actor_user_id = case when p_reset_confirmation then null else confirmation_actor_user_id end,
        updated_at = now()
    where id = p_appointment_id;
end;
$$;

revoke all on function public._lesson_membership_reservation_core_update(uuid, uuid, text, timestamptz, timestamptz, text, uuid, uuid, uuid, text, text, text, uuid, text, boolean) from public, anon, authenticated, service_role;

commit;
