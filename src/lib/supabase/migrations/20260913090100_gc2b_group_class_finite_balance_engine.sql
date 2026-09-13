-- Finite + Unlimited Group-Class Membership Entitlements -- GC-2b: group-class
-- finite-balance engine.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md.
--
-- New, parallel function to _private_lesson_finite_balance (P2) -- NOT a
-- generalization of it. That function's quantity/window lookup is generic,
-- but its "reserved" subquery reads appointments.client_membership_id
-- directly and filters appointment_type in (private_lesson,intro_lesson,
-- coaching) -- structurally incompatible with group classes, whose billing
-- lives on appointment_attendees (appointments.client_membership_id is
-- always NULL on every group_class row, enforced by
-- enforce_group_class_canonical_shape). This mirrors exactly how GC-1.2
-- built a parallel package-deduction path rather than generalizing
-- deduct_package_credit_for_appointment for the identical structural reason.
--
-- Reuses _membership_benefit_period_window and _ensure_membership_period_for_date
-- (both P2) completely unmodified -- both are already benefit-type-agnostic,
-- confirmed by direct read: neither references benefit_type or
-- appointment_type anywhere in its body.
--
-- VOLATILE, deliberately, for the identical reason _private_lesson_finite_balance
-- is VOLATILE: its result must reflect appointment_attendees rows already
-- processed earlier in the same statement (see that function's own comment
-- for the full same-statement-visibility argument, which applies unchanged
-- here). It performs only SELECTs and has no side effects.
--
-- p_exclude_attendee_id is the self-exclusion parameter for an UPDATE on the
-- attendee row currently being (re-)validated -- for an INSERT, NEW.id is
-- always safe to pass here too (it hasn't been written to the heap yet, so
-- it can never be counted by this function's own read regardless).

begin;

create or replace function public._group_class_finite_balance(
  p_client_membership_id uuid,
  p_benefit_id uuid,
  p_target_date timestamptz,
  p_exclude_attendee_id uuid
) returns table(
  benefit_id uuid, membership_id uuid, window_start date, window_end date,
  quantity int, consumed int, reserved int, available int
)
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_usage_period text;
  v_quantity int;
  v_window record;
  v_consumed int;
  v_reserved int;
begin
  select mpb.usage_period, mpb.quantity into v_usage_period, v_quantity
    from public.membership_plan_benefits mpb where mpb.id = p_benefit_id;

  select * into v_window from public._membership_benefit_period_window(
    p_client_membership_id, v_usage_period, p_target_date::date
  );

  select coalesce(sum(quantity_used), 0)::int into v_consumed
    from public.client_membership_usage
    where client_membership_id = p_client_membership_id
      and membership_plan_benefit_id = p_benefit_id
      and usage_date >= v_window.window_start and usage_date <= v_window.window_end;

  select count(*)::int into v_reserved
    from public.appointment_attendees aa
    join public.appointments a on a.id = aa.appointment_id
    where aa.client_membership_id = p_client_membership_id
      and aa.billing_type = 'membership'
      and aa.status = 'booked'
      and a.appointment_type = 'group_class'
      and a.status <> 'cancelled'
      and a.starts_at >= v_window.window_start and a.starts_at <= v_window.window_end
      and (p_exclude_attendee_id is null or aa.id <> p_exclude_attendee_id)
      and not exists (
        select 1 from public.client_membership_usage cmu
        where cmu.reference_type = 'appointment' and cmu.reference_id = a.id
          and cmu.client_membership_id = aa.client_membership_id
          and cmu.membership_plan_benefit_id = p_benefit_id
      );

  return query select p_benefit_id, p_client_membership_id, v_window.window_start, v_window.window_end,
    v_quantity, v_consumed, v_reserved, (v_quantity - v_consumed - v_reserved);
end;
$$;

revoke all on function public._group_class_finite_balance(uuid, uuid, timestamptz, uuid) from public, anon, authenticated, service_role;

commit;
