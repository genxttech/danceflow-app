/*
  REFUND-RECON-1 test double: the CONTRACT of the repaired canonical refund
  reconciliation RPC public._apply_payment_refund_and_reevaluate (+ its
  internal helper _sync_group_class_purchase_refund), as proven against
  Postgres by sql-tests/test_T_refund_reconciliation_integrity.sql and
  test_T_refund_reconciliation_timestamp.sql (body md5 6867f57d / bd861352,
  live on DEV and PROD). Application tests use it to show
  WHAT the app passes and that it relies on the RPC for every business effect;
  the SQL suite is the authority on the behaviour itself.

    - only 'paid' (partial) / 'refunded' (full); amount >= 0 (cumulative);
    - CAS on status 'paid'; cumulative refund never lowered; a same-amount
      partial is a duplicate; a null refund id never erases a stored one;
    - applied refund progress sets refunded_at = greatest(refunded_at, now())
      (REFUND-RECON-2); replays and stale events never touch it;
    - package-linked: settlement re-evaluation (deactivate when net paid < price);
    - group_class_direct_payment: enrollment effect through the CONVERTED hold
      of the same studio (full + no attended/no_show -> cancelled + refunded;
      full after attendance -> payment_status refunded only; partial ->
      'partial', still booked); runs on duplicates too (converges);
    - stale partial after a full refund -> no-op; any other unexpected status
      -> settlement-conflict record (conflict_recorded).
*/

export type Row = Record<string, unknown>;

export type RefundRpcState = {
  payments: Row[];
  holds?: Row[];
  attendees?: Row[];
  attendance?: Row[];
  packages?: Row[];
  conflicts?: Row[];
};

export type RefundRpcCall = {
  p_payment_id: string;
  p_new_status: string;
  p_refund_amount: number;
  p_stripe_refund_id: string | null;
  p_stripe_event_id: string;
  p_stripe_event_type: string;
};

/** The RPC transaction time (now()); overridable so tests can tell an RPC write from a stale value. */
export let REFUND_RPC_NOW = () => new Date().toISOString();
export function setRefundRpcNow(fn: () => string) {
  REFUND_RPC_NOW = fn;
}

const cents = (value: unknown) => Math.round(Number(value ?? 0) * 100);

function syncGroupClass(state: RefundRpcState, payment: Row, fullyRefunded: boolean) {
  const hold = (state.holds ?? []).find(
    (h) => h.payment_id === payment.id && h.status === "converted" && h.studio_id === payment.studio_id,
  );
  if (!hold?.attendee_id) return "no_enrollment";
  const attendee = (state.attendees ?? []).find(
    (a) =>
      a.id === hold.attendee_id &&
      a.studio_id === payment.studio_id &&
      a.appointment_id === hold.appointment_id &&
      a.client_id === hold.client_id,
  );
  if (!attendee) return "no_enrollment";
  if (!fullyRefunded) {
    if (attendee.status === "booked" && attendee.payment_status !== "partial" && attendee.payment_status !== "refunded") {
      attendee.payment_status = "partial";
      return "partial";
    }
    return "unchanged";
  }
  const attendanceRecorded = (state.attendance ?? []).some(
    (r) =>
      r.appointment_id === hold.appointment_id &&
      r.client_id === hold.client_id &&
      (r.status === "attended" || r.status === "no_show"),
  );
  if (attendee.status === "booked" && !attendanceRecorded) {
    Object.assign(attendee, { status: "cancelled", cancelled_at: "now", payment_status: "refunded" });
    return "cancelled";
  }
  if (attendee.payment_status !== "refunded") {
    attendee.payment_status = "refunded";
    return "refunded_enrollment_kept";
  }
  return "unchanged";
}

function reevaluatePackage(state: RefundRpcState, packageId: unknown) {
  const pkg = (state.packages ?? []).find((p) => p.id === packageId);
  if (!pkg || pkg.active !== true) return false;
  const net = state.payments
    .filter((p) => p.client_package_id === packageId && (p.status === "paid" || p.status === "refunded"))
    .reduce((sum, p) => sum + cents(p.amount) - cents(p.refund_amount), 0);
  if (net >= cents(pkg.price)) return false;
  pkg.active = false;
  return true;
}

/** Applies one RPC call to `state` exactly as the repaired SQL contract does. */
export function applyRefundReconciliation(state: RefundRpcState, args: RefundRpcCall) {
  if (args.p_new_status !== "paid" && args.p_new_status !== "refunded") {
    return { data: null, error: { message: "REFUND_RECON_INVALID_STATUS: refund reconciliation accepts only paid or refunded." } };
  }
  if (args.p_refund_amount == null || !(Number(args.p_refund_amount) >= 0)) {
    return { data: null, error: { message: "REFUND_RECON_INVALID_AMOUNT: refund amount must be a non-negative cumulative amount." } };
  }
  const payment = state.payments.find((p) => p.id === args.p_payment_id);
  const amount = cents(args.p_refund_amount);
  const stored = cents(payment?.refund_amount);

  if (
    payment &&
    payment.status === "paid" &&
    stored <= amount &&
    (args.p_new_status === "refunded" || stored < amount)
  ) {
    payment.status = args.p_new_status;
    payment.refund_amount = amount / 100;
    payment.stripe_refund_id = args.p_stripe_refund_id ?? payment.stripe_refund_id ?? null;
    const now = REFUND_RPC_NOW();
    payment.refunded_at = payment.refunded_at && String(payment.refunded_at) > now ? payment.refunded_at : now;
    let deactivated = false;
    if (payment.client_package_id) deactivated = reevaluatePackage(state, payment.client_package_id);
    if (payment.payment_type === "group_class_direct_payment") syncGroupClass(state, payment, args.p_new_status === "refunded");
    return { data: [{ applied: true, package_deactivated: deactivated, conflict_recorded: false }], error: null };
  }

  if (
    payment &&
    (payment.status === args.p_new_status ||
      (payment.status === "refunded" && args.p_new_status === "paid" && stored >= amount))
  ) {
    if (payment.payment_type === "group_class_direct_payment") syncGroupClass(state, payment, payment.status === "refunded");
    return { data: [{ applied: false, package_deactivated: false, conflict_recorded: false }], error: null };
  }

  state.conflicts ??= [];
  if (!state.conflicts.some((c) => c.stripe_event_id === args.p_stripe_event_id)) {
    state.conflicts.push({ payment_id: args.p_payment_id, stripe_event_id: args.p_stripe_event_id, stripe_event_type: args.p_stripe_event_type });
  }
  return { data: [{ applied: false, package_deactivated: false, conflict_recorded: true }], error: null };
}
