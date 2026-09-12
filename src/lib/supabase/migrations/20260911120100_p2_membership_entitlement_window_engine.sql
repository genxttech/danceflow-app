-- Membership Usage-Period Alignment -- P2: generic entitlement-window engine.
--
-- Canonical plan: C:\Users\mcurt\.claude\plans\we-are-starting-a-functional-liskov.md, sections D, E, G.
--
-- Implements the two functions the plan's own integrity report flagged as
-- "behavioral contract approved, literal SQL never drafted in any prior
-- round": _membership_benefit_period_window (D) and
-- _ensure_membership_period_for_date (E). Both are ported directly from
-- src/lib/memberships/renewal.ts's calculateNextPeriod/
-- ensureMembershipPeriodForDate -- read in full before writing this file.
--
-- IMPORTANT CORRECTION vs. the plan's prose (not a product-decision change,
-- a factual one): the plan's section D describes calculateNextPeriod as
-- "clamping day-of-month overflow to the last valid day of the target
-- month." Having read the actual function, this is incorrect --
-- calculateNextPeriod uses plain JS Date month/year arithmetic, which ROLLS
-- OVER into the following month rather than clamping (e.g. Jan 31 + 1 month
-- -> Mar 2/3, not Feb 28/29). Section E explicitly requires "a direct SQL
-- port of ensureMembershipPeriodForDate's exact logic" -- so this migration
-- ports the real, rollover behavior for the billing_cycle/billing-interval
-- arithmetic (both here and in _ensure_membership_period_for_date), to avoid
-- silently changing already-shipped billing-period math.
--
-- The NEW, independent usage_period='monthly' cadence (plan section C) is a
-- brand-new product decision with no existing TS equivalent to port --
-- its explicit, approved spec IS clamping ("Jan 31 anchor -> Feb 28/29, not
-- Mar 3"), and is implemented as specified, deliberately different from the
-- billing_cycle arithmetic above.

begin;

-- ============================================================================
-- 1. Private month-arithmetic helpers (not part of the plan's named
--    function list; factored out only because both _membership_benefit_
--    period_window and _ensure_membership_period_for_date need the exact
--    same billing-cycle rollover math, and it must be written once).
-- ============================================================================

-- Adds p_months calendar months to p_date using the SAME rollover semantics
-- as JS's Date.setUTCMonth: day-of-month is preserved when possible; if the
-- target month is too short, the excess days roll into the month(s) after.
-- Equivalent derivation: new Date(Y, M, D) === first-of-target-month +
-- (D-1) days, since adding whole months to the 1st of a month is always
-- exact (day=1 is valid in every month, so Postgres's own interval
-- arithmetic on the 1st never needs to clamp or roll over).
create or replace function public._membership_period_add_months_rollover(
  p_date date, p_months int
) returns date
language sql
immutable
security definer
set search_path = 'public'
as $$
  select (date_trunc('month', p_date) + (p_months || ' months')::interval)::date
    + (extract(day from p_date)::int - 1);
$$;

revoke all on function public._membership_period_add_months_rollover(date, int) from public, anon, authenticated, service_role;

-- Adds p_months calendar months to p_date, clamping day-of-month overflow to
-- the last valid day of the target month (e.g. Jan 31 + 1 month -> Feb 28,
-- or Feb 29 in a leap year -- never Mar 3). Used only for the independent
-- usage_period='monthly' cadence (plan section C), never for billing-cycle
-- arithmetic.
create or replace function public._membership_period_add_months_clamped(
  p_date date, p_months int
) returns date
language sql
immutable
security definer
set search_path = 'public'
as $$
  select v.first_of_target
    + (least(extract(day from p_date)::int, extract(day from (v.first_of_target + interval '1 month' - interval '1 day'))::int) - 1)
  from (
    select (date_trunc('month', p_date) + (p_months || ' months')::interval)::date as first_of_target
  ) v;
$$;

revoke all on function public._membership_period_add_months_clamped(date, int) from public, anon, authenticated, service_role;

-- ============================================================================
-- 2. Generic entitlement-window engine (plan section D).
--
-- Pure/read-only, zero writes, STABLE. Given a benefit's usage_period and a
-- target occurrence date, returns the [window_start, window_end] that date
-- falls into. Never creates or advances a client_membership_periods row --
-- that is _ensure_membership_period_for_date's (mutating) job, at real
-- consumption time only, never here.
-- ============================================================================
create or replace function public._membership_benefit_period_window(
  p_membership_id uuid,
  p_usage_period text,   -- 'billing_cycle' | 'monthly'
  p_target_date date
) returns table(window_start date, window_end date)
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_membership record;
  v_is_future_projectable boolean;
  v_ceiling date;
  v_win_start date;
  v_win_end date;
  v_safety int;
begin
  select current_period_start, current_period_end, billing_interval_snapshot,
         auto_renew, cancel_at_period_end, status, starts_on
    into v_membership
    from public.client_memberships
    where id = p_membership_id;

  if not found then
    return;
  end if;

  -- Future-projection safety guard, identical for both branches and reused
  -- unmodified from Revision 5 section 4's resolved rule: a window may only
  -- be projected forward past current_period_end when the membership is
  -- genuinely expected to keep covering future dates -- local or
  -- Stripe-backed, uniformly (this function never queries
  -- stripe_subscriptions itself; the same auto_renew/cancel_at_period_end/
  -- status fields already capture "is this expected to keep covering
  -- future dates" regardless of what's advancing the membership).
  v_is_future_projectable := (
    v_membership.auto_renew = true
    and v_membership.cancel_at_period_end = false
    and v_membership.status in ('active', 'past_due', 'unpaid')
  );
  v_ceiling := v_membership.current_period_end;

  if p_usage_period = 'monthly' then
    -- Membership-relative independent monthly cadence (plan section C).
    -- Window N (N starting at 0) = [anchor+N months clamped,
    -- anchor+(N+1) months clamped - 1 day], always computed relative to
    -- the ORIGINAL anchor (starts_on), never chained from the previous
    -- window's end -- chaining would let the clamped day-of-month drift
    -- permanently downward after the first short month, which the plan's
    -- own "adding exactly one calendar month to the anchor" wording rules
    -- out. N is walked as a plain integer counter, not estimated.
    declare
      v_n int := 0;
    begin
      v_win_start := public._membership_period_add_months_clamped(v_membership.starts_on, v_n);
      v_win_end := public._membership_period_add_months_clamped(v_membership.starts_on, v_n + 1) - 1;

      if p_target_date < v_win_start then
        -- Before the membership ever existed -- nothing to project
        -- backward to; return the first window unprojected. The caller's
        -- own date-range comparison will correctly find no coverage for a
        -- date that precedes window_start.
        return query select v_win_start, v_win_end;
        return;
      end if;

      v_safety := 0;
      while p_target_date > v_win_end and v_safety < 24 loop
        v_safety := v_safety + 1;
        exit when not v_is_future_projectable and v_win_end >= v_ceiling;
        v_n := v_n + 1;
        v_win_start := public._membership_period_add_months_clamped(v_membership.starts_on, v_n);
        v_win_end := public._membership_period_add_months_clamped(v_membership.starts_on, v_n + 1) - 1;
      end loop;
    end;

    return query select v_win_start, v_win_end;
    return;
  else
    -- 'billing_cycle' (also the default/else branch, matching
    -- calculateNextPeriod's own if/elsif/else shape): anchored on the
    -- membership's real current_period_start/end, stepping by
    -- billing_interval_snapshot, using the EXACT rollover arithmetic
    -- ensureMembershipPeriodForDate already uses in production.
    v_win_start := v_membership.current_period_start;
    v_win_end := v_membership.current_period_end;
    v_safety := 0;

    while p_target_date > v_win_end and v_safety < 24 loop
      v_safety := v_safety + 1;
      exit when not v_is_future_projectable and v_win_end >= v_ceiling;
      v_win_start := v_win_end + 1;
      v_win_end := case v_membership.billing_interval_snapshot
        when 'quarterly' then public._membership_period_add_months_rollover(v_win_start, 3)
        when 'yearly' then public._membership_period_add_months_rollover(v_win_start, 12)
        else public._membership_period_add_months_rollover(v_win_start, 1)
      end - 1;
    end loop;

    -- Symmetric backward walk for a target date before the current window
    -- (e.g. a historical, already-elapsed occurrence) -- never speculative,
    -- so no future-projectable restriction applies in this direction.
    v_safety := 0;
    while p_target_date < v_win_start and v_safety < 24 loop
      v_safety := v_safety + 1;
      v_win_end := v_win_start - 1;
      v_win_start := case v_membership.billing_interval_snapshot
        when 'quarterly' then public._membership_period_add_months_rollover(v_win_end + 1, -3)
        when 'yearly' then public._membership_period_add_months_rollover(v_win_end + 1, -12)
        else public._membership_period_add_months_rollover(v_win_end + 1, -1)
      end;
    end loop;

    return query select v_win_start, v_win_end;
    return;
  end if;
end;
$$;

revoke all on function public._membership_benefit_period_window(uuid, text, date) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. Authoritative membership-period synchronization (plan section E).
--
-- Mutating, VOLATILE. Direct SQL port of ensureMembershipPeriodForDate's
-- exact logic and exact safety exclusions. Called only at real,
-- already-elapsed attendance/consumption time (P3), never at booking/
-- reservation time (P2/P3c/P6 use the pure window function above instead).
-- ============================================================================
create or replace function public._ensure_membership_period_for_date(
  p_membership_id uuid,
  p_target_date date
) returns uuid
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_membership record;
  v_current_start date;
  v_current_end date;
  v_next_start date;
  v_next_end date;
  v_advanced boolean := false;
  v_safety int := 0;
  v_period_id uuid;
  v_has_stripe boolean;
begin
  select id, studio_id, client_id, status, current_period_start, current_period_end,
         price_snapshot, billing_interval_snapshot, auto_renew, cancel_at_period_end, created_by
    into v_membership
    from public.client_memberships
    where id = p_membership_id;

  if not found then
    return null;
  end if;

  if not v_membership.auto_renew
     or v_membership.cancel_at_period_end
     or v_membership.status not in ('active', 'past_due', 'unpaid')
  then
    return null;
  end if;

  -- Stripe-backed memberships are advanced by Stripe/webhook synchronization
  -- only -- local reconciliation must never race that source of truth.
  select exists (
    select 1 from public.stripe_subscriptions
    where client_membership_id = v_membership.id
  ) into v_has_stripe;

  if v_has_stripe then
    return null;
  end if;

  v_current_start := v_membership.current_period_start;
  v_current_end := v_membership.current_period_end;

  while v_current_end < p_target_date and v_safety < 24 loop
    v_safety := v_safety + 1;

    v_next_start := v_current_end + 1;
    v_next_end := case v_membership.billing_interval_snapshot
      when 'quarterly' then public._membership_period_add_months_rollover(v_next_start, 3)
      when 'yearly' then public._membership_period_add_months_rollover(v_next_start, 12)
      else public._membership_period_add_months_rollover(v_next_start, 1)
    end - 1;

    insert into public.client_membership_periods (
      studio_id, client_id, client_membership_id, period_start, period_end,
      amount_due, amount_paid, currency, payment_status, payment_due_at, created_by
    ) values (
      v_membership.studio_id, v_membership.client_id, v_membership.id, v_next_start, v_next_end,
      coalesce(v_membership.price_snapshot, 0), 0, 'usd', 'due', v_next_start::timestamptz, v_membership.created_by
    )
    on conflict (client_membership_id, period_start, period_end) do nothing
    returning id into v_period_id;

    if v_period_id is null then
      select id into v_period_id from public.client_membership_periods
        where client_membership_id = v_membership.id
          and period_start = v_next_start and period_end = v_next_end;
    end if;

    v_current_start := v_next_start;
    v_current_end := v_next_end;
    v_advanced := true;
  end loop;

  if v_advanced then
    update public.client_memberships
      set current_period_start = v_current_start,
          current_period_end = v_current_end,
          updated_at = now()
      where id = v_membership.id;
  else
    select id into v_period_id from public.client_membership_periods
      where client_membership_id = v_membership.id
        and period_start = v_membership.current_period_start
        and period_end = v_membership.current_period_end;
  end if;

  return v_period_id;
end;
$$;

revoke all on function public._ensure_membership_period_for_date(uuid, date) from public, anon, authenticated, service_role;

-- ============================================================================
-- 4. Generic finite-balance helper (plan section G) -- the private-lesson
--    instantiation of the quantity/consumed/reserved/available shape,
--    composing sections D and F. p_exclude_appointment_id is the
--    self-exclusion parameter used by reschedule/update callers.
--
--    VOLATILE, deliberately -- not STABLE. Its result must reflect rows
--    already processed earlier in the SAME multi-row INSERT/UPDATE
--    statement (e.g. row 2 of a 3-row recurring-series insert must see
--    row 1's reservation already counted), which is exactly the case
--    STABLE is documented not to support: a STABLE function's internal
--    queries use the snapshot established at the start of the enclosing
--    statement and do not see that statement's own not-yet-this-query
--    changes, whereas a VOLATILE function's internal queries get a fresh
--    snapshot each invocation and do see them. This function performs
--    only SELECTs and has no side effects -- VOLATILE here reflects that
--    its result is not constant across a statement, not that it mutates
--    anything.
-- ============================================================================
create or replace function public._private_lesson_finite_balance(
  p_client_membership_id uuid,
  p_benefit_id uuid,
  p_target_date timestamptz,
  p_exclude_appointment_id uuid
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
    from public.appointments a
    where a.client_membership_id = p_client_membership_id
      and a.billing_type = 'membership'
      and a.appointment_type in ('private_lesson', 'intro_lesson', 'coaching')
      and a.status <> 'cancelled'
      and a.starts_at >= v_window.window_start and a.starts_at <= v_window.window_end
      and (p_exclude_appointment_id is null or a.id <> p_exclude_appointment_id)
      and not exists (
        select 1 from public.client_membership_usage cmu
        where cmu.reference_type = 'appointment' and cmu.reference_id = a.id
          and cmu.membership_plan_benefit_id = p_benefit_id
      );

  return query select p_benefit_id, p_client_membership_id, v_window.window_start, v_window.window_end,
    v_quantity, v_consumed, v_reserved, (v_quantity - v_consumed - v_reserved);
end;
$$;

revoke all on function public._private_lesson_finite_balance(uuid, uuid, timestamptz, uuid) from public, anon, authenticated, service_role;

commit;
