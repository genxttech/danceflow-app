-- Package Refund P0, Slice 2c-2 (prerequisite hardening, not a Case A/B/C
-- change): while auditing item-row locking for
-- resolve_partial_refund_credit_review, every live writer of
-- client_package_items.quantity_remaining was traced. Two already-shipped
-- features write it with no row locking at all -- a plain client-side
-- read-then-compute-then-.update() sequence, safe against sequential
-- replay but not against a genuinely concurrent mutation of the same item
-- row (including this slice's own new review RPC):
--
--   - adjustLessonCountCorrectionAction (src/app/app/clients/[id]/actions.ts)
--   - createBalanceAdjustmentAction (src/app/app/packages/adjustments/actions.ts)
--
-- Both are converted here to a single, package-then-item-row-locked RPC
-- call each. This is a concurrency-hardening refactor only -- every
-- existing validation rule, error condition, numeric type (integer for the
-- first, fractional-permitting numeric for the second -- deliberately NOT
-- unified, since that is each feature's own existing, unchanged behavior),
-- and ledger note format is preserved exactly. Neither feature's
-- authorization model, product behavior, or UI changes.
--
-- Locking order (package, then item) was proven necessary, not just
-- defensive, by real two-session concurrency testing: both RPCs insert into
-- lesson_transactions, whose client_package_id column is a foreign key --
-- Postgres implicitly requests a FOR KEY SHARE lock on the referenced
-- client_packages row for that insert. A first draft that locked only the
-- item row (matching deduct_package_credit_for_appointment's existing,
-- narrower shape) produced a genuine, reproducible deadlock against
-- resolve_partial_refund_credit_review specifically: that RPC locks the
-- package first and then blocks on the item row, while an item-lock-only
-- writer already holding the item row would then block on the same
-- package row via its own lesson_transactions insert -- a real lock cycle,
-- not merely a theoretical one. Locking the package first here closes it by
-- construction, matching resolve_partial_refund_credit_review's and
-- reconcile_package_stripe_refund's own order.
--
-- After this migration, every live writer of an existing package-item
-- balance (this pair, resolve_partial_refund_credit_review,
-- reconcile_package_stripe_refund, deduct_package_credit_for_appointment,
-- and the attendance trigger) takes `for update` on the specific item row
-- before reading/mutating it.

begin;

-- ============================================================================
-- 1. apply_package_item_manual_correction -- backs adjustLessonCountCorrectionAction
-- ============================================================================
create function public.apply_package_item_manual_correction(
  p_studio_id uuid,
  p_client_id uuid,
  p_package_item_id uuid,
  p_correction_type text,
  p_quantity integer,
  p_reason text,
  p_created_by uuid
)
returns table(
  new_quantity_total integer,
  new_quantity_used integer,
  new_quantity_remaining integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg_id_lookup uuid;
  v_locked_pkg_id uuid;
  v_item record;
  v_package_name text;
  v_next_total integer;
  v_next_used integer;
  v_next_remaining integer;
  v_delta integer;
  v_direction_label text;
  v_is_singular boolean;
  v_unit_label text;
  v_notes text;
begin
  if p_correction_type not in ('add', 'debit') then
    raise exception 'Invalid correction type.';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than 0.';
  end if;

  -- Ownership (studio + client, via the package) verified by this initial,
  -- NON-authoritative lookup -- its sole purpose is discovering which
  -- client_packages row to lock next. This RPC inserts into
  -- lesson_transactions (client_package_id is a foreign key), which
  -- implicitly requests a FOR KEY SHARE lock on the parent client_packages
  -- row -- taking client_packages FOR UPDATE first, before the item row,
  -- makes this RPC's lock order identical to resolve_partial_refund_credit_review's
  -- and reconcile_package_stripe_refund's (package, then item), eliminating
  -- the cross-RPC deadlock a package-lock-then-item-lock caller and an
  -- item-lock-only caller could otherwise form.
  select cpi.client_package_id into v_pkg_id_lookup
  from public.client_package_items cpi
  join public.client_packages cp on cp.id = cpi.client_package_id
  where cpi.id = p_package_item_id
    and cpi.studio_id = p_studio_id
    and cp.client_id = p_client_id;

  if not found then
    raise exception 'Package item not found for this client.';
  end if;

  select id into v_locked_pkg_id
  from public.client_packages
  where id = v_pkg_id_lookup
  for update;

  -- Re-read the item, authoritative this time, under the package lock.
  select id, usage_type, quantity_total, quantity_used, quantity_remaining,
         is_unlimited, client_package_id
    into v_item
  from public.client_package_items
  where id = p_package_item_id
    and client_package_id = v_locked_pkg_id
  for update;

  if not found then
    raise exception 'Package item not found for this client.';
  end if;
  if v_item.is_unlimited then
    raise exception 'Unlimited package items cannot be adjusted with quantity changes.';
  end if;

  if p_correction_type = 'add' then
    v_next_total := coalesce(v_item.quantity_total, 0) + p_quantity;
    v_next_used := v_item.quantity_used;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) + p_quantity;
    v_delta := p_quantity;
    v_direction_label := 'Added';
  else
    if coalesce(v_item.quantity_remaining, 0) - p_quantity < 0 then
      raise exception 'This adjustment would make the remaining balance negative.';
    end if;
    v_next_total := v_item.quantity_total;
    v_next_used := coalesce(v_item.quantity_used, 0) + p_quantity;
    v_next_remaining := coalesce(v_item.quantity_remaining, 0) - p_quantity;
    v_delta := -p_quantity;
    v_direction_label := 'Debited';
  end if;

  update public.client_package_items
  set quantity_total = v_next_total,
      quantity_used = v_next_used,
      quantity_remaining = v_next_remaining
  where id = v_item.id;

  select name_snapshot into v_package_name
  from public.client_packages
  where id = v_item.client_package_id;

  -- Direct SQL port of packageUsageUnitLabel
  -- (src/app/app/clients/[id]/actions.ts) -- same singular/plural strings
  -- per usage type, relocated (not reformatted) so the ledger write can be
  -- atomic with the balance write instead of a second, separately-racy
  -- client-side statement.
  v_is_singular := p_quantity = 1;
  v_unit_label := case
    when v_item.usage_type = 'private_lesson' then
      case when v_is_singular then 'private lesson credit' else 'private lesson credits' end
    when v_item.usage_type = 'group_class' then
      case when v_is_singular then 'group class credit' else 'group class credits' end
    when v_item.usage_type = 'practice_party' then
      case when v_is_singular then 'practice party credit' else 'practice party credits' end
    else
      case when v_is_singular then 'package credit' else 'package credits' end
  end;

  v_notes := v_direction_label || ' ' || p_quantity || ' ' || v_unit_label || ' for '
    || coalesce(v_package_name, 'Package') || '. Reason: ' || p_reason;

  insert into public.lesson_transactions (
    studio_id, client_id, client_package_id, transaction_type,
    lessons_delta, balance_after, notes, created_by
  ) values (
    p_studio_id, p_client_id, v_item.client_package_id, 'manual_adjustment',
    v_delta, v_next_remaining, v_notes, p_created_by
  );

  new_quantity_total := v_next_total;
  new_quantity_used := v_next_used;
  new_quantity_remaining := v_next_remaining;
  return next;
end;
$$;

revoke all on function public.apply_package_item_manual_correction(uuid, uuid, uuid, text, integer, text, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_package_item_manual_correction(uuid, uuid, uuid, text, integer, text, uuid)
  to service_role;

-- ============================================================================
-- 2. apply_package_balance_adjustment -- backs createBalanceAdjustmentAction
-- ============================================================================
create function public.apply_package_balance_adjustment(
  p_studio_id uuid,
  p_client_package_id uuid,
  p_usage_type text,
  p_adjustment_type text,
  p_quantity numeric,
  p_notes text,
  p_created_by uuid
)
returns table(
  new_quantity_total numeric,
  new_quantity_used numeric,
  new_quantity_remaining numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pkg record;
  v_item record;
  v_delta numeric;
  v_next_total numeric;
  v_next_used numeric;
  v_next_remaining numeric;
  v_transaction_type text;
begin
  if p_adjustment_type not in ('add', 'remove') then
    raise exception 'Invalid adjustment type.';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Quantity must be greater than 0.';
  end if;

  -- Package locked first, before the item row: this RPC inserts into
  -- lesson_transactions (client_package_id is a foreign key), which
  -- implicitly requests a FOR KEY SHARE lock on the parent client_packages
  -- row -- taking client_packages FOR UPDATE first makes this RPC's lock
  -- order identical to resolve_partial_refund_credit_review's and
  -- reconcile_package_stripe_refund's (package, then item), eliminating the
  -- cross-RPC deadlock a package-lock-then-item-lock caller and an
  -- item-lock-only caller could otherwise form.
  select id, client_id into v_pkg
  from public.client_packages
  where id = p_client_package_id
    and studio_id = p_studio_id
  for update;

  if not found then
    raise exception 'Client package lookup failed: package not found.';
  end if;

  -- for update mirrors deduct_package_credit_for_appointment's own
  -- established item-row-locking convention -- replaces the existing
  -- action's unlocked SELECT.
  select id, quantity_total, quantity_used, quantity_remaining, is_unlimited
    into v_item
  from public.client_package_items
  where client_package_id = p_client_package_id
    and studio_id = p_studio_id
    and usage_type = p_usage_type::package_usage_type
  for update;

  if not found then
    raise exception 'Package item lookup failed: package item not found.';
  end if;
  if v_item.is_unlimited then
    raise exception 'Unlimited package items cannot be adjusted with quantity changes.';
  end if;

  v_delta := case when p_adjustment_type = 'add' then p_quantity else -p_quantity end;
  v_next_remaining := coalesce(v_item.quantity_remaining, 0) + v_delta;
  v_next_total := coalesce(v_item.quantity_total, 0) + v_delta;

  if v_next_remaining < 0 then
    raise exception 'This adjustment would make the remaining balance negative.';
  end if;
  if v_next_total < 0 then
    raise exception 'This adjustment would make the total balance negative.';
  end if;

  v_next_used := coalesce(v_item.quantity_used, 0);
  if v_next_used > v_next_total then
    v_next_used := v_next_total;
  end if;

  update public.client_package_items
  set quantity_total = v_next_total,
      quantity_used = v_next_used,
      quantity_remaining = v_next_remaining
  where id = v_item.id;

  v_transaction_type := case when p_adjustment_type = 'add' then 'manual_credit' else 'manual_debit' end;

  insert into public.lesson_transactions (
    studio_id, client_id, client_package_id, transaction_type,
    lessons_delta, balance_after, notes, created_by
  ) values (
    p_studio_id, v_pkg.client_id, v_pkg.id, v_transaction_type::transaction_type,
    v_delta, v_next_remaining, '[' || p_usage_type || '] ' || p_notes, p_created_by
  );

  new_quantity_total := v_next_total;
  new_quantity_used := v_next_used;
  new_quantity_remaining := v_next_remaining;
  return next;
end;
$$;

revoke all on function public.apply_package_balance_adjustment(uuid, uuid, text, text, numeric, text, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_package_balance_adjustment(uuid, uuid, text, text, numeric, text, uuid)
  to service_role;

commit;
