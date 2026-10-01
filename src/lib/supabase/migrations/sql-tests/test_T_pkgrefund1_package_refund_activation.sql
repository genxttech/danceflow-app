-- PKG-REFUND-1 -- package-refund reconciliation / review / reversal,
-- live-Postgres regression suite (the database half of the activated paths;
-- the webhook owner binding is covered by the TypeScript suites).
--
-- Proves: full-refund auto-void and its idempotent replay, partial-refund
-- pending_review with zero credit mutation, staff review resolution and its
-- authorization, studio scoping, the PKG-REFUND-1 reversal settlement gate
-- (a reversal reactivates a package only when PKG-P1's
-- _package_payment_settled confirms settlement; otherwise credits are
-- restored and the package stays inactive), reversal idempotency, the
-- refund-ledger unique index, the RPC ACLs, and that PKG-MUT-1 / GC1-2
-- behavior is intact. Entire script runs in one transaction and is rolled
-- back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER
-- 20260822090000, 20260823090000, 20261003090000 and 20260830100000 have
-- been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000f8XXXX

begin;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000f80001', 'PKG-REFUND-1 Harness Studio', 't-pkgrefund1-studio'),
  ('00000000-0000-0000-0000-000000f80002', 'PKG-REFUND-1 Other Studio', 't-pkgrefund1-other');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000f81001', 't-pkgrefund1-owner@example.test'),
  ('00000000-0000-0000-0000-000000f81002', 't-pkgrefund1-instructor@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000f81001', 't-pkgrefund1-owner@example.test', null),
  ('00000000-0000-0000-0000-000000f81002', 't-pkgrefund1-instructor@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000f81001', '00000000-0000-0000-0000-000000f80001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000f81002', '00000000-0000-0000-0000-000000f80001', 'instructor', true);

insert into public.clients (id, studio_id, first_name, last_name) values
  ('00000000-0000-0000-0000-000000f83001', '00000000-0000-0000-0000-000000f80001', 'Refund', 'Harness');

-- P1: full refund, payment still 'paid' (PKG-P1 settled) -> reversal may reactivate.
-- P2: partial refund -> pending_review -> staff review.
-- P4: full refund, payment then 'refunded' (as PKG-P1 records it) -> reversal must NOT reactivate.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, active, sold_price) values
  ('00000000-0000-0000-0000-000000f85001', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', 'Harness Full', true, 100),
  ('00000000-0000-0000-0000-000000f85002', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', 'Harness Partial', true, 100),
  ('00000000-0000-0000-0000-000000f85004', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', 'Harness Unsettled', true, 100);

insert into public.client_package_items (id, studio_id, client_package_id, usage_type, quantity_total, quantity_used, quantity_remaining, is_unlimited) values
  ('00000000-0000-0000-0000-000000f85101', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f85001', 'private_lesson', 10, 4, 6, false),
  ('00000000-0000-0000-0000-000000f85102', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f85001', 'practice_party', null, 0, null, true),
  ('00000000-0000-0000-0000-000000f85201', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f85002', 'private_lesson', 8, 0, 8, false),
  ('00000000-0000-0000-0000-000000f85401', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f85004', 'private_lesson', 5, 0, 5, false);

insert into public.payments (id, studio_id, client_id, client_package_id, amount, payment_method, status, payment_channel, stripe_payment_intent_id, stripe_account_id) values
  ('00000000-0000-0000-0000-000000f87001', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', '00000000-0000-0000-0000-000000f85001', 100, 'card', 'paid', 'online', 'pi_t_pkgrefund1_full', 'acct_tpkgrefund1'),
  ('00000000-0000-0000-0000-000000f87002', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', '00000000-0000-0000-0000-000000f85002', 100, 'card', 'paid', 'online', 'pi_t_pkgrefund1_partial', 'acct_tpkgrefund1'),
  ('00000000-0000-0000-0000-000000f87004', '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001', '00000000-0000-0000-0000-000000f85004', 100, 'card', 'paid', 'online', 'pi_t_pkgrefund1_unsettled', 'acct_tpkgrefund1');

-- ============================================================================
-- FORWARD RECONCILIATION
-- ============================================================================

do $$
declare
  r record;
  v_rem numeric;
  v_active boolean;
  v_status text;
  v_count int;
begin
  -- A non-succeeded observation never mutates credit.
  select * into r from public.reconcile_package_stripe_refund(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87001',
    're_t_pkgrefund1_full', 'ch_t_full', 10000, 'pending');
  if r.applied or r.outcome <> 'not_yet_effective' then
    raise exception 'FAIL T-pkgrefund1-pending-not-effective: % %', r.outcome, r.applied;
  end if;
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85101';
  if v_rem <> 6 then raise exception 'FAIL T-pkgrefund1-pending-no-mutation: %', v_rem; end if;

  -- First transition to succeeded applies the full-refund void exactly once.
  select * into r from public.reconcile_package_stripe_refund(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87001',
    're_t_pkgrefund1_full', 'ch_t_full', 10000, 'succeeded');
  if not r.applied or r.outcome <> 'auto_applied' then
    raise exception 'FAIL T-pkgrefund1-full-auto-applied: % %', r.outcome, r.applied;
  end if;
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85101';
  select active, refund_status into v_active, v_status from public.client_packages where id = '00000000-0000-0000-0000-000000f85001';
  if v_rem <> 0 or v_active or v_status <> 'full' then
    raise exception 'FAIL T-pkgrefund1-full-void: rem=% active=% status=%', v_rem, v_active, v_status;
  end if;

  -- Replayed delivery is idempotent.
  select * into r from public.reconcile_package_stripe_refund(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87001',
    're_t_pkgrefund1_full', 'ch_t_full', 10000, 'succeeded');
  select count(*) into v_count from public.lesson_transactions
    where client_package_id = '00000000-0000-0000-0000-000000f85001' and transaction_type::text = 'refund';
  if r.applied or v_count <> 1 then
    raise exception 'FAIL T-pkgrefund1-full-replay-idempotent: applied=% refund_rows=%', r.applied, v_count;
  end if;

  -- A caller-supplied studio that does not own the payment is rejected.
  begin
    perform public.reconcile_package_stripe_refund(
      '00000000-0000-0000-0000-000000f80002', '00000000-0000-0000-0000-000000f87002',
      're_t_pkgrefund1_wrongstudio', null, 1000, 'succeeded');
    raise exception 'FAIL T-pkgrefund1-wrong-studio-rejected';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- The same Stripe refund id can never be re-pointed at a different payment.
  begin
    perform public.reconcile_package_stripe_refund(
      '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87002',
      're_t_pkgrefund1_full', null, 1000, 'succeeded');
    raise exception 'FAIL T-pkgrefund1-refund-id-identity';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  raise notice 'PASS T-pkgrefund1-forward-reconciliation';
end $$;

-- ============================================================================
-- PARTIAL REFUND + STAFF REVIEW
-- ============================================================================

do $$
declare
  r record;
  v_recon uuid;
  v_rem numeric;
  v_active boolean;
  v_status text;
begin
  select * into r from public.reconcile_package_stripe_refund(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87002',
    're_t_pkgrefund1_partial', 'ch_t_partial', 3000, 'succeeded');
  if not r.applied or r.outcome <> 'pending_review' then
    raise exception 'FAIL T-pkgrefund1-partial-pending-review: % %', r.outcome, r.applied;
  end if;
  v_recon := r.reconciliation_id;
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85201';
  select active, refund_status into v_active, v_status from public.client_packages where id = '00000000-0000-0000-0000-000000f85002';
  if v_rem <> 8 or not v_active or v_status <> 'partial' then
    raise exception 'FAIL T-pkgrefund1-partial-no-credit-mutation: rem=% active=% status=%', v_rem, v_active, v_status;
  end if;

  -- An instructor is not an authorized reviewer.
  begin
    perform public.resolve_partial_refund_credit_review(
      '00000000-0000-0000-0000-000000f80001', v_recon, '00000000-0000-0000-0000-000000f81002',
      jsonb_build_array(jsonb_build_object('client_package_item_id', '00000000-0000-0000-0000-000000f85201', 'quantity', 3)));
    raise exception 'FAIL T-pkgrefund1-review-instructor-rejected';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  -- Voiding more than the remaining balance is rejected with no mutation.
  begin
    perform public.resolve_partial_refund_credit_review(
      '00000000-0000-0000-0000-000000f80001', v_recon, '00000000-0000-0000-0000-000000f81001',
      jsonb_build_array(jsonb_build_object('client_package_item_id', '00000000-0000-0000-0000-000000f85201', 'quantity', 99)));
    raise exception 'FAIL T-pkgrefund1-review-over-void-rejected';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  select * into r from public.resolve_partial_refund_credit_review(
    '00000000-0000-0000-0000-000000f80001', v_recon, '00000000-0000-0000-0000-000000f81001',
    jsonb_build_array(jsonb_build_object('client_package_item_id', '00000000-0000-0000-0000-000000f85201', 'quantity', 3)));
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85201';
  if r.outcome <> 'staff_applied' or r.voided_item_count <> 1 or v_rem <> 5 then
    raise exception 'FAIL T-pkgrefund1-review-staff-applied: % % rem=%', r.outcome, r.voided_item_count, v_rem;
  end if;

  -- A resolved review is no longer actionable.
  begin
    perform public.resolve_partial_refund_credit_review(
      '00000000-0000-0000-0000-000000f80001', v_recon, '00000000-0000-0000-0000-000000f81001', '[]'::jsonb);
    raise exception 'FAIL T-pkgrefund1-review-not-replayable';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  raise notice 'PASS T-pkgrefund1-partial-and-staff-review';
end $$;

-- ============================================================================
-- REVERSAL / RESTORATION + PKG-P1 SETTLEMENT GATE
-- ============================================================================

do $$
declare
  r record;
  v_rem numeric;
  v_active boolean;
  v_status text;
  v_reason text;
  v_count int;
begin
  -- Settled package (payment still 'paid'): reversal restores credits and reactivates.
  if not public._package_payment_settled('00000000-0000-0000-0000-000000f85001') then
    raise exception 'FAIL T-pkgrefund1-fixture-p1-settled';
  end if;
  select * into r from public.restore_package_refund_reconciliation(
    '00000000-0000-0000-0000-000000f80001', 're_t_pkgrefund1_full', 'failed');
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85101';
  select active, refund_status into v_active, v_status from public.client_packages where id = '00000000-0000-0000-0000-000000f85001';
  if not r.applied or r.outcome <> 'reversed' or r.restored_item_count <> 1 or v_rem <> 6 or not v_active or v_status is not null then
    raise exception 'FAIL T-pkgrefund1-reversal-settled-reactivates: % % % rem=% active=% status=%',
      r.outcome, r.applied, r.restored_item_count, v_rem, v_active, v_status;
  end if;

  -- Replayed reversal is a no-op.
  select * into r from public.restore_package_refund_reconciliation(
    '00000000-0000-0000-0000-000000f80001', 're_t_pkgrefund1_full', 'failed');
  select count(*) into v_count from public.lesson_transactions
    where client_package_id = '00000000-0000-0000-0000-000000f85001' and transaction_type::text = 'restored_lesson';
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85101';
  if r.applied or r.outcome <> 'reversed' or v_count <> 1 or v_rem <> 6 then
    raise exception 'FAIL T-pkgrefund1-reversal-replay-idempotent: % % rows=% rem=%', r.applied, r.outcome, v_count, v_rem;
  end if;

  -- Unsettled package: full refund, then the payment is 'refunded' exactly as
  -- PKG-P1 records it. The reversal must restore credits but NOT reactivate.
  perform public.reconcile_package_stripe_refund(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f87004',
    're_t_pkgrefund1_unsettled', 'ch_t_unsettled', 10000, 'succeeded');
  update public.payments set status = 'refunded', refund_amount = 100
    where id = '00000000-0000-0000-0000-000000f87004';
  if public._package_payment_settled('00000000-0000-0000-0000-000000f85004') then
    raise exception 'FAIL T-pkgrefund1-fixture-p4-unsettled';
  end if;

  select * into r from public.restore_package_refund_reconciliation(
    '00000000-0000-0000-0000-000000f80001', 're_t_pkgrefund1_unsettled', 'canceled');
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85401';
  select active, refund_status into v_active, v_status from public.client_packages where id = '00000000-0000-0000-0000-000000f85004';
  select review_reason into v_reason from public.package_refund_reconciliations where stripe_refund_id = 're_t_pkgrefund1_unsettled';
  if not r.applied or r.outcome <> 'reversed' or v_rem <> 5 or v_active or v_status is not null
     or v_reason not like '%payment settlement could not be confirmed%' then
    raise exception 'FAIL T-pkgrefund1-reversal-unsettled-stays-inactive: % % rem=% active=% status=% reason=%',
      r.outcome, r.applied, v_rem, v_active, v_status, v_reason;
  end if;
  -- The reversal manufactured no settlement evidence.
  if public._package_payment_settled('00000000-0000-0000-0000-000000f85004') then
    raise exception 'FAIL T-pkgrefund1-reversal-no-settlement-evidence';
  end if;

  -- Staff-applied reversal restores exactly the voided credits and leaves package state alone.
  select * into r from public.restore_package_refund_reconciliation(
    '00000000-0000-0000-0000-000000f80001', 're_t_pkgrefund1_partial', 'failed');
  select quantity_remaining into v_rem from public.client_package_items where id = '00000000-0000-0000-0000-000000f85201';
  select active into v_active from public.client_packages where id = '00000000-0000-0000-0000-000000f85002';
  if not r.applied or v_rem <> 8 or not v_active then
    raise exception 'FAIL T-pkgrefund1-reversal-staff-applied: % rem=% active=%', r.applied, v_rem, v_active;
  end if;

  -- Studio scope: another studio's call is a harmless no-op.
  select * into r from public.restore_package_refund_reconciliation(
    '00000000-0000-0000-0000-000000f80002', 're_t_pkgrefund1_full', 'failed');
  if r.applied or r.outcome <> 'not_reconciled' then
    raise exception 'FAIL T-pkgrefund1-reversal-wrong-studio-noop: % %', r.outcome, r.applied;
  end if;

  -- Only failed/canceled are reversal statuses.
  begin
    perform public.restore_package_refund_reconciliation(
      '00000000-0000-0000-0000-000000f80001', 're_t_pkgrefund1_full', 'succeeded');
    raise exception 'FAIL T-pkgrefund1-reversal-status-guard';
  exception when others then
    if sqlerrm like 'FAIL%' then raise; end if;
  end;

  raise notice 'PASS T-pkgrefund1-reversal-settlement-gate';
end $$;

-- ============================================================================
-- LEDGER UNIQUENESS, ACL, PKG-MUT-1 / GC1-2 REGRESSION
-- ============================================================================

do $$
declare
  v_recon uuid;
  r record;
  v_fn text;
begin
  select id into v_recon from public.package_refund_reconciliations where stripe_refund_id = 're_t_pkgrefund1_full';
  begin
    insert into public.lesson_transactions (
      studio_id, client_id, client_package_id, client_package_item_id,
      refund_reconciliation_id, transaction_type, lessons_delta, balance_after, notes
    ) values (
      '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001',
      '00000000-0000-0000-0000-000000f85001', '00000000-0000-0000-0000-000000f85101',
      v_recon, 'refund', -1, 0, 'duplicate');
    raise exception 'FAIL T-pkgrefund1-refund-ledger-unique';
  exception when unique_violation then
    null;
  end;

  foreach v_fn in array array[
    'public.reconcile_package_stripe_refund(uuid, uuid, text, text, integer, text, timestamptz)',
    'public.get_client_package_refund_financial_state(uuid, uuid)',
    'public.resolve_partial_refund_credit_review(uuid, uuid, uuid, jsonb, text)',
    'public.restore_package_refund_reconciliation(uuid, text, text, timestamptz)'
  ] loop
    if has_function_privilege('anon', v_fn, 'execute')
       or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'FAIL T-pkgrefund1-acl: %', v_fn;
    end if;
  end loop;

  -- PKG-MUT-1 manual correction still works on refund-touched packages.
  select * into r from public.apply_package_item_manual_correction(
    '00000000-0000-0000-0000-000000f80001', '00000000-0000-0000-0000-000000f83001',
    '00000000-0000-0000-0000-000000f85201', 'add', 1, 'harness', null);
  if r.new_quantity_remaining <> 9 then
    raise exception 'FAIL T-pkgrefund1-pkgmut1-intact: %', r.new_quantity_remaining;
  end if;

  if position('PKG-MUT-1' in (select prosrc from pg_proc where proname = 'deduct_package_credit_when_appointment_attended')) = 0
     or position('if new.appointment_type::text = ''group_class'' then' in (select prosrc from pg_proc where proname = 'deduct_package_credit_when_appointment_attended')) = 0
     or position('PKG-MUT-1' in (select prosrc from pg_proc where proname = 'deduct_package_credit_for_appointment')) = 0 then
    raise exception 'FAIL T-pkgrefund1-lock-order-gc1-2-intact';
  end if;

  raise notice 'PASS T-pkgrefund1-ledger-acl-regression';
end $$;

do $$ begin raise notice 'PKG-REFUND-1 SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
