-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2f:
-- attendance-triggered membership usage sync for group classes.
--
-- New, parallel trigger to deduct_package_credit_for_class_attendee (GC-1.2)
-- -- same eligibility re-check (class_enrollment_covers_participation), same
-- roster-row resolution order (prefer booked, else most recent). Where it
-- differs, deliberately: this is written preservation-first from day one,
-- applying the lesson this engagement already learned the hard way building
-- the private-lesson equivalent (P6d) -- it NEVER deletes an existing
-- client_membership_usage row under any circumstance, upserts idempotently
-- keyed on the already-widened client_membership_usage_appointment_unique_idx
-- (reference_type, reference_id, client_membership_id), and logs any
-- unresolvable state to membership_usage_sync_errors.attendance_record_id
-- (GC-2e's index) rather than guessing or fabricating usage.
--
-- CORRECTED product decision (supersedes this file's own first draft, which
-- fired only on 'attended'): for group classes, 'attended' AND 'no_show' are
-- both membership-CONSUMPTION states -- confirmed live against real,
-- already-shipped, already-tested product behavior
-- (test_T_gc1_2_class_attendance_integrity_billing_foundation.sql's own
-- T-gc1-2-status-transitions test proves attended<->no_show and
-- registered->attended are intentional, supported transitions for group
-- classes, unlike private lessons). This trigger therefore fires on entry
-- into EITHER state, and firing again on a transition BETWEEN them
-- (attended<->no_show) must preserve the existing usage row unchanged, never
-- create a second one -- guaranteed by the idempotent upsert logic below,
-- which resolves to the same canonical values on either status value and is
-- keyed on (appointment_id, client_membership_id), not on the specific
-- status string. GC-2g (this slice's other new migration) is the
-- complementary guard: it blocks the REVERSE direction (consuming ->
-- non-consuming) for membership-funded attendees only, so a silent,
-- unaudited entitlement restoration can never happen on this write path.
--
-- Approved product decision: an unlimited_group_classes attendance still
-- writes an idempotent usage/audit row (membership, benefit, period,
-- appointment, quantity_used=1) -- no balance is ever computed or checked
-- for it, matching the capacity trigger's own unlimited short-circuit.
--
-- Only proceeds for billing_type='membership' with a populated
-- client_membership_id -- a package-billed or PAYG/free-comped attendee is
-- untouched by this trigger, exactly as a membership-billed attendee is
-- untouched by GC-1.2's package trigger. No different ordinary attendance
-- UX exists for a membership-funded attendee -- this trigger only ever
-- writes silently to client_membership_usage in the background; it never
-- blocks, alters, or diverges the attendance-marking action itself.

begin;

create or replace function public.deduct_membership_usage_for_class_attendee()
returns trigger
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_appointment record;
  v_attendee record;
  v_benefit record;
  v_period_id uuid;
  v_desired_usage_date date;
  v_desired_quantity numeric;
  v_existing record;
begin
  if tg_op = 'UPDATE' and old.status is not distinct from new.status then
    return new;
  end if;

  if new.status not in ('attended', 'no_show') or new.appointment_id is null then
    return new;
  end if;

  select id, appointment_type, starts_at, studio_id into v_appointment
    from public.appointments
    where id = new.appointment_id;

  if v_appointment.appointment_type is distinct from 'group_class'::public.appointment_type then
    return new;
  end if;

  if not public.class_enrollment_covers_participation(new.appointment_id, new.client_id, new.studio_id) then
    return new;
  end if;

  select aa.id, aa.client_membership_id, aa.billing_type
    into v_attendee
    from public.appointment_attendees aa
    where aa.appointment_id = new.appointment_id
      and aa.client_id = new.client_id
    order by (aa.status = 'booked') desc, aa.created_at desc
    limit 1;

  if v_attendee.billing_type is distinct from 'membership' or v_attendee.client_membership_id is null then
    return new;
  end if;

  -- Resolve the applicable benefit -- same deterministic tie-break as GC-2c
  -- (unlimited wins on a misconfigured plan, never double-consumed).
  select mpb.id, mpb.benefit_type
    into v_benefit
    from public.membership_plan_benefits mpb
    join public.client_memberships cm on cm.membership_plan_id = mpb.membership_plan_id
    where cm.id = v_attendee.client_membership_id
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
    -- Ambiguous: membership-billed attendee with no resolvable group-class
    -- benefit on their current membership. Never fabricate usage.
    begin
      insert into public.membership_usage_sync_errors (
        studio_id, attendance_record_id, client_id, client_membership_id,
        error_message, reason_code
      ) values (
        new.studio_id, new.id, new.client_id, v_attendee.client_membership_id,
        'Attended, membership-billed class attendee has no resolvable group-class benefit on their current membership.',
        'group_class_membership_benefit_unresolved'
      );
    exception when unique_violation then
      null;
    end;
    return new;
  end if;

  v_desired_usage_date := v_appointment.starts_at::date;
  v_desired_quantity := 1;

  -- Resolve/advance the period for both finite and unlimited benefits, so
  -- the audit row always carries a correct period reference -- no balance
  -- is computed or checked here for either branch; GC-2c already gated
  -- finite capacity at enrollment time.
  v_period_id := public._ensure_membership_period_for_date(v_attendee.client_membership_id, v_desired_usage_date);

  select id, membership_plan_benefit_id, client_membership_period_id, usage_date, quantity_used
    into v_existing
    from public.client_membership_usage
    where reference_type = 'appointment' and reference_id = new.appointment_id
      and client_membership_id = v_attendee.client_membership_id;

  if v_existing.id is null then
    begin
      insert into public.client_membership_usage (
        client_membership_id, client_membership_period_id, membership_plan_benefit_id,
        usage_date, quantity_used, reference_type, reference_id
      ) values (
        v_attendee.client_membership_id, v_period_id, v_benefit.id,
        v_desired_usage_date, v_desired_quantity, 'appointment', new.appointment_id
      );
    exception when unique_violation then
      -- Concurrent call already recorded this -- idempotent no-op.
      null;
    end;
  elsif v_existing.membership_plan_benefit_id is distinct from v_benefit.id
     or v_existing.client_membership_period_id is distinct from v_period_id
     or v_existing.usage_date is distinct from v_desired_usage_date
     or v_existing.quantity_used is distinct from v_desired_quantity
  then
    update public.client_membership_usage
      set membership_plan_benefit_id = v_benefit.id,
          client_membership_period_id = v_period_id,
          usage_date = v_desired_usage_date,
          quantity_used = v_desired_quantity
      where id = v_existing.id;
  end if;
  -- else: already canonical, no-op.

  update public.membership_usage_sync_errors
    set resolved_at = now(),
        resolution_notes = coalesce(resolution_notes, '') ||
          case when resolution_notes is null or resolution_notes = '' then '' else ' | ' end ||
          'Canonical group-class membership usage established as of ' || now()::text || '.'
    where attendance_record_id = new.id
      and resolved_at is null;

  return new;

exception when others then
  begin
    insert into public.membership_usage_sync_errors (
      studio_id, attendance_record_id, client_id, client_membership_id, membership_plan_benefit_id, error_message
    ) values (
      new.studio_id, new.id, new.client_id, v_attendee.client_membership_id, v_benefit.id, sqlerrm
    );
  exception when others then
    null;
  end;
  return new;
end;
$$;

revoke all on function public.deduct_membership_usage_for_class_attendee() from public, anon, authenticated, service_role;

drop trigger if exists attendance_records_deduct_membership_usage_for_class on public.attendance_records;

create trigger attendance_records_deduct_membership_usage_for_class
  after insert or update of status on public.attendance_records
  for each row
  when (new.status in ('attended', 'no_show') and new.appointment_id is not null)
  execute function public.deduct_membership_usage_for_class_attendee();

commit;
