-- PKG-P1 -- package payment/activation integrity, live-Postgres regression
-- suite.
--
-- Proves the canonical settlement predicate's refund-net math, zero-
-- evidence fail-closed gate, package_sales/account_credit_applied
-- staleness handling, the atomic void+re-evaluate RPC, the
-- payment_settlement_conflicts RLS/grant lockdown, and the narrowed
-- is_package_payment_settled authorization. Entire script runs in one
-- transaction and is rolled back at the end -- nothing persists. Run via
-- `supabase db query --linked --file <this file>` against DEV, AFTER
-- 20260913091100 has been applied.
--
-- Deterministic UUID block reserved for this harness:
-- 00000000-0000-0000-0000-000000e0XXXX (studios)
-- 00000000-0000-0000-0000-000000e1XXXX (auth.users/profiles)
-- 00000000-0000-0000-0000-000000e3XXXX (clients)
-- 00000000-0000-0000-0000-000000e5XXXX (client_packages / items)
-- 00000000-0000-0000-0000-000000e6XXXX (package_sales / payment_arrangements)
-- 00000000-0000-0000-0000-000000e7XXXX (payments)

begin;

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.payment_settlement_conflicts;
  if v_count <> 0 then
    raise exception 'FAIL T-pkgp1-preflight: expected 0 pre-existing conflict rows, got %', v_count;
  end if;
  raise notice 'PASS T-pkgp1-preflight-no-pre-existing-conflicts';
end $$;

-- ============================================================================
-- FIXTURES
-- ============================================================================

insert into public.studios (id, name, slug) values
  ('00000000-0000-0000-0000-000000e00001', 'PKG-P1 Harness Studio', 't-pkgp1-studio');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000e10001', 't-pkgp1-owner@example.test'),
  ('00000000-0000-0000-0000-000000e10002', 't-pkgp1-instructor@example.test');

insert into public.profiles (id, email, platform_role) values
  ('00000000-0000-0000-0000-000000e10001', 't-pkgp1-owner@example.test', null),
  ('00000000-0000-0000-0000-000000e10002', 't-pkgp1-instructor@example.test', null);

insert into public.user_studio_roles (user_id, studio_id, role, active) values
  ('00000000-0000-0000-0000-000000e10001', '00000000-0000-0000-0000-000000e00001', 'studio_owner', true),
  ('00000000-0000-0000-0000-000000e10002', '00000000-0000-0000-0000-000000e00001', 'instructor', true);

insert into public.clients (id, studio_id, first_name, last_name, status) values
  ('00000000-0000-0000-0000-000000e30001', '00000000-0000-0000-0000-000000e00001', 'A', 'PendingOnly', 'active'),
  ('00000000-0000-0000-0000-000000e30002', '00000000-0000-0000-0000-000000e00001', 'B', 'FailedOnly', 'active'),
  ('00000000-0000-0000-0000-000000e30003', '00000000-0000-0000-0000-000000e00001', 'C', 'FailedThenPaidRetry', 'active'),
  ('00000000-0000-0000-0000-000000e30004', '00000000-0000-0000-0000-000000e00001', 'D', 'PaidNoRefund', 'active'),
  ('00000000-0000-0000-0000-000000e30005', '00000000-0000-0000-0000-000000e00001', 'E', 'PaidPartialRefund', 'active'),
  ('00000000-0000-0000-0000-000000e30006', '00000000-0000-0000-0000-000000e00001', 'F', 'PaidFullyRefunded', 'active'),
  ('00000000-0000-0000-0000-000000e30007', '00000000-0000-0000-0000-000000e00001', 'G', 'VoidedNoRecovery', 'active'),
  ('00000000-0000-0000-0000-000000e30008', '00000000-0000-0000-0000-000000e00001', 'H', 'VoidedManualRecovery', 'active'),
  ('00000000-0000-0000-0000-000000e30009', '00000000-0000-0000-0000-000000e00001', 'I', 'ZeroPriceZeroEvidence', 'active'),
  ('00000000-0000-0000-0000-000000e30010', '00000000-0000-0000-0000-000000e00001', 'J', 'ZeroPriceZeroPayment', 'active'),
  ('00000000-0000-0000-0000-000000e30011', '00000000-0000-0000-0000-000000e00001', 'K', 'CompletedSaleFullyRefunded', 'active'),
  ('00000000-0000-0000-0000-000000e30012', '00000000-0000-0000-0000-000000e00001', 'L', 'CompletedSaleWithCredit', 'active'),
  ('00000000-0000-0000-0000-000000e30013', '00000000-0000-0000-0000-000000e00001', 'M', 'ImmediateArrangement', 'active'),
  ('00000000-0000-0000-0000-000000e30014', '00000000-0000-0000-0000-000000e00001', 'N', 'VoidArrangement', 'active'),
  ('00000000-0000-0000-0000-000000e30015', '00000000-0000-0000-0000-000000e00001', 'O', 'Imported', 'active'),
  ('00000000-0000-0000-0000-000000e30016', '00000000-0000-0000-0000-000000e00001', 'P', 'VoidTarget', 'active'),
  ('00000000-0000-0000-0000-000000e30017', '00000000-0000-0000-0000-000000e00001', 'Q', 'VoidTargetOtherBasis', 'active');

-- One package per scenario. price_snapshot=500 unless noted otherwise.
insert into public.client_packages (id, studio_id, client_id, name_snapshot, price_snapshot, active) values
  ('00000000-0000-0000-0000-000000e50001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30001', 'Pending Only', 500, false),
  ('00000000-0000-0000-0000-000000e50002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30002', 'Failed Only', 500, false),
  ('00000000-0000-0000-0000-000000e50003', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30003', 'Failed Then Paid Retry', 500, false),
  ('00000000-0000-0000-0000-000000e50004', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30004', 'Paid No Refund', 500, false),
  ('00000000-0000-0000-0000-000000e50005', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30005', 'Paid Partial Refund', 500, false),
  ('00000000-0000-0000-0000-000000e50006', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30006', 'Paid Fully Refunded', 500, false),
  ('00000000-0000-0000-0000-000000e50007', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30007', 'Voided No Recovery', 500, false),
  ('00000000-0000-0000-0000-000000e50008', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30008', 'Voided Manual Recovery', 500, false),
  ('00000000-0000-0000-0000-000000e50009', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30009', 'Zero Price Zero Evidence', 0, false),
  ('00000000-0000-0000-0000-000000e50010', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30010', 'Zero Price Zero Payment', 0, false),
  ('00000000-0000-0000-0000-000000e50011', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30011', 'Completed Sale Fully Refunded', 500, false),
  ('00000000-0000-0000-0000-000000e50012', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30012', 'Completed Sale With Credit', 500, false),
  ('00000000-0000-0000-0000-000000e50013', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30013', 'Immediate Arrangement', 500, true),
  ('00000000-0000-0000-0000-000000e50014', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30014', 'Void Arrangement', 500, false),
  ('00000000-0000-0000-0000-000000e50015', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30015', 'Imported', 500, true),
  ('00000000-0000-0000-0000-000000e50016', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30016', 'Void Target', 500, false),
  ('00000000-0000-0000-0000-000000e50017', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30017', 'Void Target Other Basis', 500, true);

update public.client_packages set source_system = 'wellnessliving', source_external_id = 'wl-1' where id = '00000000-0000-0000-0000-000000e50015';

-- Payments.
insert into public.payments (id, studio_id, client_id, client_package_id, amount, payment_method, status, payment_channel, source, refund_amount) values
  ('00000000-0000-0000-0000-000000e70001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30001', '00000000-0000-0000-0000-000000e50001', 500, 'card', 'pending', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30002', '00000000-0000-0000-0000-000000e50002', 500, 'card', 'failed', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70003', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30003', '00000000-0000-0000-0000-000000e50003', 500, 'card', 'failed', 'online', 'stripe', 0),
  ('00000000-0000-0000-0000-000000e70004', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30003', '00000000-0000-0000-0000-000000e50003', 500, 'card', 'paid', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70005', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30004', '00000000-0000-0000-0000-000000e50004', 500, 'card', 'paid', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70006', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30005', '00000000-0000-0000-0000-000000e50005', 500, 'card', 'paid', 'online', 'stripe', 200),

  ('00000000-0000-0000-0000-000000e70007', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30006', '00000000-0000-0000-0000-000000e50006', 500, 'card', 'refunded', 'online', 'stripe', 500),

  ('00000000-0000-0000-0000-000000e70008', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30007', '00000000-0000-0000-0000-000000e50007', 500, 'card', 'voided', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70009', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30008', '00000000-0000-0000-0000-000000e50008', 500, 'card', 'voided', 'online', 'stripe', 0),
  ('00000000-0000-0000-0000-000000e70010', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30008', '00000000-0000-0000-0000-000000e50008', 500, 'cash', 'paid', 'manual', 'manual', 0),

  ('00000000-0000-0000-0000-000000e70011', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30010', '00000000-0000-0000-0000-000000e50010', 0, 'cash', 'paid', 'manual', 'manual', 0),

  ('00000000-0000-0000-0000-000000e70016', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30016', '00000000-0000-0000-0000-000000e50016', 500, 'card', 'pending', 'online', 'stripe', 0),

  ('00000000-0000-0000-0000-000000e70017', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30017', '00000000-0000-0000-0000-000000e50017', 500, 'card', 'pending', 'online', 'stripe', 0),
  ('00000000-0000-0000-0000-000000e70018', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30017', '00000000-0000-0000-0000-000000e50017', 500, 'cash', 'paid', 'manual', 'manual', 0);

insert into public.package_templates (id, studio_id, name, price, active) values
  ('00000000-0000-0000-0000-000000e60000', '00000000-0000-0000-0000-000000e00001', 'T-pkgp1 Template', 500, true);

-- package_sales: one 'completed' sale whose payment is fully refunded
-- (must NOT bypass), one 'completed' sale with account_credit_applied
-- (payments alone don't cover price, credit makes up the difference).
insert into public.package_sales (id, studio_id, client_id, package_template_id, client_package_id, sale_total, account_credit_applied, tender_total, remaining_balance, status, purchase_date) values
  ('00000000-0000-0000-0000-000000e60001', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30011', '00000000-0000-0000-0000-000000e60000', '00000000-0000-0000-0000-000000e50011', 500, 0, 500, 0, 'completed', current_date),
  ('00000000-0000-0000-0000-000000e60002', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30012', '00000000-0000-0000-0000-000000e60000', '00000000-0000-0000-0000-000000e50012', 500, 200, 300, 0, 'completed', current_date);

insert into public.payments (id, studio_id, client_id, client_package_id, package_sale_id, amount, payment_method, status, payment_channel, source, refund_amount) values
  ('00000000-0000-0000-0000-000000e70012', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30011', '00000000-0000-0000-0000-000000e50011', '00000000-0000-0000-0000-000000e60001', 500, 'card', 'refunded', 'manual', 'manual', 500),
  ('00000000-0000-0000-0000-000000e70013', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30012', '00000000-0000-0000-0000-000000e50012', '00000000-0000-0000-0000-000000e60002', 300, 'cash', 'paid', 'manual', 'manual', 0);

-- payment_arrangements: immediate/active (bypass) and void (blocked). Each
-- arrangement requires its own package_sales row (package_sale_id is a
-- unique FK on payment_arrangements, populated by the real RPC in every
-- production path).
insert into public.package_sales (id, studio_id, client_id, package_template_id, client_package_id, sale_total, account_credit_applied, tender_total, remaining_balance, status, purchase_date) values
  ('00000000-0000-0000-0000-000000e60013', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30013', '00000000-0000-0000-0000-000000e60000', '00000000-0000-0000-0000-000000e50013', 500, 0, 100, 400, 'pending', current_date),
  ('00000000-0000-0000-0000-000000e60014', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30014', '00000000-0000-0000-0000-000000e60000', '00000000-0000-0000-0000-000000e50014', 500, 0, 0, 500, 'void', current_date);

insert into public.payment_arrangements (id, studio_id, client_id, package_sale_id, client_package_id, original_balance, down_payment, financed_balance, remaining_balance, installment_count, frequency, first_due_date, access_policy, status) values
  ('00000000-0000-0000-0000-000000e60011', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30013', '00000000-0000-0000-0000-000000e60013', '00000000-0000-0000-0000-000000e50013', 500, 100, 400, 400, 4, 'monthly', current_date + 30, 'immediate', 'active'),
  ('00000000-0000-0000-0000-000000e60012', '00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e30014', '00000000-0000-0000-0000-000000e60014', '00000000-0000-0000-0000-000000e50014', 500, 0, 500, 500, 4, 'monthly', current_date + 30, 'immediate', 'void');

-- ============================================================================
-- 1. Refund-net math and status classification.
-- ============================================================================
do $$
begin
  -- pending online only -> hard block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50001') is not false then
    raise exception 'FAIL T-pkgp1-pending-only-hard-block';
  end if;

  -- failed online only -> no settlement -> block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50002') is not false then
    raise exception 'FAIL T-pkgp1-failed-only-block';
  end if;

  -- failed online + later paid online retry -> allow.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50003') is not true then
    raise exception 'FAIL T-pkgp1-failed-then-paid-retry-allow';
  end if;

  -- paid online, no refund -> allow ($500 contributes $500 >= $500).
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50004') is not true then
    raise exception 'FAIL T-pkgp1-paid-no-refund-allow';
  end if;

  -- paid online, $200 partial refund (status stays 'paid') -> net $300 < $500 -> block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50005') is not false then
    raise exception 'FAIL T-pkgp1-paid-partial-refund-net-insufficient-block';
  end if;

  -- paid online, fully refunded (status='refunded') -> net $0 -> block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50006') is not false then
    raise exception 'FAIL T-pkgp1-paid-fully-refunded-block';
  end if;

  -- voided online, no recovery -> block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50007') is not false then
    raise exception 'FAIL T-pkgp1-voided-no-recovery-block';
  end if;

  -- voided online + manual paid recovery covering price -> allow.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50008') is not true then
    raise exception 'FAIL T-pkgp1-voided-manual-recovery-allow';
  end if;

  raise notice 'PASS T-pkgp1-refund-net-math-and-status-classification';
end $$;

-- ============================================================================
-- 2. Zero-evidence fail-closed gate.
-- ============================================================================
do $$
begin
  -- zero price + zero provenance (no payments, no arrangement, no sale, no source_system) -> block.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50009') is not false then
    raise exception 'FAIL T-pkgp1-zero-price-zero-evidence-block';
  end if;

  -- zero price + a real $0 paid payment -> allow (evidence exists, 0 >= 0).
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50010') is not true then
    raise exception 'FAIL T-pkgp1-zero-price-real-zero-payment-allow';
  end if;

  raise notice 'PASS T-pkgp1-zero-evidence-fail-closed-gate';
end $$;

-- ============================================================================
-- 3. package_sales staleness / account_credit_applied handling.
-- ============================================================================
do $$
begin
  -- 'completed' sale whose payment is fully refunded -> must NOT bypass; blocked.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50011') is not false then
    raise exception 'FAIL T-pkgp1-completed-sale-fully-refunded-blocked';
  end if;

  -- 'completed' sale, $300 paid + $200 account_credit_applied = $500 >= $500 -> allow.
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50012') is not true then
    raise exception 'FAIL T-pkgp1-completed-sale-with-credit-allow';
  end if;

  raise notice 'PASS T-pkgp1-package-sales-staleness-and-credit-handling';
end $$;

-- ============================================================================
-- 4. Arrangement / imported bypasses.
-- ============================================================================
do $$
begin
  if public._package_payment_settled('00000000-0000-0000-0000-000000e50013') is not true then
    raise exception 'FAIL T-pkgp1-immediate-active-arrangement-allow';
  end if;

  if public._package_payment_settled('00000000-0000-0000-0000-000000e50014') is not false then
    raise exception 'FAIL T-pkgp1-void-arrangement-block';
  end if;

  if public._package_payment_settled('00000000-0000-0000-0000-000000e50015') is not true then
    raise exception 'FAIL T-pkgp1-imported-allow';
  end if;

  raise notice 'PASS T-pkgp1-arrangement-and-imported-bypasses';
end $$;

-- ============================================================================
-- 5. is_package_payment_settled -- narrowed to broad staff (front_desk
--    included, matching canEditClients; instructor rejected).
-- ============================================================================
do $$
declare
  v_result boolean;
  v_errored boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  v_result := public.is_package_payment_settled('00000000-0000-0000-0000-000000e50004');
  reset role;
  if v_result is not true then raise exception 'FAIL T-pkgp1-is-package-payment-settled-owner-allowed'; end if;

  v_errored := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10002')::text, true);
  begin
    perform public.is_package_payment_settled('00000000-0000-0000-0000-000000e50004');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-pkgp1-is-package-payment-settled-instructor-rejected'; end if;

  raise notice 'PASS T-pkgp1-is-package-payment-settled-authorization';
end $$;

-- ============================================================================
-- 6. void_pending_package_payment -- atomic void + re-evaluate.
-- ============================================================================
do $$
declare
  v_voided boolean;
  v_deactivated boolean;
  v_errored boolean;
  v_would_remain_settled boolean;
begin
  -- PKG-P1 section 14: void pre-confirm-warning preview, checked BEFORE
  -- either payment is actually voided -- sole basis -> would NOT remain
  -- settled (warn); other basis exists -> WOULD remain settled (no warn).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  v_would_remain_settled := public.would_package_remain_settled_without_payment('00000000-0000-0000-0000-000000e70016');
  reset role;
  if v_would_remain_settled is not false then
    raise exception 'FAIL T-pkgp1-preview-sole-basis-would-not-remain-settled';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  v_would_remain_settled := public.would_package_remain_settled_without_payment('00000000-0000-0000-0000-000000e70017');
  reset role;
  if v_would_remain_settled is not true then
    raise exception 'FAIL T-pkgp1-preview-other-basis-would-remain-settled';
  end if;

  raise notice 'PASS T-pkgp1-would-package-remain-settled-without-payment-preview';

  -- Void a payment that is the package's sole basis -> atomically deactivates.
  update public.client_packages set active = true where id = '00000000-0000-0000-0000-000000e50016';

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  select voided, package_deactivated into v_voided, v_deactivated
    from public.void_pending_package_payment('00000000-0000-0000-0000-000000e70016', 'test: sole basis');
  reset role;

  if v_voided is not true or v_deactivated is not true then
    raise exception 'FAIL T-pkgp1-void-sole-basis-deactivates: voided=%, deactivated=%', v_voided, v_deactivated;
  end if;
  if (select active from public.client_packages where id = '00000000-0000-0000-0000-000000e50016') is not false then
    raise exception 'FAIL T-pkgp1-void-sole-basis-package-inactive';
  end if;
  if (select archived_at from public.client_packages where id = '00000000-0000-0000-0000-000000e50016') is null
     or (select archived_by from public.client_packages where id = '00000000-0000-0000-0000-000000e50016') is not null
  then
    raise exception 'FAIL T-pkgp1-void-sole-basis-archive-metadata: expected archived_at set, archived_by null';
  end if;

  -- Second void attempt on the same (now-voided) payment -> no-op.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  select voided, package_deactivated into v_voided, v_deactivated
    from public.void_pending_package_payment('00000000-0000-0000-0000-000000e70016', 'test: second attempt');
  reset role;
  if v_voided is not false or v_deactivated is not false then
    raise exception 'FAIL T-pkgp1-void-second-attempt-noop';
  end if;

  -- Void a payment when another basis independently justifies activation -> leaves active.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  select voided, package_deactivated into v_voided, v_deactivated
    from public.void_pending_package_payment('00000000-0000-0000-0000-000000e70017', 'test: other basis exists');
  reset role;
  if v_voided is not true or v_deactivated is not false then
    raise exception 'FAIL T-pkgp1-void-other-basis-leaves-active: voided=%, deactivated=%', v_voided, v_deactivated;
  end if;
  if (select active from public.client_packages where id = '00000000-0000-0000-0000-000000e50017') is not true then
    raise exception 'FAIL T-pkgp1-void-other-basis-package-still-active';
  end if;

  -- Empty reason rejected.
  v_errored := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  begin
    perform public.void_pending_package_payment('00000000-0000-0000-0000-000000e70011', '');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-pkgp1-void-empty-reason-rejected'; end if;

  -- Instructor (not broad staff) rejected.
  v_errored := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10002')::text, true);
  begin
    perform public.void_pending_package_payment('00000000-0000-0000-0000-000000e70011', 'instructor attempt');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-pkgp1-void-instructor-rejected'; end if;

  raise notice 'PASS T-pkgp1-void-pending-package-payment-atomic';
end $$;

-- ============================================================================
-- 7. payment_settlement_conflicts -- RLS lockdown + resolution RPCs.
-- ============================================================================
do $$
declare
  v_errored boolean;
  v_conflict_id uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);

  -- Direct INSERT as staff rejected (no permissive policy for authenticated).
  v_errored := false;
  begin
    insert into public.payment_settlement_conflicts (studio_id, payment_id, stripe_event_id, stripe_event_type)
    values ('00000000-0000-0000-0000-000000e00001', '00000000-0000-0000-0000-000000e70011', 'evt_test_direct_insert', 'checkout.session.completed');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-pkgp1-conflicts-direct-insert-rejected'; end if;

  -- Create one via the internal path (as if from a service_role webhook call).
  set local role service_role;
  perform public.record_stale_payment_success_conflict(
    '00000000-0000-0000-0000-000000e70008', 'evt_test_stale_success', 'checkout.session.completed', 'cs_test_1'
  );
  -- Duplicate delivery of the same event -> idempotent, no second row.
  perform public.record_stale_payment_success_conflict(
    '00000000-0000-0000-0000-000000e70008', 'evt_test_stale_success', 'checkout.session.completed', 'cs_test_1'
  );
  reset role;

  if (select count(*) from public.payment_settlement_conflicts where stripe_event_id = 'evt_test_stale_success') <> 1 then
    raise exception 'FAIL T-pkgp1-conflicts-idempotent-by-event-id';
  end if;

  select id into v_conflict_id from public.payment_settlement_conflicts where stripe_event_id = 'evt_test_stale_success';

  -- Direct UPDATE as staff is a structural no-op: with RLS enabled and no
  -- permissive UPDATE policy for any role, the row is simply not matched
  -- (0 rows affected), not an exception -- verify the row is genuinely
  -- untouched, matching how a missing UPDATE policy actually behaves
  -- (distinct from INSERT, whose WITH CHECK failure does raise).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  update public.payment_settlement_conflicts set status = 'resolved' where id = v_conflict_id;
  reset role;
  if (select status from public.payment_settlement_conflicts where id = v_conflict_id) <> 'pending_review' then
    raise exception 'FAIL T-pkgp1-conflicts-direct-update-rejected';
  end if;

  -- Resolve with an empty note rejected.
  v_errored := false;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  begin
    perform public.resolve_payment_settlement_conflict(v_conflict_id, '');
  exception when others then
    v_errored := true;
  end;
  reset role;
  if not v_errored then raise exception 'FAIL T-pkgp1-conflicts-resolve-empty-note-rejected'; end if;

  -- Add a note (doesn't change status).
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  perform public.add_payment_settlement_conflict_note(v_conflict_id, 'Looking into this.');
  reset role;
  if (select status from public.payment_settlement_conflicts where id = v_conflict_id) <> 'pending_review' then
    raise exception 'FAIL T-pkgp1-conflicts-note-does-not-change-status';
  end if;

  -- Resolve with a real note -> stamps resolved_by/resolved_at/status.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-000000e10001')::text, true);
  perform public.resolve_payment_settlement_conflict(v_conflict_id, 'Confirmed no money was captured; voided in Stripe dashboard.');
  reset role;
  if (select status from public.payment_settlement_conflicts where id = v_conflict_id) <> 'resolved'
     or (select resolved_by from public.payment_settlement_conflicts where id = v_conflict_id) is null
     or (select resolved_at from public.payment_settlement_conflicts where id = v_conflict_id) is null
  then
    raise exception 'FAIL T-pkgp1-conflicts-resolve-stamps-fields';
  end if;

  raise notice 'PASS T-pkgp1-payment-settlement-conflicts-rls-and-rpcs';
end $$;

-- ============================================================================
-- 8. Stale-success does NOT record a conflict for an ordinary duplicate
--    (already 'paid') delivery.
-- ============================================================================
do $$
begin
  set local role service_role;
  perform public.record_stale_payment_success_conflict(
    '00000000-0000-0000-0000-000000e70005', 'evt_test_duplicate_paid', 'checkout.session.completed', 'cs_test_2'
  );
  reset role;

  if exists (select 1 from public.payment_settlement_conflicts where stripe_event_id = 'evt_test_duplicate_paid') then
    raise exception 'FAIL T-pkgp1-duplicate-paid-no-conflict-row';
  end if;

  raise notice 'PASS T-pkgp1-duplicate-success-against-already-paid-no-conflict';
end $$;

do $$ begin raise notice 'PKG-P1 SQL regression suite: ALL CHECKS PASSED'; end $$;

rollback;
