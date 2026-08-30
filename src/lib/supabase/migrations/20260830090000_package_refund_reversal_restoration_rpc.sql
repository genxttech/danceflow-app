-- Package Refund P0, Slice 2c-3: Stripe refund reversal restoration.
--
-- Closes the last correctness gap in the Package Refund P0 release unit: a
-- Stripe refund that succeeded and voided package credit (via 2c-1's
-- reconcile_package_stripe_refund or 2c-2's resolve_partial_refund_credit_review),
-- then later fails/cancels -- a real, documented Stripe behavior for
-- ACH/bank-debit refunds that fail after initially appearing to succeed --
-- must restore exactly what it voided. Today that reversal event is a
-- complete, silent no-op: reconcile_package_stripe_refund's own upsert
-- freezes refund_status once reconciliation_outcome has moved past
-- 'not_yet_effective', so a later 'failed'/'canceled' delivery updates
-- nothing. This migration is purely additive -- it does not modify
-- reconcile_package_stripe_refund or resolve_partial_refund_credit_review.
--
-- Restoration source of truth: lesson_transactions rows with
-- transaction_type = 'refund' and a matching refund_reconciliation_id are
-- the ONLY input to how much is restored -- never quantity_remaining, which
-- may have moved for unrelated reasons (usage, manual correction, balance
-- adjustment) since the void. Both existing voiding RPCs write at most one
-- 'refund' row per (reconciliation_id, item_id) pair, confirmed by reading
-- both write loops directly -- so this per-item sum is already exact
-- without any additional schema.
--
-- No schema change: 'restored_lesson' (transaction_type) and 'reversed'
-- (reconciliation_outcome) were both already present, unused, laid down in
-- the 2c-1/2c-2 migrations specifically for this slice.
--
-- Lock order: client_packages (for update) -> package_refund_reconciliations
-- (re-read fresh, for update, under that lock) -> client_package_items (for
-- update, ascending client_package_item_id order) -- identical to
-- resolve_partial_refund_credit_review's own order, the same single
-- serialization authority every refund-consequence writer in this
-- subsystem shares. Never touches appointments -- fully compatible with
-- the appointments -> client_packages -> client_package_items DAG already
-- established for attendance-triggered operations.

begin;

create function public.restore_package_refund_reconciliation(
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
      -- longer true once reversed. active is the one field that can
      -- collide with an unrelated, independently-made staff decision:
      -- archiveClientPackageAction (src/app/app/clients/[id]/actions.ts)
      -- sets active=false with no guard against an already-fully-refunded
      -- package, so a package can be BOTH refund-voided and separately
      -- archived. Reactivating on reversal must never override that --
      -- archived_at/archived_by/archive_reason are read here (never
      -- written) as the sole authority: only flip active back to true
      -- when the package is not currently archived. The CASE and the
      -- RETURNING clause both evaluate against this UPDATE's own pre-image
      -- row, so this is one atomic, race-free read-and-conditionally-write.
      update public.client_packages
      set refund_status = null,
          active = case when archived_at is null then true else active end,
          updated_at = now()
      where id = v_pkg_id
      returning archived_at is not null into v_was_archived;

      if v_was_archived then
        -- Explicitly NOT a staff-review requirement -- purely an
        -- informational breadcrumb, matching the sibling-reconciliation
        -- case above.
        v_status_note := v_status_note
          || ' Package remains archived -- active left unchanged (refund_status still cleared).';
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
