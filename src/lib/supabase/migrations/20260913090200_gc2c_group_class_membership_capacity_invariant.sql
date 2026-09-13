-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2c: DB
-- capacity invariant for membership-funded group-class enrollment.
--
-- Created and ENABLED immediately, matching P3c's own precedent: this is a
-- pure validation gate with no prior conflicting writer -- no code path
-- today enforces group-class membership capacity at all, so there is no
-- cutover-ordering concern. Fires unconditionally on every
-- appointment_attendees insert/update, regardless of caller (staff RPC
-- 'broad' path, instructor RPC auto-resolution, or any future path) --
-- per the approved product decision, staff/manual enrollment must not
-- silently bypass finite membership capacity, and no override mechanism is
-- introduced here.
--
-- Every appointment_attendees row is inherently group_class-scoped already
-- (enforce_appointment_attendee_integrity, GC-1.1, requires the linked
-- appointment be appointment_type='group_class' for every row in this
-- table) -- no separate appointment_type check is needed here.
--
-- Misconfiguration handling (approved product decision): if a membership's
-- plan has BOTH 'included_group_classes' and 'unlimited_group_classes'
-- benefits configured (invalid studio configuration, not structurally
-- prevented), 'unlimited_group_classes' deterministically wins -- no
-- capacity check is performed, and no double-consumption is possible since
-- only one benefit is ever selected per resolution. This is a document-only
-- invalid-configuration handling, not a validation UI -- no plan-editor
-- change is made here.
--
-- No-op detection mirrors P3c's own shape: skips re-validation only when
-- nothing entitlement-relevant changed and the row was already 'booked'.
-- Any transition INTO 'booked' (a fresh insert, or an update from some
-- other status) is never treated as a no-op.

begin;

create or replace function public.enforce_group_class_membership_capacity()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_appointment record;
  v_benefit record;
  v_balance record;
begin
  -- Only reserving ('booked') rows funded by a membership are in scope.
  if new.status <> 'booked' then
    return new;
  end if;

  if new.billing_type is distinct from 'membership' or new.client_membership_id is null then
    return new;
  end if;

  -- No-op: already booked, already membership-funded, same membership, same billing_type.
  if tg_op = 'UPDATE'
     and old.status = 'booked'
     and old.billing_type is not distinct from new.billing_type
     and old.client_membership_id is not distinct from new.client_membership_id
  then
    return new;
  end if;

  select a.id, a.starts_at into v_appointment
    from public.appointments a
    where a.id = new.appointment_id;

  -- Lock the membership row first, matching P3c's own lock-then-check
  -- order -- this is what serializes concurrent enrollment attempts against
  -- the same membership's finite balance.
  perform 1 from public.client_memberships where id = new.client_membership_id for update;

  if not exists (
    select 1 from public.client_memberships cm
    where cm.id = new.client_membership_id
      and cm.client_id = new.client_id
      and cm.studio_id = new.studio_id
      and cm.status = 'active'
  ) then
    raise exception 'This membership does not belong to this client, or is not active.';
  end if;

  -- Resolve the applicable benefit. Deterministic tie-break: unlimited wins
  -- if a plan is misconfigured with both benefit types for group classes.
  select mpb.id, mpb.benefit_type
    into v_benefit
    from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = new.client_membership_id
      and mpb.benefit_type in ('included_group_classes', 'unlimited_group_classes')
      and (
        mpb.applies_to is null
        or mpb.applies_to = ''
        or mpb.applies_to = 'all'
        or mpb.applies_to = 'group_class'
      )
    order by (mpb.benefit_type = 'unlimited_group_classes') desc
    limit 1;

  if v_benefit.id is null then
    raise exception 'This membership has no applicable group-class benefit.';
  end if;

  if v_benefit.benefit_type = 'unlimited_group_classes' then
    -- Unlimited: active membership + applicable benefit already confirmed
    -- above; no finite capacity check, no decrement.
    return new;
  end if;

  select * into v_balance from public._group_class_finite_balance(
    new.client_membership_id, v_benefit.id, v_appointment.starts_at, new.id
  );

  if v_balance.available <= 0 then
    raise exception 'No allowance remaining in this membership''s billing period for a group class.';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_group_class_membership_capacity() from public, anon, authenticated, service_role;
-- No grant execute statement follows: reachable only as a trigger body,
-- matching enforce_group_class_canonical_shape's established posture.

create trigger appointment_attendees_enforce_membership_capacity
  before insert or update on public.appointment_attendees
  for each row
  execute function public.enforce_group_class_membership_capacity();

commit;
