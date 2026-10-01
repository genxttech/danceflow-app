-- PKG-REFUND-1 (D2): Stripe refund reversal restoration against the CURRENT
-- schema and PKG-P1 settlement rules.
--
-- SUPERSEDES 20260830090000_package_refund_reversal_restoration_rpc.sql for
-- every environment. That historical file must NOT be applied: it was
-- written before PKG-P1 (20260913091100_pkgp1_package_payment_activation_integrity.sql)
-- and its Step 8 reactivates a package (active = true) after a full-refund
-- reversal without consulting payment settlement. Under PKG-P1 the
-- originating payment stays 'refunded' after a refund later fails/cancels,
-- so the historical body could reactivate a package that has no valid
-- settlement evidence. The historical file is left unchanged as history.
--
-- This migration creates public.restore_package_refund_reconciliation with
-- the historical algorithm (same signature, lock order, idempotency gate,
-- ledger-sourced exact restoration, fail-closed invariant checks, ACL), with
-- ONE behavioral change in the full-refund package-lifecycle step:
--   - package reactivation additionally requires
--     public._package_payment_settled(package) = true (the existing PKG-P1
--     settlement authority, reused -- not duplicated);
--   - when settlement is not confirmed, credits are still restored exactly
--     from the refund ledger, refund_status is still cleared, the
--     reconciliation is still closed as 'reversed', and the package stays
--     inactive with an explanatory review_reason breadcrumb. No override is
--     introduced.
--
-- Lock order (unchanged): client_packages -> package_refund_reconciliations
-- -> client_package_items, matching every package-credit writer (PKG-MUT-1).
-- create or replace is used so that an environment where the stale
-- historical function was ever applied converges to this body.
-- No schema, policy, trigger or data change.

begin;

create or replace function public.restore_package_refund_reconciliation(
  p_studio_id uuid,
  p_stripe_refund_id text,
  p_new_refund_status text,
  p_occurred_at timestamptz default now()
)
returns table(
  reconciliation_id uuid,
  outcome text,
  restored_item_count integer,
  applied boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg_id_lookup uuid;
  v_locked_pkg_id uuid;
  v_reconciliation_id uuid;
  v_pkg_id uuid;
  v_client_id uuid;
  v_outcome_before text;
  v_void_row record;
  v_item_remaining numeric;
  v_restore_qty numeric;
  v_new_remaining numeric;
  v_restored_count integer := 0;
  v_has_other_full_refund boolean;
  v_was_archived boolean;
  v_settled boolean;
  v_reactivated boolean;
  v_status_note text;
begin
  if p_new_refund_status not in ('failed', 'canceled') then
    raise exception 'restore_package_refund_reconciliation is only for a refund status of failed or canceled, got %.', p_new_refund_status;
  end if;

  -- Step 1: non-authoritative lookup -- discovers which package to lock,
  -- and which reconciliation row this refund maps to. Not found (studio
  -- mismatch, or a refund DanceFlow never reconciled at all) is a harmless
  -- no-op, not an exception: raising here would propagate to the webhook
  -- route's outer handler and fail the *entire* Stripe event, not just this
  -- refund -- the same webhook-safety posture reconcile_package_stripe_refund's
  -- own release-hold guard exists to protect.
  select id, client_package_id
    into v_reconciliation_id, v_pkg_id_lookup
  from public.package_refund_reconciliations
  where stripe_refund_id = p_stripe_refund_id
    and studio_id = p_studio_id;

  if not found then
    reconciliation_id := null;
    outcome := 'not_reconciled';
    restored_item_count := 0;
    applied := false;
    return next;
    return;
  end if;

  -- Step 2: lock the package -- the shared serialization authority every
  -- refund-consequence writer in this subsystem takes first.
  select id into v_locked_pkg_id
  from public.client_packages
  where id = v_pkg_id_lookup
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Package not found for this studio.';
  end if;

  -- Step 3: re-read the reconciliation row fresh, under the package lock,
  -- and lock it too -- identical pattern to resolve_partial_refund_credit_review's
  -- own Step 2->3. A concurrent reversal (or review, or another refund)
  -- that already committed while this call was blocked on the package lock
  -- is therefore always visible before this call decides anything.
  select client_package_id, client_id, reconciliation_outcome
    into v_pkg_id, v_client_id, v_outcome_before
  from public.package_refund_reconciliations
  where id = v_reconciliation_id
  for update;

  if not found or v_pkg_id <> v_locked_pkg_id then
    raise exception 'Reconciliation package does not match the locked package.';
  end if;

  -- Step 4: idempotency/eligibility gate, from this second, lock-protected
  -- read only -- never the Step 1 lookup.
  if v_outcome_before = 'reversed' then
    -- Duplicate/replayed reversal delivery. No-op.
    reconciliation_id := v_reconciliation_id;
    outcome := 'reversed';
    restored_item_count := 0;
    applied := false;
    return next;
    return;
  end if;

  if v_outcome_before not in ('auto_applied', 'staff_applied') then
    -- not_yet_effective / pending_review / no_action_needed: this
    -- reconciliation never produced a credit consequence. Nothing to
    -- restore.
    reconciliation_id := v_reconciliation_id;
    outcome := v_outcome_before;
    restored_item_count := 0;
    applied := false;
    return next;
    return;
  end if;

  -- Step 5/6/7: the authoritative void set, in ascending item-id order --
  -- the loop's own ORDER BY makes sequential per-row locking below already
  -- ascending order, matching the canonical protocol.
  for v_void_row in
    select client_package_item_id, lessons_delta
    from public.lesson_transactions
    where refund_reconciliation_id = v_reconciliation_id
      and transaction_type = 'refund'
    order by client_package_item_id
  loop
    select quantity_remaining
      into v_item_remaining
    from public.client_package_items
    where id = v_void_row.client_package_item_id
      and client_package_id = v_pkg_id
    for update;

    if not found then
      raise exception 'Package item % referenced by refund ledger row does not belong to this reconciliation''s package.',
        v_void_row.client_package_item_id;
    end if;

    -- lessons_delta was negative at void time; restore exactly its inverse.
    -- Never derived from v_item_remaining -- that value is read only to
    -- compute the additive result and balance_after, never to decide how
    -- much to restore.
    v_restore_qty := -v_void_row.lessons_delta;
    v_new_remaining := v_item_remaining + v_restore_qty;
    v_restored_count := v_restored_count + 1;

    -- quantity_used, quantity_total: never written here, matching the
    -- voiding RPCs' identical asymmetry. v_new_remaining may exceed
    -- quantity_total if an intervening manual correction shrank the item
    -- after the void -- deliberate: capping would silently discard part of
    -- an exact ledger-sourced restoration and make it depend on an
    -- unrelated later mutation. No CHECK constraint on client_package_items
    -- requires quantity_remaining <= quantity_total.
    update public.client_package_items
    set quantity_remaining = v_new_remaining,
        updated_at = now()
    where id = v_void_row.client_package_item_id;

    insert into public.lesson_transactions (
      studio_id, client_id, client_package_id, client_package_item_id,
      refund_reconciliation_id, transaction_type, lessons_delta,
      balance_after, notes, created_by
    ) values (
      p_studio_id, v_client_id, v_pkg_id, v_void_row.client_package_item_id,
      v_reconciliation_id, 'restored_lesson', v_restore_qty,
      v_new_remaining,
      'Package credit restored -- Stripe refund ' || p_stripe_refund_id || ' reversed (status: ' || p_new_refund_status || ').',
      null
    );
  end loop;

  -- Fail closed: auto_applied/staff_applied are only ever reached by
  -- actually voiding at least one item (both voiding RPCs always write at
  -- least one 'refund' ledger row before setting either outcome) -- zero
  -- rows here is an invariant violation, not a legitimate zero-restoration
  -- case. Protects the guarantee that no restoration entry (or lack
  -- thereof) can ever exist without a traceable originating void entry.
  if v_restored_count = 0 then
    raise exception 'Reconciliation % has outcome % but no originating refund ledger rows -- cannot restore.',
      v_reconciliation_id, v_outcome_before;
  end if;

  v_status_note := 'Reversed on ' || now()::text || ' (was ' || v_outcome_before || ') -- Stripe refund status changed to ' || p_new_refund_status || '.';

  -- Step 8: full-refund package-lifecycle restoration. staff_applied
  -- reconciliations never touched client_packages.refund_status/active
  -- (2c-2's own design -- financial classification is money-derived, never
  -- credit-voiding-derived), so there is nothing to restore there.
  if v_outcome_before = 'auto_applied' then
    select exists (
      select 1 from public.package_refund_reconciliations
      where client_package_id = v_pkg_id
        and reconciliation_outcome = 'auto_applied'
        and id <> v_reconciliation_id
    ) into v_has_other_full_refund;

    if v_has_other_full_refund then
      -- Another still-active full-refund reconciliation governs this
      -- package's full-refund state -- restore only THIS reconciliation's
      -- own items, never reactivate/clear state that belongs to the other
      -- one. Breadcrumb explains why reactivation was withheld.
      v_status_note := v_status_note
        || ' Package-level reactivation withheld: another full-refund reconciliation is still active on this package.';
    else
      -- refund_status is always cleared here -- it is exclusively this
      -- refund's own money-derived classification, unconditionally no
      -- longer true once reversed.
      --
      -- PKG-REFUND-1 (supersedes 20260830090000's Step 8): reactivation is
      -- gated by the CURRENT PKG-P1 settlement authority,
      -- public._package_payment_settled(), evaluated here under the package
      -- lock. A refund reversal restores credits from the refund ledger, but
      -- it is not settlement evidence: PKG-P1 leaves the originating payment
      -- 'refunded' (only a 'paid' row is CAS-updated), so a package whose
      -- payment basis is gone stays inactive until settlement is
      -- re-established through the existing PKG-P1 paths. active is also
      -- never flipped for an archived package (an independent staff or PKG-P1
      -- archive decision -- archived_at is read here, never written).
      v_settled := public._package_payment_settled(v_pkg_id);

      update public.client_packages
      set refund_status = null,
          active = case
            when archived_at is null and v_settled then true
            else active
          end,
          updated_at = now()
      where id = v_pkg_id
      returning archived_at is not null, (archived_at is null and v_settled)
        into v_was_archived, v_reactivated;

      if v_was_archived then
        v_status_note := v_status_note
          || ' Package remains archived -- active left unchanged (refund_status still cleared).';
      elsif not v_reactivated then
        v_status_note := v_status_note
          || ' Package not reactivated: payment settlement could not be confirmed (PKG-P1) -- credits restored, package left inactive.';
      end if;
    end if;
  end if;

  -- Step 9: close out the reconciliation row atomically, in the same
  -- transaction as the restorations above -- this single update is the
  -- idempotency gate a redelivered reversal event hits at Step 4.
  update public.package_refund_reconciliations
  set reconciliation_outcome = 'reversed',
      refund_status = p_new_refund_status,
      review_reason = v_status_note,
      updated_at = now()
  where id = v_reconciliation_id;

  reconciliation_id := v_reconciliation_id;
  outcome := 'reversed';
  restored_item_count := v_restored_count;
  applied := true;
  return next;
end;
$$;

revoke all on function public.restore_package_refund_reconciliation(uuid, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.restore_package_refund_reconciliation(uuid, text, text, timestamptz)
  to service_role;

commit;
