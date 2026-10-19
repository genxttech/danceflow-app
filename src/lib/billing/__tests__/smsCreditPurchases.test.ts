import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  createSmsCreditCheckout,
  handleSmsCreditStripeEvent,
  isSmsCreditPack,
  SmsCreditError,
  smsCreditPurchasesEnabled,
  SMS_CREDIT_PACKS_CENTS,
  type SmsCreditAdmin,
} from "../smsCreditPurchases";

/** TW-4F-3b-pay: checkout creation and webhook event handling with SYNTHETIC Stripe objects and a recording fake database. Nothing here reaches Stripe. */

const ENTITY = "e0000000-0000-4000-8000-0000000000e1";
const STUDIO = "a0000000-0000-4000-8000-00000000000a";
const OTHER_STUDIO = "a0000000-0000-4000-8000-00000000000b";
const USER = "b0000000-0000-4000-8000-000000000001";
const SESSION = "cs_test_synthetic_1";
const PI = "pi_test_synthetic_1";

type Call = { fn: string; args: Record<string, unknown> };
function fakeAdmin(results: Record<string, unknown | ((args: Record<string, unknown>) => { data?: unknown; error?: { code: string } })> = {}) {
  const calls: Call[] = [];
  const admin: SmsCreditAdmin = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      const r = results[fn];
      if (typeof r === "function") {
        const out = (r as (a: Record<string, unknown>) => { data?: unknown; error?: { code: string } })(args);
        return { data: out.data ?? null, error: out.error ?? null };
      }
      return { data: r ?? null, error: null };
    },
  };
  return { admin, calls, fns: () => calls.map((c) => c.fn) };
}

function fakeStripe(options: { createFails?: boolean; noUrl?: boolean } = {}) {
  const created: { params: Stripe.Checkout.SessionCreateParams; opts: unknown }[] = [];
  const expired: string[] = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams, opts: unknown) => {
          if (options.createFails) throw new Error("stripe down");
          created.push({ params, opts });
          return { id: SESSION, url: options.noUrl ? null : "https://checkout.stripe.test/c/pay/cs_test_synthetic_1" } as Stripe.Checkout.Session;
        },
        expire: async (id: string) => {
          expired.push(id);
          return {} as Stripe.Checkout.Session;
        },
      },
    },
  } as unknown as Pick<Stripe, "checkout">;
  return { stripe, created, expired };
}

const context = { tw4_credit_checkout_context: { legal_entity_id: ENTITY } };

describe("pack and flag rules", () => {
  it("accepts exactly the $25, $50 and $100 packs", () => {
    expect([...SMS_CREDIT_PACKS_CENTS]).toEqual([2500, 5000, 10000]);
    for (const bad of [0, 1, 2499, 2501, 3000, 7500, 10001, 50000, -2500, Number.NaN, "5000", null, undefined]) expect(isSmsCreditPack(bad), String(bad)).toBe(false);
    for (const good of [2500, 5000, 10000]) expect(isSmsCreditPack(good)).toBe(true);
  });
  it("purchases are off unless explicitly switched on", () => {
    expect(smsCreditPurchasesEnabled({})).toBe(false);
    expect(smsCreditPurchasesEnabled({ SMS_CREDIT_PURCHASES: "off" })).toBe(false);
    expect(smsCreditPurchasesEnabled({ SMS_CREDIT_PURCHASES: "true" })).toBe(false);
    expect(smsCreditPurchasesEnabled({ SMS_CREDIT_PURCHASES: "on" })).toBe(true);
  });
});

describe("createSmsCreditCheckout", () => {
  const input = (admin: SmsCreditAdmin, stripe: Pick<Stripe, "checkout">, packCents = 5000) => ({ admin, stripe, studioId: STUDIO, userId: USER, packCents, appUrl: "https://www.idanceflow.com/", now: new Date("2026-10-19T12:00:00Z") });

  it("authorizes in the database first, creates ONE card payment-mode session with no saved method, and registers it as pending with the same expiry", async () => {
    const { admin, calls } = fakeAdmin(context);
    const { stripe, created } = fakeStripe();
    const result = await createSmsCreditCheckout(input(admin, stripe));
    expect(result).toMatchObject({ sessionId: SESSION, url: expect.stringContaining("checkout.stripe.test"), expiresAt: "2026-10-19T12:35:00.000Z" });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_credit_checkout_context", "tw4_credit_topup_pending"]);
    expect(calls[0].args).toEqual({ p_studio_id: STUDIO, p_user_id: USER });
    expect(calls[1].args).toEqual({ p_entity_id: ENTITY, p_paid_by_studio_id: STUDIO, p_provider_ref: SESSION, p_amount_cents: 5000, p_expires_at: "2026-10-19T12:35:00.000Z" });
    const [{ params }] = created;
    expect(params.mode).toBe("payment");
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.line_items).toEqual([{ quantity: 1, price_data: { currency: "usd", unit_amount: 5000, product_data: { name: "DanceFlow SMS credit $50" } } }]);
    expect(params.expires_at).toBe(Math.floor(new Date("2026-10-19T12:35:00Z").getTime() / 1000));
    expect(params.metadata).toEqual({ df_purpose: "sms_credit_topup", legal_entity_id: ENTITY, studio_id: STUDIO, pack_cents: "5000" });
    expect(params.payment_intent_data).toEqual({ metadata: params.metadata });
    // nothing that could save a card, create a customer, subscribe, or charge again
    expect(params).not.toHaveProperty("customer");
    expect(params).not.toHaveProperty("customer_creation");
    expect(params).not.toHaveProperty("subscription_data");
    expect(params.payment_intent_data).not.toHaveProperty("setup_future_usage");
    expect(JSON.stringify(params)).not.toMatch(/setup_future_usage|subscription|off_session/);
    expect(params.success_url).toBe("https://www.idanceflow.com/app/settings/sms?credit=success");
  });

  it("an amount outside the packs never reaches the database or Stripe", async () => {
    for (const bad of [0, 2501, 3000, 12345, 50000, Number.NaN]) {
      const { admin, calls } = fakeAdmin(context);
      const { stripe, created } = fakeStripe();
      await expect(createSmsCreditCheckout(input(admin, stripe, bad))).rejects.toMatchObject({ code: "invalid_pack" });
      expect(calls).toHaveLength(0);
      expect(created).toHaveLength(0);
    }
  });

  it("a user who is not an owner or administrator, or a studio without a verified legal business, gets nothing: no Stripe call, no pending row", async () => {
    for (const [code, expected] of [["42501", "not_authorized"], ["TW010", "no_legal_business"], ["57014", "unavailable"]] as const) {
      const { admin, fns } = fakeAdmin({ tw4_credit_checkout_context: () => ({ error: { code } }) });
      const { stripe, created } = fakeStripe();
      await expect(createSmsCreditCheckout(input(admin, stripe))).rejects.toMatchObject({ code: expected });
      expect(created).toHaveLength(0);
      expect(fns()).toEqual(["tw4_credit_checkout_context"]);
    }
  });

  it("when the $500 ceiling would be exceeded the session is expired at once and the user is told why", async () => {
    const { admin } = fakeAdmin({ ...context, tw4_credit_topup_pending: () => ({ error: { code: "TW009" } }) });
    const { stripe, expired } = fakeStripe();
    const error = await createSmsCreditCheckout(input(admin, stripe)).catch((e) => e as SmsCreditError);
    expect(error).toBeInstanceOf(SmsCreditError);
    expect((error as SmsCreditError).code).toBe("ceiling");
    expect((error as SmsCreditError).message).toMatch(/\$500/);
    expect(expired).toEqual([SESSION]);
  });

  it("a failed registration for any other reason also expires the session; a Stripe failure registers nothing", async () => {
    const failing = fakeAdmin({ ...context, tw4_credit_topup_pending: () => ({ error: { code: "57014" } }) });
    const a = fakeStripe();
    await expect(createSmsCreditCheckout(input(failing.admin, a.stripe))).rejects.toMatchObject({ code: "unavailable" });
    expect(a.expired).toEqual([SESSION]);
    const ok = fakeAdmin(context);
    const b = fakeStripe({ createFails: true });
    await expect(createSmsCreditCheckout(input(ok.admin, b.stripe))).rejects.toMatchObject({ code: "unavailable" });
    expect(ok.fns()).toEqual(["tw4_credit_checkout_context"]);
    const c = fakeStripe({ noUrl: true });
    const noUrl = fakeAdmin(context);
    await expect(createSmsCreditCheckout(input(noUrl.admin, c.stripe))).rejects.toMatchObject({ code: "unavailable" });
    expect(c.expired).toEqual([SESSION]);
    expect(noUrl.fns()).toEqual(["tw4_credit_checkout_context"]);
  });
});

function event(type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}): Stripe.Event {
  return { id: `evt_${type.replace(/\W/g, "_")}`, object: "event", type, data: { object }, ...extra } as unknown as Stripe.Event;
}
const topup = (over: Record<string, unknown> = {}) => ({
  topup_id: "t1", legal_entity_id: ENTITY, paid_by_studio_id: STUDIO, status: "pending", amount_cents: 5000, provider_ref: SESSION, payment_intent_ref: null, ...over,
});
const paidSession = (over: Record<string, unknown> = {}) => ({
  id: SESSION, object: "checkout.session", mode: "payment", currency: "usd", amount_total: 5000, payment_status: "paid", payment_intent: PI,
  metadata: { df_purpose: "sms_credit_topup", legal_entity_id: ENTITY, studio_id: STUDIO, pack_cents: "5000" }, ...over,
});

describe("handleSmsCreditStripeEvent: checkout sessions", () => {
  it("a paid session settles exactly the registered purchase, with the PaymentIntent, requiring the pending registration", async () => {
    const { admin, calls } = fakeAdmin({ tw4_credit_topup_lookup: topup() });
    const result = await handleSmsCreditStripeEvent({ admin, event: event("checkout.session.completed", paidSession()) });
    expect(result).toEqual({ handled: true });
    expect(calls.map((c) => c.fn)).toEqual(["tw4_credit_topup_lookup", "tw4_credit_settle_topup"]);
    expect(calls[1].args).toEqual({
      p_entity_id: ENTITY, p_paid_by_studio_id: STUDIO, p_provider_ref: SESSION, p_amount_cents: 5000, p_event_id: "evt_checkout_session_completed", p_payment_intent: PI, p_require_pending: true,
    });
  });

  it("async_payment_succeeded settles too; an unpaid (delayed) completion settles nothing yet", async () => {
    const a = fakeAdmin({ tw4_credit_topup_lookup: topup() });
    await handleSmsCreditStripeEvent({ admin: a.admin, event: event("checkout.session.async_payment_succeeded", paidSession()) });
    expect(a.fns()).toContain("tw4_credit_settle_topup");
    const b = fakeAdmin({ tw4_credit_topup_lookup: topup() });
    expect(await handleSmsCreditStripeEvent({ admin: b.admin, event: event("checkout.session.completed", paidSession({ payment_status: "unpaid" })) })).toEqual({ handled: true });
    expect(b.fns()).toEqual(["tw4_credit_topup_lookup"]);
  });

  it("anything that does not match the registered purchase credits nothing and fails loudly (so Stripe retries and an operator sees it)", async () => {
    const cases: Record<string, Record<string, unknown>> = {
      "amount not a pack": { amount_total: 3000 },
      "amount differs from the registered pack": { amount_total: 10000 },
      "wrong currency": { currency: "eur" },
      "subscription mode": { mode: "subscription" },
      "no payment intent": { payment_intent: null },
      "metadata names another business": { metadata: { df_purpose: "sms_credit_topup", legal_entity_id: "e0000000-0000-4000-8000-0000000000e2", studio_id: STUDIO, pack_cents: "5000" } },
      "metadata names another location": { metadata: { df_purpose: "sms_credit_topup", legal_entity_id: ENTITY, studio_id: OTHER_STUDIO, pack_cents: "5000" } },
      "metadata pack differs": { metadata: { df_purpose: "sms_credit_topup", legal_entity_id: ENTITY, studio_id: STUDIO, pack_cents: "10000" } },
      "payment_status no_payment_required": { payment_status: "no_payment_required" },
    };
    for (const [label, over] of Object.entries(cases)) {
      const { admin, fns } = fakeAdmin({ tw4_credit_topup_lookup: topup() });
      await expect(handleSmsCreditStripeEvent({ admin, event: event("checkout.session.completed", paidSession(over)) }), label).rejects.toBeInstanceOf(SmsCreditError);
      expect(fns(), label).not.toContain("tw4_credit_settle_topup");
    }
  });

  it("a flagged session the database never registered credits nothing; an unflagged session is not ours at all", async () => {
    const unknown = fakeAdmin({ tw4_credit_topup_lookup: null });
    expect(await handleSmsCreditStripeEvent({ admin: unknown.admin, event: event("checkout.session.completed", paidSession()) })).toEqual({ handled: true });
    expect(unknown.fns()).toEqual(["tw4_credit_topup_lookup"]);
    const plain = fakeAdmin();
    expect(await handleSmsCreditStripeEvent({ admin: plain.admin, event: event("checkout.session.completed", paidSession({ metadata: {} })) })).toEqual({ handled: false });
    expect(plain.calls).toHaveLength(0);
    // metadata alone never makes a session ours: a SaaS or event Session carrying no flag stays with the other handlers
    const saas = fakeAdmin();
    expect(await handleSmsCreditStripeEvent({ admin: saas.admin, event: event("checkout.session.completed", paidSession({ metadata: { studioId: STUDIO } })) })).toEqual({ handled: false });
  });

  it("expiry and delayed-payment failure mark the pending purchase failed; an already settled one is left alone", async () => {
    for (const type of ["checkout.session.expired", "checkout.session.async_payment_failed"]) {
      const a = fakeAdmin({ tw4_credit_topup_lookup: topup() });
      await handleSmsCreditStripeEvent({ admin: a.admin, event: event(type, paidSession({ payment_status: "unpaid" })) });
      expect(a.fns()).toEqual(["tw4_credit_topup_lookup", "tw4_credit_topup_failed"]);
      const settled = fakeAdmin({ tw4_credit_topup_lookup: topup({ status: "settled" }), tw4_credit_topup_failed: () => ({ error: { code: "22023" } }) });
      await expect(handleSmsCreditStripeEvent({ admin: settled.admin, event: event(type, paidSession()) })).resolves.toEqual({ handled: true });
      const broken = fakeAdmin({ tw4_credit_topup_lookup: topup(), tw4_credit_topup_failed: () => ({ error: { code: "57014" } }) });
      await expect(handleSmsCreditStripeEvent({ admin: broken.admin, event: event(type, paidSession()) })).rejects.toBeTruthy();
    }
  });

  it("Connect (studio) events are never credit events, whatever they carry, and are not even looked up", async () => {
    const { admin, calls } = fakeAdmin({ tw4_credit_topup_lookup: topup() });
    for (const type of ["checkout.session.completed", "charge.refunded", "charge.dispute.created", "refund.created"]) {
      expect(await handleSmsCreditStripeEvent({ admin, event: event(type, paidSession({ payment_intent: PI, amount_refunded: 5000 }), { account: "acct_studio_1" }) })).toEqual({ handled: false });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("handleSmsCreditStripeEvent: refunds and disputes", () => {
  const charge = (over: Record<string, unknown> = {}) => ({ id: "ch_1", object: "charge", payment_intent: PI, amount: 5000, amount_refunded: 2000, metadata: {}, ...over });

  it("a refund applies Stripe's cumulative refunded amount to the payment, by PaymentIntent", async () => {
    const { admin, calls } = fakeAdmin({ tw4_credit_topup_lookup: topup({ status: "settled", payment_intent_ref: PI }) });
    expect(await handleSmsCreditStripeEvent({ admin, event: event("charge.refunded", charge()) })).toEqual({ handled: true });
    expect(calls[1]).toEqual({ fn: "tw4_credit_apply_refund", args: { p_payment_ref: PI, p_cumulative_refunded_cents: 2000, p_event_id: "evt_charge_refunded", p_reason: "stripe refund" } });
  });

  it("a charge that is not ours is left to the other handlers; a charge that carries our flag before its settlement is retried, not dropped", async () => {
    const stranger = fakeAdmin({ tw4_credit_topup_lookup: null });
    expect(await handleSmsCreditStripeEvent({ admin: stranger.admin, event: event("charge.refunded", charge()) })).toEqual({ handled: false });
    const early = fakeAdmin({ tw4_credit_topup_lookup: null });
    await expect(handleSmsCreditStripeEvent({ admin: early.admin, event: event("charge.refunded", charge({ metadata: { df_purpose: "sms_credit_topup" } })) })).rejects.toBeInstanceOf(SmsCreditError);
    const noPi = fakeAdmin();
    expect(await handleSmsCreditStripeEvent({ admin: noPi.admin, event: event("charge.refunded", charge({ payment_intent: null })) })).toEqual({ handled: false });
    expect(noPi.calls).toHaveLength(0);
  });

  it("charge.updated without a refund is acknowledged without moving money; refund.* objects alone never move money", async () => {
    const a = fakeAdmin({ tw4_credit_topup_lookup: topup({ status: "settled" }) });
    expect(await handleSmsCreditStripeEvent({ admin: a.admin, event: event("charge.updated", charge({ amount_refunded: 0 })) })).toEqual({ handled: true });
    expect(a.fns()).toEqual(["tw4_credit_topup_lookup"]);
    const b = fakeAdmin({ tw4_credit_topup_lookup: topup({ status: "settled" }) });
    expect(await handleSmsCreditStripeEvent({ admin: b.admin, event: event("refund.created", { id: "re_1", object: "refund", payment_intent: PI, amount: 2000 }) })).toEqual({ handled: true });
    expect(b.fns()).toEqual(["tw4_credit_topup_lookup"]);
  });

  const dispute = (over: Record<string, unknown> = {}) => ({ id: "dp_1", object: "dispute", payment_intent: PI, amount: 5000, status: "needs_response", ...over });

  it("a dispute withdraws once (created or funds_withdrawn); won / funds_reinstated gives back what it withdrew; lost and updates move nothing", async () => {
    const results = { tw4_credit_topup_lookup: topup({ status: "settled" }) };
    for (const type of ["charge.dispute.created", "charge.dispute.funds_withdrawn"]) {
      const { admin, calls } = fakeAdmin(results);
      await handleSmsCreditStripeEvent({ admin, event: event(type, dispute()) });
      expect(calls[1].args).toMatchObject({ p_payment_ref: PI, p_dispute_id: "dp_1", p_amount_cents: 5000, p_action: "withdrawn" });
    }
    for (const [type, status] of [["charge.dispute.funds_reinstated", "needs_response"], ["charge.dispute.closed", "won"]] as const) {
      const { admin, calls } = fakeAdmin(results);
      await handleSmsCreditStripeEvent({ admin, event: event(type, dispute({ status })) });
      expect(calls[1].args).toMatchObject({ p_action: "reinstated", p_dispute_id: "dp_1" });
    }
    for (const [type, status] of [["charge.dispute.closed", "lost"], ["charge.dispute.updated", "under_review"]] as const) {
      const { admin, fns } = fakeAdmin(results);
      expect(await handleSmsCreditStripeEvent({ admin, event: event(type, dispute({ status })) })).toEqual({ handled: true });
      expect(fns()).toEqual(["tw4_credit_topup_lookup"]);
    }
    const stranger = fakeAdmin({ tw4_credit_topup_lookup: null });
    expect(await handleSmsCreditStripeEvent({ admin: stranger.admin, event: event("charge.dispute.created", dispute()) })).toEqual({ handled: false });
  });

  it("a dispute inquiry (warning_*) moves no money, whether it opens with dispute.created or not", async () => {
    const results = { tw4_credit_topup_lookup: topup({ status: "settled" }) };
    for (const status of ["warning_needs_response", "warning_under_review", "warning_closed"]) {
      const { admin, fns } = fakeAdmin(results);
      expect(await handleSmsCreditStripeEvent({ admin, event: event("charge.dispute.created", dispute({ status })) })).toEqual({ handled: true });
      expect(fns()).toEqual(["tw4_credit_topup_lookup"]);
    }
    const real = fakeAdmin(results);
    await handleSmsCreditStripeEvent({ admin: real.admin, event: event("charge.dispute.funds_withdrawn", dispute({ status: "warning_needs_response" })) });
    expect(real.fns()).toEqual(["tw4_credit_topup_lookup", "tw4_credit_apply_dispute"]); // the bank actually took the funds
  });

  it("where the credit functions are not installed yet, platform charge, refund and dispute events keep flowing to the other handlers", async () => {
    const missing = () => ({ error: { code: "PGRST202" } });
    const a = fakeAdmin({ tw4_credit_topup_lookup: missing });
    expect(await handleSmsCreditStripeEvent({ admin: a.admin, event: event("charge.refunded", charge()) })).toEqual({ handled: false });
    expect(await handleSmsCreditStripeEvent({ admin: a.admin, event: event("charge.dispute.created", dispute()) })).toEqual({ handled: false });
    expect(await handleSmsCreditStripeEvent({ admin: a.admin, event: event("refund.created", { id: "re_1", object: "refund", payment_intent: PI, amount: 1 }) })).toEqual({ handled: false });
    const flaky = fakeAdmin({ tw4_credit_topup_lookup: () => ({ error: { code: "57014" } }) });
    await expect(handleSmsCreditStripeEvent({ admin: flaky.admin, event: event("charge.refunded", charge()) })).rejects.toBeTruthy(); // a transient error is retried, not guessed
  });

  it("unrelated event types are not handled", async () => {
    const { admin, calls } = fakeAdmin();
    for (const type of ["customer.created", "invoice.paid", "payout.paid", "payment_intent.succeeded", "customer.subscription.updated"]) {
      expect(await handleSmsCreditStripeEvent({ admin, event: event(type, { id: "x" }) })).toEqual({ handled: false });
    }
    expect(calls).toHaveLength(0);
  });
});

describe("separation from the ConfiDance pilot ceiling", () => {
  it("the purchase module never refers to the pilot exception: purchased credit and the ceiling stay separate", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "../smsCreditPurchases.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/pilot/i);
  });
});
