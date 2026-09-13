-- PKG-P1: Package Payment/Activation Integrity.
--
-- Canonical plan: PKG-P1 design, C:\Users\mcurt\.claude\plans\pause-gc-3-2-packaging-perform-virtual-orbit.md
-- (final, multi-round-reviewed revision -- "PKG-P1 FINAL DESIGN READY --
-- IMPLEMENTATION SAFE").
--
-- Fixes a real production entitlement-integrity gap discovered auditing
-- GC-3.2: client_packages.active could become/remain true while its
-- originating payment-required online/terminal payment was never settled
-- (reactivateClientPackageAction had zero payment awareness), and a stale
-- Stripe webhook could silently un-void a payment DanceFlow had already
-- explicitly voided (no CAS guard on that write path). This migration
-- introduces one canonical settlement predicate, one canonical atomic
-- re-evaluation/auto-deactivation helper reused by every payment-state
-- transition that can invalidate entitlement (staff void, async payment
-- failure, refund), and a staff-visible reconciliation queue for the case
-- a stale success event arrives after DanceFlow has already closed the
-- book on a payment (money may have moved with no valid entitlement to
-- attach it to).
--
-- Audited live before writing this file (see plan doc for full trace):
--   - package_sales.status is never touched by any refund path in this
--     codebase (confirmed by direct read of
--     20260822090000_package_refund_reconciliation_rpcs.sql's own header:
--     "Neither function touches ... package_sales, or any existing
--     function"), so a 'completed' sale row cannot be trusted as an
--     unconditional, refund-proof settlement bypass. account_credit_applied
--     is folded into the net-settlement sum instead, and only counted when
--     no payment on this package has ever been refunded (an independent
--     staleness check, since the sale row itself cannot tell us).
--   - client_packages price authority is coalesce(sold_price, price_snapshot)
--     -- confirmed as this codebase's own existing convention by direct
--     read of get_client_package_refund_financial_state's identical choice.
--   - updatePaymentRefundByPaymentIntent (webhook route.ts) sets
--     status='paid' with an updated refund_amount for a PARTIAL refund,
--     and status='refunded' only once refundAmount >= totalAmount for a
--     FULL refund -- confirmed by direct read. The net-settlement formula
--     below therefore treats 'paid' and 'refunded' identically
--     (amount - refund_amount), not "paid always counts in full".
--
-- Six functions plus one table. RLS/grant posture narrows deliberately by
-- action:
--   - is_package_payment_settled: matches canEditClients' existing broad-
--     staff set (platform_admin/studio_owner/studio_admin/front_desk) --
--     it feeds reactivateClientPackageAction's existing, unmodified
--     front-desk-inclusive gate; narrowing it here would regress existing
--     front-desk reactivation capability.
--   - void_pending_package_payment / resolve_payment_settlement_conflict /
--     add_payment_settlement_conflict_note: match refundClientPaymentAction's
--     existing, narrower gate (platform_admin/studio_owner/studio_admin,
--     NOT front_desk) -- voiding a payment and resolving a financial-
--     mismatch conflict are the same class of sensitive action as issuing
--     a refund, not ordinary payment recording. Mirrors
--     package_refund_reconciliations' own established RLS precedent
--     exactly (20260817090100_package_refund_reconciliations.sql).

begin;

-- ============================================================================
-- 1. payment_settlement_conflicts -- staff-visible reconciliation queue.
--
-- One row per genuinely conflicting Stripe event (a success/refund signal
-- arriving against a payment DanceFlow's own record shows as no longer
-- open) -- never for an ordinary duplicate/idempotent redelivery. Creation
-- and mutation exclusively via SECURITY DEFINER functions below; no
-- INSERT/UPDATE/DELETE RLS policy exists for any role, matching
-- package_refund_reconciliations' own established "no ordinary client-side
-- CRUD write path" posture. Preservation-first: this is financial
-- reconciliation/audit data (see rollback).
-- ============================================================================
create table public.payment_settlement_conflicts (
  id                  uuid primary key default gen_random_uuid(),
  studio_id           uuid not null references public.studios(id),
  payment_id          uuid not null references public.payments(id),
  client_package_id   uuid references public.client_packages(id),
  stripe_event_id     text not null,
  stripe_event_type   text not null,
  stripe_session_id   text,
  note                text,
  status              text not null default 'pending_review'
    check (status = any (array['pending_review', 'resolved']::text[])),
  resolved_by         uuid,
  resolved_at         timestamptz,
  resolution_note     text,
  created_at          timestamptz not null default now(),

  constraint payment_settlement_conflicts_event_unique unique (stripe_event_id)
);

comment on table public.payment_settlement_conflicts is
  'PKG-P1: staff-visible queue for a Stripe event reporting real settlement '
  '(success or refund) against a payment DanceFlow''s own record shows as '
  'already closed (voided/failed/refunded-differently) -- money may have '
  'moved with no valid entitlement to attach it to. Never auto-resolved, '
  'never auto-refunded, never auto-reactivates anything.';

create index idx_payment_settlement_conflicts_studio_id
  on public.payment_settlement_conflicts (studio_id);
create index idx_payment_settlement_conflicts_status
  on public.payment_settlement_conflicts (status);

alter table public.payment_settlement_conflicts enable row level security;

create policy "payment_settlement_conflicts_select"
  on public.payment_settlement_conflicts
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_studio_roles usr
      where usr.studio_id = payment_settlement_conflicts.studio_id
        and usr.user_id = auth.uid()
        and usr.active = true
        and usr.role::text in ('platform_admin', 'studio_owner', 'studio_admin')
    )
  );
-- No INSERT, UPDATE, or DELETE policy for any role -- see functions below.

-- ============================================================================
-- 2. _package_payment_settled -- canonical settlement predicate.
--
-- Internal only (no grant to any role) -- reachable only from inside the
-- SECURITY DEFINER functions below via owner-implicit privilege, matching
-- this codebase's established convention for internal-only helpers.
--
-- Semantics (locked by the finalized design, see plan doc Section 1):
--   - A live (non-voided) online/terminal payment still in 'pending' status
--     is a hard, unconditional block -- an open obligation always blocks,
--     regardless of any other payment present on this package.
--   - Absent any pending obligation, at least one piece of legitimate
--     evidence must exist at all (source_system, an arrangement row, a
--     sale row, or any payments row) -- zero evidence fails closed
--     regardless of price, closing the "$0 price + zero provenance"
--     accidental-pass gap.
--   - Imported/historical (source_system set) and an intentionally
--     immediate-access, non-defaulted financed arrangement are true,
--     payment-independent bypasses.
--   - Otherwise: net settled amount (sum of amount - refund_amount across
--     every 'paid'/'refunded' payment row -- both statuses use the
--     identical net formula, since a partial refund leaves status='paid'
--     with refund_amount set; only a full refund flips to 'refunded') plus
--     a completed sale's account_credit_applied (only counted when no
--     payment on this package has ever been refunded -- an independent
--     staleness check, since package_sales.status is never itself updated
--     by any refund path) must reach the package's recorded price
--     (coalesce(sold_price, price_snapshot)). Unprovable price (both null)
--     fails closed.
-- ============================================================================
-- VOLATILE, deliberately, matching _group_class_finite_balance's (GC-2b)
-- own established reasoning: this function is called from within
-- _reevaluate_and_deactivate_package_if_unsettled immediately after a
-- same-transaction payments UPDATE (void/failed/refund) and must reflect
-- that write, which a STABLE function's per-call caching assumptions are
-- not guaranteed to honor.
-- Explicit drop of the original single-argument signature before
-- recreating with the new optional second parameter -- CREATE OR REPLACE
-- cannot widen a function's parameter list in place (a different
-- parameter list is a distinct overload, not a replacement), so without
-- this drop, re-applying this migration would leave BOTH the old 1-arg
-- and new 2-arg versions live simultaneously -- an ambiguous-overload trap
-- for any 1-argument caller, and a stale-function regression this
-- migration's own review specifically checked for.
drop function if exists public._package_payment_settled(uuid);

-- p_exclude_payment_id: PKG-P1 §14 addition -- when provided, that one
-- payment is excluded from every read below, as if it didn't exist. Lets
-- would_package_remain_settled_without_payment (below) answer "would this
-- package still be settled if this specific payment were voided" by
-- reusing this exact predicate rather than duplicating it. Defaults to
-- null, which is a complete no-op (every existing call site -- the atomic
-- void/failure/refund re-evaluation path -- passes only one argument, so
-- this default preserves that already-approved behavior unchanged: those
-- callers evaluate AFTER the real state change already happened and never
-- need to exclude anything hypothetically).
create or replace function public._package_payment_settled(
  p_client_package_id uuid,
  p_exclude_payment_id uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_source_system text;
  v_price numeric;
  v_arrangement_status text;
  v_arrangement_access_policy text;
  v_sale_status text;
  v_sale_account_credit_applied numeric;
  v_has_pending_online_terminal boolean;
  v_has_any_evidence boolean;
  v_has_any_refund boolean;
  v_total_settled numeric;
begin
  select exists (
    select 1 from public.payments
    where client_package_id = p_client_package_id
      and payment_channel in ('online', 'terminal')
      and status = 'pending'
      and (p_exclude_payment_id is null or id <> p_exclude_payment_id)
  ) into v_has_pending_online_terminal;

  if v_has_pending_online_terminal then
    return false;
  end if;

  select source_system, coalesce(sold_price, price_snapshot)
    into v_source_system, v_price
    from public.client_packages
    where id = p_client_package_id;

  select status, access_policy
    into v_arrangement_status, v_arrangement_access_policy
    from public.payment_arrangements
    where client_package_id = p_client_package_id
    order by created_at desc
    limit 1;

  select status, account_credit_applied
    into v_sale_status, v_sale_account_credit_applied
    from public.package_sales
    where client_package_id = p_client_package_id
    order by created_at desc
    limit 1;

  select
    (v_source_system is not null)
    or (v_arrangement_status is not null)
    or (v_sale_status is not null)
    or exists (
      select 1 from public.payments
      where client_package_id = p_client_package_id
        and (p_exclude_payment_id is null or id <> p_exclude_payment_id)
    )
    into v_has_any_evidence;

  if not v_has_any_evidence then
    return false; -- fail-closed: nothing establishes why this package exists
  end if;

  if v_source_system is not null then
    return true;
  end if;

  if v_arrangement_status = 'void' then
    return false;
  end if;

  if v_arrangement_access_policy = 'immediate' and v_arrangement_status <> 'defaulted' then
    return true;
  end if;

  select coalesce(sum(
    case when status in ('paid', 'refunded')
      then greatest(amount - coalesce(refund_amount, 0), 0)
      else 0
    end
  ), 0) into v_total_settled
  from public.payments
  where client_package_id = p_client_package_id
    and (p_exclude_payment_id is null or id <> p_exclude_payment_id);

  select exists (
    select 1 from public.payments
    where client_package_id = p_client_package_id
      and (status = 'refunded' or coalesce(refund_amount, 0) > 0)
      and (p_exclude_payment_id is null or id <> p_exclude_payment_id)
  ) into v_has_any_refund;

  if v_sale_status = 'completed' and not v_has_any_refund then
    v_total_settled := v_total_settled + coalesce(v_sale_account_credit_applied, 0);
  end if;

  if v_price is null then
    return false; -- fail-closed: can't prove it
  end if;

  return v_total_settled >= v_price;
end;
$$;

revoke all on function public._package_payment_settled(uuid, uuid) from public, anon, authenticated, service_role;

-- ============================================================================
-- 3. is_package_payment_settled -- read-only, staff-facing wrapper.
--
-- Matches canEditClients' existing broad-staff set exactly (feeds
-- reactivateClientPackageAction's existing, unmodified gate -- narrowing
-- this would regress existing front-desk reactivation capability).
-- ============================================================================
create or replace function public.is_package_payment_settled(p_client_package_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_authorized boolean;
begin
  select studio_id into v_studio_id from public.client_packages where id = p_client_package_id;

  if v_studio_id is null then
    raise exception 'Package not found.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  ) or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = v_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin', 'front_desk']::app_role[])
      and usr.active = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to view payment settlement for this package.';
  end if;

  return public._package_payment_settled(p_client_package_id);
end;
$$;

revoke all on function public.is_package_payment_settled(uuid) from public;
revoke all on function public.is_package_payment_settled(uuid) from anon;
grant execute on function public.is_package_payment_settled(uuid) to authenticated;
revoke all on function public.is_package_payment_settled(uuid) from service_role;

-- ============================================================================
-- 3b. would_package_remain_settled_without_payment -- PKG-P1 §14 addition:
--     the void dialog's pre-confirm-warning predicate. Reuses
--     _package_payment_settled's own p_exclude_payment_id parameter rather
--     than duplicating settlement logic -- answers "would this package
--     still be settled if this specific payment were voided" by asking the
--     canonical predicate to evaluate as though that payment didn't exist.
--     Same narrow gate as void_pending_package_payment (studio_owner/
--     studio_admin/platform_admin, not front_desk) -- this function exists
--     only to preview that action.
-- ============================================================================
create or replace function public.would_package_remain_settled_without_payment(p_payment_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = 'public'
as $$
declare
  v_client_package_id uuid;
  v_studio_id uuid;
  v_authorized boolean;
begin
  select client_package_id, studio_id into v_client_package_id, v_studio_id
    from public.payments where id = p_payment_id;

  if v_studio_id is null then
    raise exception 'Payment not found.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  ) or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = v_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to void payments for this studio.';
  end if;

  if v_client_package_id is null then
    return true; -- not a package payment -- nothing to warn about
  end if;

  return public._package_payment_settled(v_client_package_id, p_payment_id);
end;
$$;

revoke all on function public.would_package_remain_settled_without_payment(uuid) from public;
revoke all on function public.would_package_remain_settled_without_payment(uuid) from anon;
grant execute on function public.would_package_remain_settled_without_payment(uuid) to authenticated;
revoke all on function public.would_package_remain_settled_without_payment(uuid) from service_role;

-- ============================================================================
-- 4. _reevaluate_and_deactivate_package_if_unsettled -- canonical atomic
--    re-evaluation helper, reused by every payment-state transition that
--    can invalidate entitlement (void, async failure, refund).
--
-- Internal only. Never activates a package -- one-directional safety net,
-- only ever removes access that no longer has a valid basis. Reuses the
-- SAME archived state archiveClientPackageAction produces (archived_at
-- set) rather than a new "inactive" concept -- confirmed necessary by
-- direct read of getClientPackageStatus (src/lib/packages/entitlement.ts),
-- which keys the "archived" health bucket purely on archived_at, not
-- active; leaving archived_at null here would make the client page's own
-- health badge keep showing the package as active/low even though
-- client_packages.active is false -- a second, worse display bug on top of
-- the entitlement one. archived_by is deliberately left null (never
-- attributed to a staff member) with a system-generated archive_reason, so
-- the record stays truthful about not being a manual archive decision.
-- ============================================================================
create or replace function public._reevaluate_and_deactivate_package_if_unsettled(
  p_client_package_id uuid,
  p_reason text
) returns boolean
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_deactivated boolean := false;
begin
  if p_client_package_id is null then
    return false;
  end if;

  if not public._package_payment_settled(p_client_package_id) then
    update public.client_packages
      set active = false, archived_at = now(), archived_by = null, archive_reason = p_reason
      where id = p_client_package_id and active = true
      returning true into v_deactivated;
  end if;

  return coalesce(v_deactivated, false);
end;
$$;

revoke all on function public._reevaluate_and_deactivate_package_if_unsettled(uuid, text)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 5. _record_payment_settlement_conflict -- internal conflict-row writer.
--
-- Idempotent by stripe_event_id (unique constraint + on conflict do
-- nothing) -- a webhook retry delivering the same event id a second time
-- never creates a duplicate staff-review row.
-- ============================================================================
create or replace function public._record_payment_settlement_conflict(
  p_studio_id uuid,
  p_payment_id uuid,
  p_client_package_id uuid,
  p_stripe_event_id text,
  p_stripe_event_type text,
  p_stripe_session_id text,
  p_note text
) returns void
language plpgsql
security definer
set search_path = 'public'
as $$
begin
  insert into public.payment_settlement_conflicts (
    studio_id, payment_id, client_package_id, stripe_event_id, stripe_event_type, stripe_session_id, note
  ) values (
    p_studio_id, p_payment_id, p_client_package_id, p_stripe_event_id, p_stripe_event_type, p_stripe_session_id, p_note
  )
  on conflict (stripe_event_id) do nothing;
end;
$$;

revoke all on function public._record_payment_settlement_conflict(uuid, uuid, uuid, text, text, text, text)
  from public, anon, authenticated, service_role;

-- ============================================================================
-- 6. void_pending_package_payment -- staff-initiated, atomic.
--
-- The void and any resulting package deactivation happen inside one
-- PL/pgSQL function body -- one transaction from the caller's perspective,
-- no partial-update window ("payment voided, deactivation failed, package
-- remains usable" is structurally impossible here). CAS-guarded exactly
-- like every other guarded payment write in this codebase
-- (handlePortalFloorRentalCheckoutCompleted's own established pattern):
-- only transitions FROM 'pending'. Never touches Stripe -- no precedent
-- anywhere in this codebase for stripe.checkout.sessions.expire(), and the
-- DB-side void is already authoritative (client-checkout-session.ts never
-- trusts a stale session's liveness either).
--
-- Gate matches refundClientPaymentAction's own established, narrower gate
-- (platform_admin/studio_owner/studio_admin -- NOT front_desk): voiding a
-- payment is the same class of sensitive financial action as issuing a
-- refund, not ordinary payment recording.
-- ============================================================================
create or replace function public.void_pending_package_payment(
  p_payment_id uuid,
  p_reason text
) returns table(voided boolean, package_deactivated boolean)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_client_package_id uuid;
  v_authorized boolean;
  v_deactivated boolean := false;
begin
  select studio_id into v_studio_id from public.payments where id = p_payment_id;

  if v_studio_id is null then
    raise exception 'Payment not found.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  ) or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = v_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to void payments for this studio.';
  end if;

  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to void a payment.';
  end if;

  update public.payments
    set status = 'voided',
        notes = coalesce(notes || E'\n', '') || format('VOIDED by %s at %s: %s', auth.uid(), now(), p_reason)
    where id = p_payment_id and status = 'pending'
    returning client_package_id into v_client_package_id;

  if not found then
    return query select false, false; -- already resolved (not pending) -- no-op
  end if;

  if v_client_package_id is not null then
    v_deactivated := public._reevaluate_and_deactivate_package_if_unsettled(
      v_client_package_id,
      format('Automatically deactivated: originating payment %s was voided before settling.', p_payment_id)
    );
  end if;

  return query select true, v_deactivated;
end;
$$;

revoke all on function public.void_pending_package_payment(uuid, text) from public;
revoke all on function public.void_pending_package_payment(uuid, text) from anon;
grant execute on function public.void_pending_package_payment(uuid, text) to authenticated;
revoke all on function public.void_pending_package_payment(uuid, text) from service_role;

-- ============================================================================
-- 7. _mark_package_payment_failed_and_reevaluate -- webhook-driven,
--    checkout.session.async_payment_failed.
--
-- service_role only -- invoked from the webhook handler (createAdminClient()
-- context), never staff-initiated. Same CAS + atomic re-evaluation shape as
-- void. A failure event carries no money -- 0-rows-affected here is always
-- a safe no-op (not a financial mismatch), never a conflict row.
-- ============================================================================
create or replace function public._mark_package_payment_failed_and_reevaluate(
  p_payment_id uuid,
  p_stripe_event_id text
) returns table(marked_failed boolean, package_deactivated boolean)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_client_package_id uuid;
  v_deactivated boolean := false;
begin
  update public.payments
    set status = 'failed',
        notes = coalesce(notes || E'\n', '') || format('Marked failed by Stripe event %s at %s.', p_stripe_event_id, now())
    where id = p_payment_id and status = 'pending'
    returning client_package_id into v_client_package_id;

  if not found then
    return query select false, false; -- already resolved -- safe no-op, no financial mismatch
  end if;

  if v_client_package_id is not null then
    v_deactivated := public._reevaluate_and_deactivate_package_if_unsettled(
      v_client_package_id,
      format('Automatically deactivated: originating payment %s was marked failed before settling.', p_payment_id)
    );
  end if;

  return query select true, v_deactivated;
end;
$$;

revoke all on function public._mark_package_payment_failed_and_reevaluate(uuid, text) from public, anon, authenticated;
grant execute on function public._mark_package_payment_failed_and_reevaluate(uuid, text) to service_role;

-- ============================================================================
-- 8. record_stale_payment_success_conflict -- webhook-driven.
--
-- Called from handleClientPaymentRequestCheckoutCompleted's stale branch
-- (checkout.session.completed / async_payment_succeeded arriving against a
-- payment that is no longer 'pending') AFTER the CAS update already
-- confirmed zero rows were touched -- this function never mutates
-- payments/client_packages itself, it only records the conflict. No
-- mutation of entitlement ever happens before this runs; the CAS is the
-- gate, this is purely the audit trail for what the CAS just correctly
-- refused to do.
-- ============================================================================
create or replace function public.record_stale_payment_success_conflict(
  p_payment_id uuid,
  p_stripe_event_id text,
  p_stripe_event_type text,
  p_stripe_session_id text
) returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_client_package_id uuid;
  v_current_status text;
begin
  select studio_id, client_package_id, status
    into v_studio_id, v_client_package_id, v_current_status
    from public.payments where id = p_payment_id;

  if v_studio_id is null then
    return;
  end if;

  -- Duplicate delivery of the same successful event (already 'paid') is
  -- not a mismatch -- ordinary webhook-replay idempotency, no conflict row.
  if v_current_status = 'paid' then
    return;
  end if;

  perform public._record_payment_settlement_conflict(
    v_studio_id, p_payment_id, v_client_package_id, p_stripe_event_id, p_stripe_event_type, p_stripe_session_id,
    format(
      'Stripe reported this payment succeeded (%s) at %s, after DanceFlow had already marked it ''%s''. The linked package remains inactive. Verify in Stripe whether money was actually captured, and reconcile manually.',
      p_stripe_event_type, now(), v_current_status
    )
  );
end;
$$;

revoke all on function public.record_stale_payment_success_conflict(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.record_stale_payment_success_conflict(uuid, text, text, text) to service_role;

-- ============================================================================
-- 9. _apply_payment_refund_and_reevaluate -- webhook-driven, replaces the
--    raw unguarded .update() loop in updatePaymentRefundByPaymentIntent.
--
-- service_role only. Legal prior state is 'paid' only -- a refund is only
-- meaningful against a payment that was actually captured (confirmed by
-- direct read: updatePaymentRefundByPaymentIntent today has NO status
-- filter at all, so it can silently overwrite an already-voided row's
-- status -- exactly the class of bug this migration exists to close).
-- Distinguishes three outcomes: applied (was 'paid', now refunded/still-
-- paid-with-partial-refund, re-evaluated); duplicate (current status
-- already matches what this event reports -- idempotent no-op); mismatch
-- (current status is something else entirely, e.g. 'voided' -- a genuine
-- financial mismatch, recorded, never silently overwritten).
-- ============================================================================
create or replace function public._apply_payment_refund_and_reevaluate(
  p_payment_id uuid,
  p_new_status text,
  p_refund_amount numeric,
  p_stripe_refund_id text,
  p_stripe_event_id text,
  p_stripe_event_type text
) returns table(applied boolean, package_deactivated boolean, conflict_recorded boolean)
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_client_package_id uuid;
  v_studio_id uuid;
  v_current_status text;
  v_deactivated boolean := false;
begin
  update public.payments
    set status = p_new_status, refund_amount = p_refund_amount, stripe_refund_id = p_stripe_refund_id
    where id = p_payment_id and status = 'paid'
    returning client_package_id, studio_id into v_client_package_id, v_studio_id;

  if found then
    if v_client_package_id is not null then
      v_deactivated := public._reevaluate_and_deactivate_package_if_unsettled(
        v_client_package_id,
        format('Automatically deactivated: originating payment %s was refunded.', p_payment_id)
      );
    end if;
    return query select true, v_deactivated, false;
  end if;

  select status, studio_id, client_package_id
    into v_current_status, v_studio_id, v_client_package_id
    from public.payments where id = p_payment_id;

  if v_current_status = p_new_status then
    return query select false, false, false; -- duplicate delivery, already applied
  end if;

  perform public._record_payment_settlement_conflict(
    v_studio_id, p_payment_id, v_client_package_id, p_stripe_event_id, p_stripe_event_type, null,
    format(
      'Stripe reported a refund (%s) at %s against a payment DanceFlow''s own record shows as ''%s'', not ''paid''. Verify in Stripe whether money was actually returned, and reconcile manually.',
      p_stripe_event_type, now(), v_current_status
    )
  );
  return query select false, false, true;
end;
$$;

revoke all on function public._apply_payment_refund_and_reevaluate(uuid, text, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public._apply_payment_refund_and_reevaluate(uuid, text, numeric, text, text, text) to service_role;

-- ============================================================================
-- 10. resolve_payment_settlement_conflict / add_payment_settlement_conflict_note
--     -- staff-facing conflict-queue actions. Same narrower gate as
--     void_pending_package_payment (refund-adjacent, not ordinary payment
--     recording). Neither ever touches payments/client_packages -- purely
--     bookkeeping closure of the review item; if the real-world fix means a
--     package should become usable again, that happens through the
--     existing, unmodified reactivation path (itself gated by the
--     corrected settlement predicate).
-- ============================================================================
create or replace function public.resolve_payment_settlement_conflict(
  p_conflict_id uuid,
  p_resolution_note text
) returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_authorized boolean;
begin
  select studio_id into v_studio_id from public.payment_settlement_conflicts where id = p_conflict_id;

  if v_studio_id is null then
    raise exception 'Conflict not found.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  ) or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = v_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to resolve payment reconciliation conflicts for this studio.';
  end if;

  if p_resolution_note is null or btrim(p_resolution_note) = '' then
    raise exception 'A resolution note is required to resolve a payment conflict.';
  end if;

  update public.payment_settlement_conflicts
    set status = 'resolved', resolved_by = auth.uid(), resolved_at = now(), resolution_note = p_resolution_note
    where id = p_conflict_id and status = 'pending_review';
end;
$$;

revoke all on function public.resolve_payment_settlement_conflict(uuid, text) from public;
revoke all on function public.resolve_payment_settlement_conflict(uuid, text) from anon;
grant execute on function public.resolve_payment_settlement_conflict(uuid, text) to authenticated;
revoke all on function public.resolve_payment_settlement_conflict(uuid, text) from service_role;

create or replace function public.add_payment_settlement_conflict_note(
  p_conflict_id uuid,
  p_note text
) returns void
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_studio_id uuid;
  v_authorized boolean;
begin
  select studio_id into v_studio_id from public.payment_settlement_conflicts where id = p_conflict_id;

  if v_studio_id is null then
    raise exception 'Conflict not found.';
  end if;

  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.platform_role = 'platform_admin'
  ) or exists (
    select 1 from public.user_studio_roles usr
    where usr.user_id = auth.uid()
      and usr.studio_id = v_studio_id
      and usr.role = any (array['studio_owner', 'studio_admin']::app_role[])
      and usr.active = true
  ) into v_authorized;

  if not v_authorized then
    raise exception 'Not authorized to annotate payment reconciliation conflicts for this studio.';
  end if;

  if p_note is null or btrim(p_note) = '' then
    raise exception 'Note text is required.';
  end if;

  update public.payment_settlement_conflicts
    set note = coalesce(note || E'\n', '') || format('%s (by %s at %s)', p_note, auth.uid(), now())
    where id = p_conflict_id;
end;
$$;

revoke all on function public.add_payment_settlement_conflict_note(uuid, text) from public;
revoke all on function public.add_payment_settlement_conflict_note(uuid, text) from anon;
grant execute on function public.add_payment_settlement_conflict_note(uuid, text) to authenticated;
revoke all on function public.add_payment_settlement_conflict_note(uuid, text) from service_role;

commit;
