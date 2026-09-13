-- Rollback for 20260913091100_pkgp1_package_payment_activation_integrity.sql
--
-- Preservation-first: payment_settlement_conflicts is financial
-- reconciliation/audit data. Aborts if any row already exists, rather than
-- silently discarding it -- matching this codebase's established posture
-- for exactly this class of table (GC-3.1's roster_capacity guard, GC-3.2's
-- group_class_enrollment_policies guard, both this session).
--
-- Functions drop first (nothing else depends on them), table last, reached
-- only if the emptiness guard passes -- dependency-safe order.
--
-- IMPORTANT PRECONDITION: only run this together with reverting any
-- application code that depends on these functions existing (entitlement.ts,
-- the client actions, the webhook handlers, terminal-fulfillment.ts) --
-- running it while that code is still live will break on "function does not
-- exist" errors.

begin;

do $$
begin
  if exists (select 1 from public.payment_settlement_conflicts limit 1) then
    raise exception 'Cannot roll back payment_settlement_conflicts: conflict rows already exist. Reconcile/export them before rolling back, or skip this revert and keep the table in place.';
  end if;
end;
$$;

drop function if exists public.add_payment_settlement_conflict_note(uuid, text);
drop function if exists public.resolve_payment_settlement_conflict(uuid, text);
drop function if exists public._apply_payment_refund_and_reevaluate(uuid, text, numeric, text, text, text);
drop function if exists public.record_stale_payment_success_conflict(uuid, text, text, text);
drop function if exists public._mark_package_payment_failed_and_reevaluate(uuid, text);
drop function if exists public.void_pending_package_payment(uuid, text);
drop function if exists public._record_payment_settlement_conflict(uuid, uuid, uuid, text, text, text, text);
drop function if exists public._reevaluate_and_deactivate_package_if_unsettled(uuid, text);
-- PKG-P1 §14: would_package_remain_settled_without_payment calls
-- _package_payment_settled, so drop it first.
drop function if exists public.would_package_remain_settled_without_payment(uuid);
drop function if exists public.is_package_payment_settled(uuid);
drop function if exists public._package_payment_settled(uuid, uuid);

drop table if exists public.payment_settlement_conflicts; -- only reached if the guard above passed (table empty)

commit;
