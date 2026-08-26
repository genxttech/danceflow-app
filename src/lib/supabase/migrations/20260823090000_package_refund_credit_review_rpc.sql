-- Package Refund P0, Slice 2c-2: staff review resolution for partial/unknown-
-- price Stripe refunds. Slice 2c-1's reconcile_package_stripe_refund leaves a
-- Case C reconciliation row at reconciliation_outcome='pending_review' with
-- zero credit mutation -- this is the RPC that resolves it.
--
-- Identity surface is minimized, matching 2c-1's own reconcile_package_stripe_refund:
-- only p_studio_id (scope), p_reconciliation_id (the row being resolved), and
-- p_reviewer_id (the acting staff member) are trusted from the caller. Package
-- and client identity are derived from the reconciliation row itself, never
-- passed separately.
--
-- Locking order (see the review's own correction history for why this exact
-- order matters): an initial, NON-authoritative lookup on the reconciliation
-- row discovers which client_packages row to lock. Once that package lock is
-- held -- the same lock reconcile_package_stripe_refund takes, and the sole
-- serialization authority for every refund-consequence operation on a
-- package -- the reconciliation row is re-read (and itself locked) fresh.
-- Every decision below is made from that second, lock-protected read, never
-- the initial lookup: a concurrent resolution that already committed while
-- this call was blocked on the package lock is therefore always visible
-- before this call decides whether it is still actionable.
--
-- Item-row locking: a fresh audit of every live writer of
-- client_package_items.quantity_remaining found that the package-level lock
-- alone does not serialize against every writer -- 2c-1's own RPC and
-- deduct_package_credit_for_appointment both additionally take `for update`
-- on the specific item row(s) they touch. This RPC follows the identical,
-- already-established pattern: each referenced item row is locked
-- individually (in ascending id order, a deterministic and defensive
-- convention against any hypothetical future multi-item locker) immediately
-- before its balance is read and validated.
--
-- p_voids contract: '[]'::jsonb means an explicit staff decision to decline
-- (apply zero credit voids); NULL is rejected outright, not treated as a
-- decline -- the UI's own explicit Decline control always sends '[]', so a
-- caller omitting p_voids entirely is far more likely to be an integration
-- bug than a real human decision, and this RPC must not record
-- reviewed_by/reviewed_at against a decision nobody actually made.

begin;

create function public.resolve_partial_refund_credit_review(
  p_studio_id uuid,
  p_reconciliation_id uuid,
  p_reviewer_id uuid,
  p_voids jsonb,
  p_reviewer_notes text default null
)
returns table(
  reconciliation_id uuid,
  outcome text,
  voided_item_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg_id_lookup uuid;
  v_locked_pkg_id uuid;
  v_pkg_id uuid;
  v_client_id uuid;
  v_outcome text;
  v_classification text;
  v_element jsonb;
  v_item_id_text text;
  v_quantity_text text;
  v_item_id uuid;
  v_quantity integer;
  v_item_ids uuid[] := '{}';
  v_quantities integer[] := '{}';
  v_pair record;
  v_item_remaining integer;
  v_item_unlimited boolean;
  v_voided_count integer := 0;
  v_final_outcome text;
begin
  -- Step 0: reviewer authorization. Independent of, and re-proven regardless
  -- of, whatever the calling server action already checked. Mirrors
  -- deduct_package_credit_for_appointment's own established pattern
  -- (20260809120000): a real platform admin is identified by
  -- profiles.platform_role, the same global flag getCurrentStudioContext's
  -- isPlatformAdmin() checks and every server-action-level role gate in this
  -- codebase bypasses on -- not merely a per-studio user_studio_roles row,
  -- which a platform admin need not hold for every studio. front_desk is
  -- excluded by construction, matching both this table's own read RLS
  -- (20260817090100) and refundClientPaymentAction's canIssuePaymentRefunds
  -- gate.
  if not exists (
    select 1 from public.profiles
    where id = p_reviewer_id
      and platform_role = 'platform_admin'
  ) and not exists (
    select 1 from public.user_studio_roles
    where user_id = p_reviewer_id
      and studio_id = p_studio_id
      and active = true
      and role in ('studio_owner', 'studio_admin')
  ) then
    raise exception 'Reviewer is not authorized to resolve package refund reviews for this studio.';
  end if;

  -- Step 1: discover the package id only. NOT authoritative for any later
  -- decision -- its sole purpose is knowing which row to lock next.
  select client_package_id into v_pkg_id_lookup
  from public.package_refund_reconciliations
  where id = p_reconciliation_id
    and studio_id = p_studio_id;

  if not found then
    raise exception 'Reconciliation not found for this studio.';
  end if;

  -- Step 2: acquire the package lock -- the serialization authority shared
  -- with reconcile_package_stripe_refund.
  select id into v_locked_pkg_id
  from public.client_packages
  where id = v_pkg_id_lookup
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Package not found for this studio.';
  end if;

  -- Step 3: re-read the reconciliation row fresh, under the lock, and lock
  -- it too. Every other function capable of mutating this row acquires the
  -- same package lock first, so this read can only observe already-
  -- committed state, never a concurrently in-flight one.
  select client_package_id, client_id, reconciliation_outcome
    into v_pkg_id, v_client_id, v_outcome
  from public.package_refund_reconciliations
  where id = p_reconciliation_id
  for update;

  if not found then
    raise exception 'Reconciliation not found.';
  end if;
  if v_pkg_id <> v_locked_pkg_id then
    raise exception 'Reconciliation package does not match the locked package.';
  end if;
  if v_outcome <> 'pending_review' then
    raise exception 'Reconciliation % is not pending review (current outcome: %).',
      p_reconciliation_id, v_outcome;
  end if;

  -- Step 4: fail-closed already-full guard, via the single shared
  -- classification helper (2c-1's, reused not reimplemented) -- 'unknown'
  -- must never be misread as 'full'.
  select gs.classification into v_classification
  from public.get_client_package_refund_financial_state(v_pkg_id, p_studio_id) gs;

  if v_classification = 'full' then
    raise exception 'This package has already reached a full refund; this review is no longer actionable.';
  end if;

  -- Step 5: validate p_voids. Pure, no DB access -- entirely before Step 7's
  -- first lock/mutation runs, so a malformed or duplicate entry anywhere in
  -- the array is caught before any update statement executes.
  if p_voids is null then
    raise exception 'p_voids must be provided -- pass an empty array to explicitly decline.';
  end if;
  if jsonb_typeof(p_voids) <> 'array' then
    raise exception 'p_voids must be a JSON array.';
  end if;

  for v_element in select * from jsonb_array_elements(p_voids)
  loop
    if jsonb_typeof(v_element) <> 'object' then
      raise exception 'Each void entry must be a JSON object.';
    end if;

    v_item_id_text := v_element->>'client_package_item_id';
    if v_item_id_text is null
      or v_item_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception 'client_package_item_id must be a valid UUID.';
    end if;

    v_quantity_text := v_element->>'quantity';
    if v_quantity_text is null or v_quantity_text !~ '^[1-9][0-9]*$' then
      raise exception 'quantity must be a positive integer.';
    end if;

    v_item_id := v_item_id_text::uuid;
    v_quantity := v_quantity_text::integer;

    if v_item_id = any(v_item_ids) then
      raise exception 'Duplicate client_package_item_id in void payload: an item cannot be voided by more than one entry.';
    end if;

    v_item_ids := array_append(v_item_ids, v_item_id);
    v_quantities := array_append(v_quantities, v_quantity);
  end loop;

  -- Step 6: decline path. Reachable only when p_voids is a real, empty
  -- array -- never via NULL (rejected above).
  if array_length(v_item_ids, 1) is null then
    update public.package_refund_reconciliations
    set reconciliation_outcome = 'no_action_needed',
        reviewed_by = p_reviewer_id,
        reviewed_at = now(),
        review_reason = coalesce(p_reviewer_notes, review_reason),
        updated_at = now()
    where id = p_reconciliation_id;

    reconciliation_id := p_reconciliation_id;
    outcome := 'no_action_needed';
    voided_item_count := 0;
    return next;
    return;
  end if;

  -- Step 7: item-row locking and mutation, in deterministic (ascending
  -- item_id) order. quantity_remaining is read fresh here, under this lock
  -- -- never from any value validated before it, and never from any
  -- client-cached value the UI might have held since the panel was opened.
  for v_pair in
    select item_id, quantity
    from unnest(v_item_ids, v_quantities) as t(item_id, quantity)
    order by item_id
  loop
    select quantity_remaining, is_unlimited
      into v_item_remaining, v_item_unlimited
    from public.client_package_items
    where id = v_pair.item_id
      and client_package_id = v_pkg_id
    for update;

    if not found then
      raise exception 'Package item % does not belong to this reconciliation''s package.', v_pair.item_id;
    end if;
    if v_item_unlimited then
      raise exception 'Cannot void credits on an unlimited package item.';
    end if;
    if v_pair.quantity > v_item_remaining then
      raise exception 'Void quantity for package item % exceeds its current remaining balance.', v_pair.item_id;
    end if;

    update public.client_package_items
    set quantity_remaining = quantity_remaining - v_pair.quantity,
        updated_at = now()
    where id = v_pair.item_id;
    -- quantity_used, quantity_total: never written here, matching
    -- reconcile_package_stripe_refund's identical voiding rule.

    insert into public.lesson_transactions (
      studio_id, client_id, client_package_id, client_package_item_id,
      refund_reconciliation_id, transaction_type, lessons_delta,
      balance_after, notes, created_by
    ) values (
      p_studio_id, v_client_id, v_pkg_id, v_pair.item_id,
      p_reconciliation_id, 'refund', -v_pair.quantity,
      v_item_remaining - v_pair.quantity,
      'Package credit voided by staff review of a partial refund.',
      p_reviewer_id
    );

    v_voided_count := v_voided_count + 1;
  end loop;

  -- Step 8: close out the reconciliation row atomically, in the same
  -- transaction as Step 7's mutations. reviewed_by/reviewed_at are set here,
  -- never without reconciliation_outcome also leaving pending_review in this
  -- same statement -- this is what keeps the stale-review-supersession
  -- sweep's reviewed_by IS NULL proof valid: exactly two code paths ever
  -- move a row away from pending_review (this one, and that sweep), and
  -- only this one ever sets these two columns.
  --
  -- client_packages.refund_status/refunded_at/active are deliberately never
  -- written here -- financial classification is derived exclusively from
  -- money (get_client_package_refund_financial_state's own aggregate),
  -- never from credit-voiding decisions. Only a later, independent Stripe
  -- refund event, processed through reconcile_package_stripe_refund, can
  -- change refund_status.
  update public.package_refund_reconciliations
  set reconciliation_outcome = 'staff_applied',
      reviewed_by = p_reviewer_id,
      reviewed_at = now(),
      review_reason = coalesce(p_reviewer_notes, review_reason),
      updated_at = now()
  where id = p_reconciliation_id;

  reconciliation_id := p_reconciliation_id;
  outcome := 'staff_applied';
  voided_item_count := v_voided_count;
  return next;
end;
$$;

revoke all on function public.resolve_partial_refund_credit_review(uuid, uuid, uuid, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.resolve_partial_refund_credit_review(uuid, uuid, uuid, jsonb, text)
  to service_role;

commit;
