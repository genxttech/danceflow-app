-- Membership Usage-Period Alignment -- P3c: DB capacity invariant.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections O, P.
--
-- Created and ENABLED immediately, unlike the usage-sync trigger in P3 --
-- this is a pure validation gate with no prior writer to conflict with; it
-- can only ever reject something that was already going to be an
-- entitlement violation, so there is no cutover-ordering concern.
--
-- Confirmed live before writing this trigger: no existing constraint or
-- trigger on public.appointments enforces membership entitlement capacity
-- today (appointments_deduct_package_credit_attended,
-- appointments_enforce_group_class_shape, set_appointments_updated_at,
-- trg_reward_appointment_attended -- none of them touch this).

begin;

create or replace function public.enforce_private_lesson_membership_capacity()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_benefit_id uuid;
  v_balance record;
  v_old_is_lesson boolean;
  v_new_is_lesson boolean;
  v_was_active boolean;
  v_is_active boolean;
begin
  v_old_is_lesson := (tg_op = 'UPDATE') and (old.appointment_type in ('private_lesson', 'intro_lesson', 'coaching'));
  v_new_is_lesson := new.appointment_type in ('private_lesson', 'intro_lesson', 'coaching');

  -- 1. Attended-history immutable-field check -- evaluated unconditionally,
  --    first, regardless of type/billing (plan section P).
  if tg_op = 'UPDATE' and old.status = 'attended' and (
    old.starts_at is distinct from new.starts_at
    or old.billing_type is distinct from new.billing_type
    or old.client_membership_id is distinct from new.client_membership_id
    or old.client_id is distinct from new.client_id
    or old.appointment_type is distinct from new.appointment_type
  ) then
    raise exception 'This appointment has already been attended -- its type, schedule, client, and billing source can no longer be changed.';
  end if;

  -- 2. Applicable at all? Neither side is a lesson type -> nothing to do.
  if not v_old_is_lesson and not v_new_is_lesson then
    return new;
  end if;

  -- 3. Moving OUT of a lesson type: releases whatever reservation existed,
  --    no availability check needed (symmetric with active->cancelled).
  if v_old_is_lesson and not v_new_is_lesson then
    return new;
  end if;

  -- 4. Is the resulting row membership-funded?
  if new.billing_type is distinct from 'membership' or new.client_membership_id is null then
    return new;
  end if;

  -- 5. No-op early return: nothing entitlement-relevant changed. Moving
  --    INTO a lesson type from a non-lesson type is never a no-op
  --    (v_old_is_lesson is false, so this whole AND short-circuits false;
  --    every INSERT of a membership-funded lesson always proceeds to full
  --    validation).
  v_was_active := (tg_op = 'UPDATE') and v_old_is_lesson and (old.status <> 'cancelled');
  v_is_active := (new.status <> 'cancelled');

  if tg_op = 'UPDATE' and v_old_is_lesson
     and old.appointment_type is not distinct from new.appointment_type
     and old.client_id is not distinct from new.client_id
     and old.starts_at is not distinct from new.starts_at
     and old.billing_type is not distinct from new.billing_type
     and old.client_membership_id is not distinct from new.client_membership_id
     and v_was_active = v_is_active
  then
    return new;
  end if;

  -- Transitioning into (or already at) a non-reserving state releases
  -- capacity -- no check needed; this is also what makes a raw
  -- cancelled->active transition (reactivation-style bypass) fall through
  -- to full revalidation below, rather than skip it.
  if not v_is_active then
    return new;
  end if;

  -- 6. Ownership/studio/client validation -- a membership belonging to a
  --    different client or studio can never fund a reservation merely
  --    because it carries the right benefit type.
  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = new.client_membership_id and cm.client_id = new.client_id and cm.studio_id = new.studio_id
  ) then
    raise exception 'This membership does not belong to this client at this studio.';
  end if;

  -- 7. Membership lock (re-entrant within the same transaction if the
  --    calling RPC already holds it, plan section X -- no deadlock).
  perform 1 from public.client_memberships where id = new.client_membership_id for update;

  -- 8. Benefit/window resolution.
  select mpb.id into v_benefit_id
    from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = new.client_membership_id and mpb.benefit_type = 'included_private_lessons';
  if v_benefit_id is null then
    raise exception 'This membership has no private-lesson benefit.';
  end if;

  -- 9. Balance calculation, excluding self.
  select * into v_balance from public._private_lesson_finite_balance(
    new.client_membership_id, v_benefit_id, new.starts_at, new.id
  );

  -- 10. Allow/reject.
  if v_balance.available <= 0 then
    raise exception 'No allowance remaining in this membership''s billing period for a private lesson.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_private_lesson_membership_capacity() from public, anon, authenticated, service_role;

create trigger appointments_enforce_private_lesson_membership_capacity
  before insert or update on public.appointments
  for each row
  execute function public.enforce_private_lesson_membership_capacity();

commit;
