/**
 * CF1 database-backed settlement, layer 1: the REAL finalize_competition_registration / release_competition_registration SQL functions on an
 * isolated local Postgres (see scripts/qa/cf1-db-settlement.mjs). No Stripe, no hosted database, no secrets, no PostgREST.
 * Skipped unless CF1_DBQA_CONTAINER names a df-cf1r1-* container, so the normal unit run is unaffected.
 *
 * Scope: settlement functions only (never refunds, never competition rules). Orders are inserted directly in the settlement-relevant
 * state; the order-creation path is covered by sql-tests/test_T_phase10c_competitor_registration.sql.
 */
import { describe, expect, it, vi } from "vitest";
import { callRpc, dbQaEnabled, orderState, rows, seedOrder, type SeededOrder } from "./helpers/dockerPgAdmin";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const suite = dbQaEnabled ? describe : describe.skip;

// event_orders.stripe_payment_intent_id is globally unique, so every order gets its own PaymentIntent id.
const piOf = (o: SeededOrder) => `pi_${(o.sessionId ?? "x").replace(/^cs_test_/, "")}`;
const finalize = (o: SeededOrder, over: Partial<{ order: string; account: string | null; session: string | null; pi: string | null; cents: number | null; currency: string | null }> = {}) =>
  callRpc("finalize_competition_registration", {
    p_order_id: over.order ?? o.orderId,
    p_stripe_account_id: over.account === undefined ? o.accountId : over.account,
    p_checkout_session_id: over.session === undefined ? o.sessionId : over.session,
    p_payment_intent_id: over.pi === undefined ? piOf(o) : over.pi,
    p_amount_cents: over.cents === undefined ? o.totalCents : over.cents,
    p_currency: over.currency === undefined ? "USD" : over.currency,
  });
const release = (o: SeededOrder, reason: string, over: Partial<{ session: string | null; account: string | null }> = {}) =>
  callRpc("release_competition_registration", {
    p_order_id: o.orderId,
    p_reason: reason,
    p_checkout_session_id: over.session === undefined ? o.sessionId : over.session,
    p_stripe_account_id: over.account === undefined ? o.accountId : over.account,
  });
const outcome = (r: { data: unknown }) => (r.data as { outcome?: string } | null)?.outcome;

async function untouched(o: SeededOrder) {
  const s = await orderState(o.orderId);
  expect(s).toMatchObject({ status: "pending", payment_status: "pending", payments: 0, paid_at: null, stripe_payment_intent_id: null });
}

suite("CF1 settlement SQL (real Postgres): finalize_competition_registration", () => {
  it("a bound, correctly priced payment finalizes the order and registration and records the payment exactly once", async () => {
    const o = await seedOrder();
    const r = await finalize(o);
    expect(r.error).toBeNull();
    expect(outcome(r)).toBe("finalized");
    const s = await orderState(o.orderId);
    expect(s).toMatchObject({ status: "confirmed", payment_status: "paid", stripe_payment_intent_id: piOf(o), expires_at: null, reg_status: "confirmed", reg_payment_status: "paid", payments: 1 });
    expect(s.paid_at).not.toBeNull();
    const [payment] = await rows<{ amount: string; currency: string; status: string; stripe_checkout_session_id: string; stripe_account_id: string }>(
      `select p.amount, p.currency, p.status, p.stripe_checkout_session_id, p.stripe_account_id from public.event_payments p join public.event_registrations r on r.id = p.registration_id where r.order_id = '${o.orderId}'`);
    expect(payment).toMatchObject({ currency: "USD", status: "paid", stripe_checkout_session_id: o.sessionId, stripe_account_id: o.accountId });
    expect(Number(payment.amount)).toBe(103.3);
  });

  it("the webhook's lower-case currency is accepted (comparison is case-insensitive)", async () => {
    const o = await seedOrder({ totalCents: 2500 });
    expect(outcome(await finalize(o, { currency: "usd" }))).toBe("finalized");
  });

  it("replay is idempotent: already_finalized, still one payment row, state unchanged", async () => {
    const o = await seedOrder();
    expect(outcome(await finalize(o))).toBe("finalized");
    const first = await orderState(o.orderId);
    expect(outcome(await finalize(o))).toBe("already_finalized");
    expect(outcome(await finalize(o, { pi: `${piOf(o)}_other` }))).toBe("already_finalized");
    const again = await orderState(o.orderId);
    expect(again).toEqual(first);
    expect(again.payments).toBe(1);
  });

  it("refuses a checkout session that is not the one bound to the order, and the order stays untouched", async () => {
    const o = await seedOrder();
    const r = await finalize(o, { session: "cs_test_forged" });
    expect(r.error?.message).toMatch(/COMP10C_BINDING_MISMATCH.*checkout session/);
    await untouched(o);
  });

  it("refuses a session bound to a DIFFERENT order (cross-order replay)", async () => {
    const a = await seedOrder();
    const b = await seedOrder();
    const r = await finalize(a, { session: b.sessionId });
    expect(r.error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(a);
    await untouched(b);
  });

  it("refuses a payment on another connected account, and an order with no stored account", async () => {
    const o = await seedOrder();
    expect((await finalize(o, { account: "acct_someoneElse" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH.*account/);
    expect((await finalize(o, { account: null })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(o);
    const noAccount = await seedOrder({ accountId: null });
    expect((await finalize(noAccount, { account: "acct_x" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(noAccount);
  });

  it("refuses an order that has no bound session at all", async () => {
    const o = await seedOrder({ sessionId: null });
    expect((await finalize(o, { session: "cs_test_unbound" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(o);
  });

  it("refuses any amount or currency that differs from the price snapshot (one cent, one unit, wrong currency)", async () => {
    const o = await seedOrder();
    for (const cents of [o.totalCents - 1, o.totalCents + 1, 1, 0]) {
      expect((await finalize(o, { cents })).error?.message, `cents=${cents}`).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    }
    expect((await finalize(o, { currency: "EUR" })).error?.message).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    expect((await finalize(o, { currency: null })).error?.message).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    expect((await finalize(o, { cents: null })).error?.message).toMatch(/COMP10C_AMOUNT_MISMATCH/);
    await untouched(o);
  });

  it("refuses a missing or malformed PaymentIntent id", async () => {
    const o = await seedOrder();
    for (const pi of [null, "", "py_123", "pi_ bad"]) {
      expect((await finalize(o, { pi })).error?.message, String(pi)).toMatch(/COMP10C_BINDING_INVALID/);
    }
    await untouched(o);
  });

  it("a paid order can never be finalized without provider evidence; unknown and non-competition orders are not found", async () => {
    const o = await seedOrder();
    expect((await finalize(o, { session: null, account: null, pi: null, cents: null, currency: null })).error?.message).toMatch(/COMP10C_SETTLEMENT_REQUIRED/);
    await untouched(o);
    expect((await finalize(o, { order: "00000000-0000-4000-8000-00000000dead" })).error?.message).toMatch(/COMP10C_ORDER_NOT_FOUND/);
    const ordinary = await seedOrder({ source: null });
    expect((await finalize(ordinary)).error?.message).toMatch(/COMP10C_ORDER_NOT_FOUND/);
    expect((await orderState(ordinary.orderId)).payments).toBe(0);
  });

  it("a late payment after release is recorded for review but never reactivates the order; repeats are already_recorded", async () => {
    const o = await seedOrder();
    expect(outcome(await release(o, "expired"))).toBe("released");
    const released = await orderState(o.orderId);
    expect(released).toMatchObject({ status: "expired", payment_status: "unpaid", payments: 0 });
    expect(outcome(await finalize(o))).toBe("late_payment_after_release");
    const late = await orderState(o.orderId);
    expect(late).toMatchObject({ status: "expired", payment_status: "paid", payments: 1, stripe_payment_intent_id: piOf(o) });
    expect(late.metadata.needs_review).toBe("late_payment_after_release");
    expect(late.reg_status).toBe("cancelled");
    expect(outcome(await finalize(o))).toBe("already_recorded");
    expect((await orderState(o.orderId)).payments).toBe(1);
    expect(outcome(await release(o, "expired"))).toBe("already_paid");
  });

  it("a paid-but-unsigned order records the money and stays pending (signing_incomplete_payment_recorded), exactly once", async () => {
    const o = await seedOrder({ requiresSigning: true });
    expect(outcome(await finalize(o))).toBe("signing_incomplete_payment_recorded");
    const s = await orderState(o.orderId);
    expect(s).toMatchObject({ status: "pending", payment_status: "paid", payments: 1 });
    expect(s.metadata.needs_review).toBe("signing_incomplete_payment_recorded");
    expect(outcome(await finalize(o))).toBe("already_recorded");
    expect((await orderState(o.orderId)).payments).toBe(1);
  });

  it("free order: finalizes with no provider evidence and records no payment; replay is already_finalized", async () => {
    const o = await seedOrder({ totalCents: 0, sessionId: null, accountId: null });
    const r = await finalize(o, { session: null, account: null, pi: null, cents: null, currency: null });
    expect(outcome(r)).toBe("finalized");
    expect(await orderState(o.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", reg_status: "confirmed", payments: 0 });
    expect(outcome(await finalize(o, { session: null, account: null, pi: null, cents: null, currency: null }))).toBe("already_finalized");
  });

  it("free order: refused when signing is incomplete or when the order is no longer pending", async () => {
    const unsigned = await seedOrder({ totalCents: 0, sessionId: null, accountId: null, requiresSigning: true });
    const none = { session: null, account: null, pi: null, cents: null, currency: null } as const;
    expect((await finalize(unsigned, none)).error?.message).toMatch(/COMP10C_SIGNING_INCOMPLETE/);
    expect((await orderState(unsigned.orderId)).status).toBe("pending");
    const gone = await seedOrder({ totalCents: 0, sessionId: null, accountId: null });
    expect(outcome(await release(gone, "abandoned", { session: null, account: null }))).toBe("released");
    expect((await finalize(gone, none)).error?.message).toMatch(/COMP10C_ORDER_NOT_PAYABLE/);
  });

  it("release/finalize functions are executable by service_role only (catalog check; no denied call is made)", async () => {
    const sigs = ["finalize_competition_registration(uuid,text,text,text,bigint,text)", "release_competition_registration(uuid,text,text,text)"];
    for (const sig of sigs) {
      const [row] = await rows<{ anon: boolean; authenticated: boolean; service: boolean }>(
        `select has_function_privilege('anon', 'public.${sig}', 'execute') as anon, has_function_privilege('authenticated', 'public.${sig}', 'execute') as authenticated, has_function_privilege('service_role', 'public.${sig}', 'execute') as service`);
      expect(row).toEqual({ anon: false, authenticated: false, service: true });
    }
  });
});

suite("CF1 settlement SQL (real Postgres): release_competition_registration", () => {
  it("expired / failed / abandoned releases set the documented states and withdraw the pending registration", async () => {
    const cases: Array<[string, string, string, string]> = [
      ["expired", "released", "expired", "unpaid"],
      ["failed", "released", "cancelled", "failed"],
      ["abandoned", "released", "cancelled", "unpaid"],
      ["attach_failed", "released", "cancelled", "unpaid"],
      ["signing_expired", "released", "expired", "unpaid"],
    ];
    for (const [reason, want, status, payment] of cases) {
      const o = await seedOrder();
      expect(outcome(await release(o, reason)), reason).toBe(want);
      expect(await orderState(o.orderId), reason).toMatchObject({ status, payment_status: payment, reg_status: "cancelled", payments: 0 });
    }
  });

  it("is idempotent (already_released) and refuses to release a paid order (already_paid) without changing it", async () => {
    const o = await seedOrder();
    expect(outcome(await release(o, "expired"))).toBe("released");
    const first = await orderState(o.orderId);
    expect(outcome(await release(o, "failed"))).toBe("already_released");
    expect(await orderState(o.orderId)).toEqual(first);

    const paid = await seedOrder();
    expect(outcome(await finalize(paid))).toBe("finalized");
    const before = await orderState(paid.orderId);
    expect(outcome(await release(paid, "expired"))).toBe("already_paid");
    expect(await orderState(paid.orderId)).toEqual(before);
  });

  it("a provider-originated release must name the bound session and account", async () => {
    const o = await seedOrder();
    expect((await release(o, "expired", { session: "cs_test_forged" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    expect((await release(o, "expired", { account: "acct_someoneElse" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(o);
    const unbound = await seedOrder({ sessionId: null });
    expect((await release(unbound, "expired", { session: "cs_test_any" })).error?.message).toMatch(/COMP10C_BINDING_MISMATCH/);
    await untouched(unbound);
  });

  it("rejects an unknown reason and a non-competition order", async () => {
    const o = await seedOrder();
    expect((await release(o, "because")).error?.message).toMatch(/COMP10C_INVALID/);
    const ordinary = await seedOrder({ source: null });
    expect((await release(ordinary, "expired")).error?.message).toMatch(/COMP10C_ORDER_NOT_FOUND/);
    await untouched(o);
  });
});

suite("CF1 settlement SQL (real Postgres): concurrent connections", () => {
  it("six simultaneous identical finalize calls (six backends): exactly one 'finalized', the rest 'already_finalized', one payment row", async () => {
    const o = await seedOrder();
    const results = await Promise.all(Array.from({ length: 6 }, () => finalize(o)));
    expect(results.map((r) => r.error)).toEqual(Array(6).fill(null));
    const outcomes = results.map(outcome).sort();
    expect(outcomes.filter((x) => x === "finalized")).toHaveLength(1);
    expect(outcomes.filter((x) => x === "already_finalized")).toHaveLength(5);
    expect(await orderState(o.orderId)).toMatchObject({ status: "confirmed", payment_status: "paid", payments: 1 });
  });

  it("simultaneous finalize with DIFFERENT PaymentIntent ids still records one payment (first writer wins, the other is already_finalized)", async () => {
    const o = await seedOrder();
    const results = await Promise.all([finalize(o, { pi: `${piOf(o)}_a` }), finalize(o, { pi: `${piOf(o)}_b` }), finalize(o, { pi: `${piOf(o)}_a` })]);
    expect(results.map((r) => r.error)).toEqual([null, null, null]);
    expect(results.map(outcome).filter((x) => x === "finalized")).toHaveLength(1);
    expect((await orderState(o.orderId)).payments).toBe(1);
  });

  it("finalize racing release (ten rounds): the money is recorded exactly once and the order never ends confirmed-but-cancelled", async () => {
    const seen = new Set<string>();
    for (let round = 0; round < 10; round += 1) {
      const o = await seedOrder();
      const [f, r] = await Promise.all([finalize(o), release(o, "expired")]);
      expect(f.error).toBeNull();
      expect(r.error).toBeNull();
      const s = await orderState(o.orderId);
      expect(s.payments).toBe(1);
      expect(s.payment_status).toBe("paid");
      if (outcome(f) === "finalized") {
        expect(outcome(r)).toBe("already_paid");
        expect(s.status).toBe("confirmed");
        seen.add("finalize-first");
      } else {
        expect(outcome(f)).toBe("late_payment_after_release");
        expect(outcome(r)).toBe("released");
        expect(s.status).toBe("expired");
        expect(s.metadata.needs_review).toBe("late_payment_after_release");
        seen.add("release-first");
      }
    }
    // Both interleavings are legal and the scheduler picks; every round above asserted its own invariants. Which ones occurred is informational only.
    console.info("finalize/release race interleavings seen:", [...seen].join(", "));
  });
});
