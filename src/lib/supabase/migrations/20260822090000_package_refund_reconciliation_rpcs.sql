-- Package Refund P0, Slice 2c-1: refund-object-driven reconciliation.
--
-- This is where a successful Stripe refund starts producing package-credit
-- consequences. Two new functions, both additive (no existing function is
-- modified):
--
--   1. get_client_package_refund_financial_state(...) -- the single, shared
--      money-only classification rule (price vs. cumulative succeeded
--      refunds). Both this migration's RPC and the later staff-review RPC
--      (Slice 2c-2) call this same function so the two can never drift
--      against each other -- centralized specifically because duplicating
--      this logic is what produces exactly the class of bug ("unknown
--      price treated as full") that a shared, single decision rule
--      structurally cannot have.
--
--   2. reconcile_package_stripe_refund(...) -- webhook-invoked (service_role
--      only). Idempotent on stripe_refund_id; applies Case A/B (full
--      refund -- void remaining finite credits, never touch quantity_used/
--      quantity_total, never touch already-consumed history) or Case C
--      (any partial, or unknown price -- zero credit mutation,
--      pending_review, staff must decide) per the approved Package Refund
--      P0 design. See the Slice 2c architecture plan for the full Case
--      A/B/C rationale, the exact locking algorithm, and the identity-
--      safety reasoning below.
--
-- Neither function touches the attendance trigger, fulfill_terminal_payment,
-- package_sales, or any existing function. No schema changes -- confirmed
-- sufficient by direct audit: client_package_items has no constraint
-- requiring quantity_used+quantity_remaining=quantity_total, and
-- lesson_transactions.transaction_type already has unused 'refund'/
-- 'restored_lesson' enum values laid down for exactly this purpose.

begin;

-- ============================================================================
-- 1. get_client_package_refund_financial_state
-- ============================================================================
-- Pure read against already-locked state (callers hold a `for update` lock
-- on the client_packages row before calling this -- this function takes no
-- lock of its own). Price authority: client_packages.sold_price, falling
-- back to price_snapshot -- an existing codebase convention (see
-- src/lib/aria/danceGoalInsights.ts), not invented here. Price null/<=0 is
-- its own 'unknown' classification, never coalesced to 0 and compared --
-- that coalesce-to-0 pattern is exactly the bug this centralization exists
-- to make structurally impossible.
create function public.get_client_package_refund_financial_state(
  p_client_package_id uuid,
  p_studio_id uuid
)
returns table(
  price_known boolean,
  price_cents integer,
  refunded_cents integer,
  classification text  -- 'unknown' | 'none' | 'partial' | 'full'
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price numeric;
  v_price_cents integer;
  v_refunded_cents integer;
begin
  select coalesce(sold_price, price_snapshot)
    into v_price
  from public.client_packages
  where id = p_client_package_id
    and studio_id = p_studio_id;

  if not found then
    raise exception 'Package not found for this studio.';
  end if;

  select coalesce(sum(refund_amount_cents), 0)
    into v_refunded_cents
  from public.package_refund_reconciliations
  where client_package_id = p_client_package_id
    and refund_status = 'succeeded'
    and reconciliation_outcome <> 'reversed';

  if v_price is null or v_price <= 0 then
    return query select false, null::integer, v_refunded_cents, 'unknown'::text;
    return;
  end if;

  v_price_cents := round(v_price * 100)::integer;

  return query
    select
      true,
      v_price_cents,
      v_refunded_cents,
      case
        when v_refunded_cents = 0 then 'none'
        when v_refunded_cents >= v_price_cents then 'full'
        else 'partial'
      end;
end;
$$;

revoke all on function public.get_client_package_refund_financial_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_client_package_refund_financial_state(uuid, uuid)
  to service_role;

-- ============================================================================
-- 2. reconcile_package_stripe_refund
-- ============================================================================
-- Identity surface is deliberately minimal: only p_studio_id (a scope
-- assertion) and p_payment_id (the one fact the webhook genuinely knows
-- firsthand) are trusted from the caller. client_id and client_package_id
-- are derived from the authoritative payments/client_packages rows and
-- independently re-verified against studio scope inside this function --
-- never assumed correct because the caller resolved them upstream.
--
-- Locking order: the payments row is read-only here (never mutated by this
-- function, and client_package_id is effectively immutable post-creation in
-- this codebase), so no lock is taken on it. The client_packages row
-- derived from that payment -- never a caller-supplied one -- is locked
-- with `for update` immediately after being proven to belong to the
-- expected studio. That lock is the single serialization authority for
-- every refund-consequence operation on this package (this function, the
-- Slice 2c-2 staff-review RPC, and the later reversal RPC all begin with
-- the identical step against the identical row).
create function public.reconcile_package_stripe_refund(
  p_studio_id uuid,
  p_payment_id uuid,
  p_stripe_refund_id text,
  p_stripe_charge_id text,
  p_refund_amount_cents integer,
  p_refund_status text,
  p_occurred_at timestamptz default now()
)
returns table(
  reconciliation_id uuid,
  outcome text,
  applied boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment public.payments%rowtype;
  v_pkg_id uuid;
  v_derived_client_id uuid;
  v_reconciliation_id uuid;
  v_refund_status text;
  v_outcome_before text;
  v_should_apply boolean;
  v_classification text;
  v_has_usage boolean;
  v_item record;
  v_final_outcome text;
begin
  -- Step 0: resolve and validate the payment.
  select * into v_payment
  from public.payments
  where id = p_payment_id
    and studio_id = p_studio_id;

  if not found then
    raise exception 'Payment not found for the given studio.';
  end if;

  if v_payment.client_package_id is null then
    -- Not every refund is package-related. Nothing further to do.
    reconciliation_id := null;
    outcome := 'not_package_related';
    applied := false;
    return next;
    return;
  end if;

  -- Step 1: lock the DERIVED package (never caller-supplied), re-verify
  -- studio scope directly against it.
  select id, client_id
    into v_pkg_id, v_derived_client_id
  from public.client_packages
  where id = v_payment.client_package_id
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Package referenced by this payment was not found for this studio.';
  end if;

  -- Belt-and-suspenders data-integrity check -- not identity-spoofing
  -- defense (client_id is never trusted as an independent input at all),
  -- but a refusal to silently proceed on a genuinely inconsistent
  -- payment/package pairing.
  if v_payment.client_id is not null and v_payment.client_id <> v_derived_client_id then
    raise exception 'Payment client does not match the linked package''s client.';
  end if;

  -- Step 2: identity-safe idempotent upsert. The WHERE clause on the DO
  -- UPDATE branch means a colliding stripe_refund_id tied to a DIFFERENT
  -- payment/package leaves the existing row completely untouched --
  -- RETURNING then yields zero rows, checked explicitly below and turned
  -- into a hard failure. Identity columns (studio_id, client_id,
  -- client_package_id, payment_id) are never written by the SET list on
  -- any path -- identity cannot drift via redelivery.
  insert into public.package_refund_reconciliations (
    studio_id, client_id, client_package_id, payment_id,
    stripe_refund_id, stripe_charge_id, refund_amount_cents, refund_status
  ) values (
    p_studio_id, v_derived_client_id, v_pkg_id, p_payment_id,
    p_stripe_refund_id, p_stripe_charge_id, p_refund_amount_cents, p_refund_status
  )
  on conflict (stripe_refund_id) do update
    set refund_status = case
          when public.package_refund_reconciliations.reconciliation_outcome = 'not_yet_effective'
            then excluded.refund_status
          -- Frozen once applied: a Stripe refund's status is terminal once
          -- 'succeeded' (never regresses to failed/canceled). Freezing
          -- here is zero-cost belt-and-suspenders even so -- if that were
          -- ever wrong, this row stays consistent with what was actually
          -- mutated rather than silently desyncing the aggregate from it.
          else public.package_refund_reconciliations.refund_status
        end,
        stripe_charge_id = coalesce(excluded.stripe_charge_id, public.package_refund_reconciliations.stripe_charge_id),
        updated_at = now()
    where public.package_refund_reconciliations.studio_id = p_studio_id
      and public.package_refund_reconciliations.client_id = v_derived_client_id
      and public.package_refund_reconciliations.client_package_id = v_pkg_id
      and public.package_refund_reconciliations.payment_id = p_payment_id
  returning id, refund_status, reconciliation_outcome
    into v_reconciliation_id, v_refund_status, v_outcome_before;

  if not found then
    raise exception 'stripe_refund_id % is already associated with a different payment or package.',
      p_stripe_refund_id;
  end if;

  -- Step 3: transition gate. Application fires exactly once, only on the
  -- row's own first transition into refund_status='succeeded'.
  v_should_apply := (v_outcome_before = 'not_yet_effective' and v_refund_status = 'succeeded');

  if not v_should_apply then
    reconciliation_id := v_reconciliation_id;
    outcome := v_outcome_before;
    applied := false;
    return next;
    return;
  end if;

  -- Step 4: classify (single shared decision rule) and apply, still under
  -- the Step 1 package lock.
  select gs.classification into v_classification
  from public.get_client_package_refund_financial_state(v_pkg_id, p_studio_id) gs;

  if v_classification = 'full' then
    -- Case A vs. Case B: has this package ever had genuine consumed usage?
    -- 'lesson_deduction' is the only transaction_type actually written for
    -- real consumption (both attendance and a policy-charged no-show route
    -- through the same deduct_package_credit_for_appointment RPC, which
    -- only ever writes this value) -- manual_adjustment/manual_credit/
    -- manual_debit are administrative corrections, not consumption, and
    -- are deliberately excluded from this test.
    select exists (
      select 1 from public.lesson_transactions
      where client_package_id = v_pkg_id
        and transaction_type::text = 'lesson_deduction'
    ) into v_has_usage;

    for v_item in
      select id, quantity_remaining
      from public.client_package_items
      where client_package_id = v_pkg_id
        and is_unlimited = false
        and quantity_remaining > 0
      for update
    loop
      update public.client_package_items
      set quantity_remaining = quantity_remaining - v_item.quantity_remaining,
          updated_at = now()
      where id = v_item.id;
      -- quantity_used, quantity_total: never written here, on any path.

      insert into public.lesson_transactions (
        studio_id, client_id, client_package_id, client_package_item_id,
        refund_reconciliation_id, transaction_type, lessons_delta,
        balance_after, notes
      ) values (
        p_studio_id, v_derived_client_id, v_pkg_id, v_item.id,
        v_reconciliation_id, 'refund', -v_item.quantity_remaining,
        0, 'Package credit voided due to full Stripe refund.'
      );
    end loop;
    -- Unlimited items: no numeric mutation, no ledger row -- the
    -- package-level active=false block below already makes the
    -- entitlement unusable.

    update public.client_packages
    set refund_status = 'full',
        refunded_at = coalesce(p_occurred_at, now()),
        active = false,
        updated_at = now()
    where id = v_pkg_id;

    v_final_outcome := 'auto_applied';

    update public.package_refund_reconciliations
    set reconciliation_outcome = v_final_outcome,
        review_reason = case
          when v_has_usage then
            'Package had recorded usage before this full refund -- review for informational purposes.'
          else null
        end,
        updated_at = now()
    where id = v_reconciliation_id;

    -- Stale pending_review supersession: any OTHER unresolved partial-
    -- review row for this same package is now moot -- the entitlement it
    -- might have addressed no longer exists. reviewed_by/reviewed_at are
    -- deliberately left null (never set here) -- that null is the
    -- structural, queryable proof this was not a staff decision, distinct
    -- from a genuine decline (which does set them). Financial history
    -- (refund_amount_cents, refund_status, stripe_refund_id) is untouched.
    update public.package_refund_reconciliations
    set reconciliation_outcome = 'no_action_needed',
        review_reason = 'Superseded by cumulative full refund (reconciliation ' || v_reconciliation_id || ').',
        updated_at = now()
    where client_package_id = v_pkg_id
      and reconciliation_outcome = 'pending_review'
      and id <> v_reconciliation_id;

  elsif v_classification in ('partial', 'unknown') then
    -- Case C: zero credit mutation. active is deliberately left untouched.
    update public.client_packages
    set refund_status = 'partial',
        refunded_at = coalesce(p_occurred_at, now()),
        updated_at = now()
    where id = v_pkg_id;

    v_final_outcome := 'pending_review';

    update public.package_refund_reconciliations
    set reconciliation_outcome = v_final_outcome,
        review_reason = case
          when v_classification = 'unknown' then
            'Package sale price could not be determined (sold_price and price_snapshot both unset) -- staff review required.'
          else null
        end,
        updated_at = now()
    where id = v_reconciliation_id;

  else
    -- 'none' -- structurally unreachable here (this row's own succeeded,
    -- positive refund_amount_cents was just upserted in Step 2 and is
    -- visible to this same transaction's aggregate read above), but
    -- handled explicitly rather than assumed impossible.
    v_final_outcome := 'pending_review';

    update public.package_refund_reconciliations
    set reconciliation_outcome = v_final_outcome,
        review_reason = 'Unexpected zero-refund aggregate at application time -- flagged for review.',
        updated_at = now()
    where id = v_reconciliation_id;
  end if;

  reconciliation_id := v_reconciliation_id;
  outcome := v_final_outcome;
  applied := true;
  return next;
end;
$$;

revoke all on function public.reconcile_package_stripe_refund(uuid, uuid, text, text, integer, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_package_stripe_refund(uuid, uuid, text, text, integer, text, timestamptz)
  to service_role;

commit;
