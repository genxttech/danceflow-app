import type { FakeTable, Row } from "./simpleFakeAdminClient";

/**
 * In-memory stand-in for the PAY-WH-1 event-cart lifecycle database functions, for ROUTE-level unit tests that use
 * simpleFakeAdminClient. It mirrors the externally visible effects the routes rely on (attempt recording without
 * overwriting, two-phase release that frees holds exactly once). The authoritative behaviour (locking, binding,
 * amounts, guards) is tested against Postgres in sql-tests/test_T_paywh1_event_cart_settlement.sql and
 * sql-tests/paywh1_concurrency.sh.
 */

type Tables = Record<string, FakeTable>;

function rows(tables: Tables, name: string): Row[] {
  const table = tables[name] as unknown as { rows?: Row[] } | undefined;
  return table?.rows ?? [];
}

function ensureAttempts(tables: Tables): Row[] {
  const existing = tables.event_order_payment_attempts as unknown as { rows?: Row[] } | undefined;
  if (existing?.rows) return existing.rows;
  const created = { rows: [] as Row[] };
  (tables as Record<string, unknown>).event_order_payment_attempts = created;
  return created.rows;
}

function releaseOrder(tables: Tables, orderId: string, finalState: string) {
  const now = new Date().toISOString();
  for (const registration of rows(tables, "event_registrations")) {
    if (registration.order_id === orderId && registration.status === "pending") {
      registration.status = "cancelled";
      registration.payment_status = "failed";
      registration.cancelled_at = now;
    }
  }
  for (const slot of rows(tables, "event_private_lesson_slots")) {
    if (slot.order_id === orderId && slot.status === "held") {
      Object.assign(slot, {
        status: "available", payment_status: "unpaid", order_id: null, hold_token: null, held_until: null,
        buyer_name: null, buyer_email: null, buyer_phone: null, buyer_notes: null, stripe_checkout_session_id: null,
      });
    }
  }
  for (const attempt of ensureAttempts(tables)) {
    if (attempt.order_id === orderId && (attempt.status === "open" || attempt.status === "processing")) attempt.status = "closed";
  }
  const order = rows(tables, "event_orders").find((row) => row.id === orderId);
  if (order) {
    Object.assign(order, {
      status: finalState === "expired" ? "expired" : "cancelled",
      payment_status: "failed",
      cancelled_at: order.cancelled_at ?? now,
      settlement_state: finalState,
    });
  }
}

export function fakeCartLifecycleRpc(tables: Tables, fn: string, args: Record<string, unknown>) {
  const attempts = ensureAttempts(tables);
  const orders = rows(tables, "event_orders");
  switch (fn) {
    case "record_event_cart_payment_attempt": {
      const order = orders.find((row) => row.id === args.p_order_id);
      if (!order) return { data: null, error: { message: "paywh1_order_not_found", code: "P0002" } };
      const id = `attempt-${attempts.length + 1}`;
      attempts.push({
        id,
        order_id: order.id,
        kind: args.p_kind,
        stripe_account_id: args.p_stripe_account,
        stripe_checkout_session_id: args.p_session_id ?? null,
        stripe_payment_intent_id: args.p_kind === "payment_intent" ? args.p_payment_intent_id ?? null : null,
        amount_cents: args.p_amount_cents,
        currency: args.p_currency,
        surface: args.p_surface,
        status: "open",
        created_at: new Date().toISOString(),
      });
      if (!order.stripe_checkout_session_id && args.p_session_id) order.stripe_checkout_session_id = args.p_session_id;
      if (!order.stripe_payment_intent_id && args.p_kind === "payment_intent") order.stripe_payment_intent_id = args.p_payment_intent_id;
      return { data: { outcome: "recorded", attempt_id: id }, error: null };
    }
    case "extend_event_cart_order_hold": {
      // Test hook: a test can make the hold extension fail (e.g. the lapsed hold's capacity was taken).
      const forced = (tables as unknown as { __extendHoldResult?: unknown }).__extendHoldResult;
      if (forced) return { data: forced, error: null };
      const order = orders.find((row) => row.id === args.p_order_id);
      if (!order || order.status !== "pending" || order.payment_status !== "pending") {
        return { data: { ok: false, reason: "not_pending" }, error: null };
      }
      order.expires_at = args.p_until;
      return { data: { ok: true, expires_at: args.p_until }, error: null };
    }
    case "release_unattempted_event_cart_orders":
      return { data: 0, error: null };
    case "begin_event_cart_order_release": {
      const order = orders.find((row) => row.id === args.p_order_id);
      if (!order) return { data: { outcome: "not_found" }, error: null };
      if (order.payment_status === "paid") return { data: { outcome: "already_paid" }, error: null };
      if (order.status !== "pending") return { data: { outcome: "already_released" }, error: null };
      order.settlement_state = "releasing";
      const live = attempts
        .filter((attempt) => attempt.order_id === order.id && (attempt.status === "open" || attempt.status === "processing"))
        .map((attempt) => ({
          attempt_id: attempt.id,
          kind: attempt.kind,
          stripe_account_id: attempt.stripe_account_id,
          stripe_checkout_session_id: attempt.stripe_checkout_session_id,
          stripe_payment_intent_id: attempt.stripe_payment_intent_id,
          status: attempt.status,
        }));
      return { data: { outcome: "releasing", attempts: live }, error: null };
    }
    case "finalize_event_cart_order_release": {
      const order = orders.find((row) => row.id === args.p_order_id);
      if (!order) return { data: { outcome: "not_found" }, error: null };
      if (order.payment_status === "paid") return { data: { outcome: "already_paid" }, error: null };
      if (order.settlement_state !== "releasing") return { data: { outcome: "not_releasing" }, error: null };
      const findings = (args.p_findings ?? []) as Array<{ attempt_id: string; stripe_state: string }>;
      if (findings.some((finding) => finding.stripe_state === "paid")) return { data: { outcome: "payment_found" }, error: null };
      if (findings.some((finding) => finding.stripe_state === "open")) return { data: { outcome: "retry" }, error: null };
      releaseOrder(tables, String(order.id), String(args.p_final_state ?? "released"));
      return { data: { outcome: "released" }, error: null };
    }
    default:
      return { data: null, error: { message: `Unexpected rpc in fake db: ${fn}`, code: "PGRST202" } };
  }
}
