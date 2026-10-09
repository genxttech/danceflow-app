import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

vi.mock("server-only", () => ({}));

import {
  beginCompetitionPayment,
  classifyCompetitionRegistrationError,
  competitionCheckoutExpiry,
  competitionCheckoutIdempotencyKey,
  deriveCompetitionDisplayState,
} from "@/lib/competition/registrationCheckout";
import { applyCompetitionCheckoutEvent } from "@/lib/competition/registrationLifecycle";

const ROOT = join(__dirname, "..", "..", "..", "..");
const ORDER = "11111111-2222-4333-8444-555555555555";
const ACCOUNT = "acct_studioA";
const URLS = { statusUrl: "https://app.test/events/e/competition/register/status?token=t", cancelUrl: "https://app.test/api/events/e/competition/release?token=t" };

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeAdmin(responses: Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: { message: string } | null }>, tables: Record<string, unknown> = {}) {
  const calls: RpcCall[] = [];
  const admin = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const handler = responses[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      const result = handler(args);
      return { data: result.data ?? null, error: result.error ?? null };
    }),
    from: vi.fn((table: string) => {
      const row = tables[table] ?? null;
      const chain = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: row, error: null }),
        then: undefined,
      };
      return chain;
    }),
  };
  return { admin, calls };
}

const READY_STUDIO = {
  stripe_connected_account_id: ACCOUNT,
  stripe_connect_onboarding_complete: true,
  stripe_connect_charges_enabled: true,
  stripe_connect_payouts_enabled: true,
};

function payable(overrides: Record<string, unknown> = {}) {
  return {
    order_id: ORDER, state: "payable", event_id: "event-1", studio_id: "studio-1", organizer_id: null,
    buyer_email: "buyer@example.test", amount_cents: 10330, currency: "USD",
    expires_at: new Date(Date.now() + 40 * 60 * 1000).toISOString(), checkout_session_id: null, stripe_account_id: null, entry_count: 3,
    ...overrides,
  };
}

function fakeStripe(session: Partial<Stripe.Checkout.Session> = { id: "cs_new", url: "https://stripe.test/cs_new", status: "open" }) {
  return {
    checkout: {
      sessions: {
        create: vi.fn(async () => ({ expires_at: undefined, ...session })),
        retrieve: vi.fn(async () => session),
        expire: vi.fn(async () => ({})),
      },
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("beginCompetitionPayment: price and binding come from the database", () => {
  it("charges the database snapshot amount with a deterministic idempotency key, card only, on the studio account, then attaches", async () => {
    const { admin, calls } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable() }),
      attach_competition_registration_checkout: () => ({ data: { attached: true } }),
    }, { studios: READY_STUDIO });
    const stripe = fakeStripe();
    const step = await beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "Spring Classic", urls: URLS });
    expect(step).toEqual({ kind: "redirect", url: "https://stripe.test/cs_new" });
    const [params, options] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [Stripe.Checkout.SessionCreateParams, { stripeAccount: string; idempotencyKey: string }];
    expect(params.line_items?.[0]?.price_data?.unit_amount).toBe(10330);
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.metadata).toMatchObject({ source: "competition_registration", order_id: ORDER });
    expect(params.success_url).toBe(URLS.statusUrl);
    expect(params.success_url).not.toMatch(/success=paid/);
    expect(options.stripeAccount).toBe(ACCOUNT);
    expect(options.idempotencyKey).toBe(competitionCheckoutIdempotencyKey(ORDER, params.expires_at as number));
    expect(calls.map((call) => call.name)).toEqual(["prepare_competition_registration_payment", "attach_competition_registration_checkout"]);
    expect(calls[1].args).toMatchObject({ p_order_id: ORDER, p_stripe_account_id: ACCOUNT, p_checkout_session_id: "cs_new" });
  });

  it("a retry inside the same payment window reuses the same Stripe idempotency key", async () => {
    const expiresAt = new Date(Date.now() + 40 * 60 * 1000).toISOString();
    const keys: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { admin } = fakeAdmin({
        prepare_competition_registration_payment: () => ({ data: payable({ expires_at: expiresAt }) }),
        attach_competition_registration_checkout: () => ({ data: { attached: true } }),
      }, { studios: READY_STUDIO });
      const stripe = fakeStripe();
      await beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS });
      keys.push((stripe.checkout.sessions.create.mock.calls[0] as unknown as [unknown, { idempotencyKey: string }])[1].idempotencyKey);
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it("reuses an already-bound open session instead of creating another", async () => {
    const { admin, calls } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable({ checkout_session_id: "cs_bound", stripe_account_id: ACCOUNT }) }),
    });
    const stripe = fakeStripe({ id: "cs_bound", url: "https://stripe.test/cs_bound", status: "open" });
    const step = await beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS });
    expect(step).toEqual({ kind: "redirect", url: "https://stripe.test/cs_bound" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(calls.map((call) => call.name)).toEqual(["prepare_competition_registration_payment"]);
  });

  it("a completed bound session goes to the status page (the webhook finalizes, not the browser)", async () => {
    const { admin, calls } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable({ checkout_session_id: "cs_bound", stripe_account_id: ACCOUNT }) }),
    });
    const stripe = fakeStripe({ id: "cs_bound", status: "complete" });
    const step = await beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS });
    expect(step).toEqual({ kind: "status", url: URLS.statusUrl });
    expect(calls.some((call) => call.name === "finalize_competition_registration")).toBe(false);
  });

  it("an expired bound session releases the hold with the bound session/account", async () => {
    const { admin, calls } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable({ checkout_session_id: "cs_bound", stripe_account_id: ACCOUNT }) }),
      release_competition_registration: () => ({ data: { outcome: "released" } }),
    });
    const stripe = fakeStripe({ id: "cs_bound", status: "expired" });
    await expect(beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS })).rejects.toMatchObject({ code: "expired" });
    expect(calls.at(-1)).toMatchObject({ name: "release_competition_registration", args: { p_reason: "expired", p_checkout_session_id: "cs_bound", p_stripe_account_id: ACCOUNT } });
  });

  it("an attach failure never leaves a payable session behind", async () => {
    const { admin } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable() }),
      attach_competition_registration_checkout: () => ({ error: { message: "COMP10C_BINDING_INVALID: checkout account is not ready" } }),
    }, { studios: READY_STUDIO });
    const stripe = fakeStripe();
    await expect(beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS })).rejects.toBeTruthy();
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_new", {}, { stripeAccount: ACCOUNT });
  });

  it("free orders finalize through the database (which re-checks total 0 and signing), never Stripe", async () => {
    const { admin, calls } = fakeAdmin({
      prepare_competition_registration_payment: () => ({ data: payable({ state: "free", amount_cents: 0 }) }),
      finalize_competition_registration: () => ({ data: { outcome: "finalized" } }),
    });
    const stripe = fakeStripe();
    const step = await beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS });
    expect(step.kind).toBe("status");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(calls[1]).toMatchObject({ name: "finalize_competition_registration", args: { p_checkout_session_id: null } });
  });

  it("refuses to create a session when the studio account is not ready", async () => {
    const { admin } = fakeAdmin({ prepare_competition_registration_payment: () => ({ data: payable() }) }, { studios: { ...READY_STUDIO, stripe_connect_charges_enabled: false } });
    const stripe = fakeStripe();
    await expect(beginCompetitionPayment({ admin: admin as never, stripe: stripe as never, orderId: ORDER, eventName: "E", urls: URLS })).rejects.toMatchObject({ code: "payment_not_ready" });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });
});

describe("checkout expiry and errors", () => {
  it("session expiry sits inside the hold and respects Stripe's 30-minute minimum", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(competitionCheckoutExpiry("2026-10-09T12:40:00Z", now)).toBe(Date.parse("2026-10-09T12:39:00Z") / 1000);
    expect(competitionCheckoutExpiry("2026-10-09T12:31:00Z", now)).toBeNull();
    expect(competitionCheckoutExpiry("not a date", now)).toBeNull();
  });

  it("maps database refusals to safe HTTP errors without leaking SQL", () => {
    expect(classifyCompetitionRegistrationError("COMP10C_CLOSED: competition registration is not open.")).toMatchObject({ code: "closed", status: 409 });
    expect(classifyCompetitionRegistrationError("COMP10C_INVALID: Bronze: select 2 participants.", "[\"Bronze: select 2 participants.\"]")).toMatchObject({ code: "invalid", status: 400, message: "Bronze: select 2 participants.", details: ["Bronze: select 2 participants."] });
    expect(classifyCompetitionRegistrationError("COMP10C_IDENTITY_UNVERIFIED: verify")).toMatchObject({ code: "identity_unverified", status: 403 });
    expect(classifyCompetitionRegistrationError("COMP10C_ANCHOR_CROSS_STUDIO: client does not belong")).toMatchObject({ code: "forbidden", status: 403 });
    expect(classifyCompetitionRegistrationError("COMP10C_IDEMPOTENCY_CONFLICT: x")).toMatchObject({ code: "idempotency_conflict", status: 409 });
    const unknown = classifyCompetitionRegistrationError("duplicate key value violates unique constraint \"secret_index\"");
    expect(unknown).toMatchObject({ code: "checkout_failed", status: 500 });
    expect(unknown.message).not.toMatch(/secret_index/);
  });
});

describe("display state is derived from server state only", () => {
  const base = { orderStatus: "pending", paymentStatus: "pending", needsReview: false, requiresSigning: false, signingComplete: false, checkoutComplete: false, expired: false };
  it("a pending order is never shown as confirmed (even when the browser returned from Stripe)", () => {
    expect(deriveCompetitionDisplayState(base)).toBe("awaiting_payment");
    expect(deriveCompetitionDisplayState({ ...base, checkoutComplete: true })).toBe("processing");
  });
  it("only a confirmed+paid order is confirmed", () => {
    expect(deriveCompetitionDisplayState({ ...base, orderStatus: "confirmed", paymentStatus: "paid" })).toBe("confirmed");
    expect(deriveCompetitionDisplayState({ ...base, orderStatus: "pending", paymentStatus: "paid", needsReview: true })).toBe("needs_review");
  });
  it("expired / cancelled / failed / unsigned are reported truthfully", () => {
    expect(deriveCompetitionDisplayState({ ...base, expired: true })).toBe("expired");
    expect(deriveCompetitionDisplayState({ ...base, orderStatus: "expired", paymentStatus: "unpaid" })).toBe("expired");
    expect(deriveCompetitionDisplayState({ ...base, orderStatus: "cancelled", paymentStatus: "unpaid" })).toBe("cancelled");
    expect(deriveCompetitionDisplayState({ ...base, orderStatus: "cancelled", paymentStatus: "failed" })).toBe("payment_failed");
    expect(deriveCompetitionDisplayState({ ...base, requiresSigning: true })).toBe("awaiting_signature");
  });
});

describe("webhook lifecycle (applyCompetitionCheckoutEvent)", () => {
  function session(overrides: Record<string, unknown> = {}) {
    return { id: "cs_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 10330, currency: "usd", metadata: { source: "competition_registration", order_id: ORDER }, ...overrides } as unknown as Stripe.Checkout.Session;
  }

  it("completed + paid finalizes with the provider evidence (database re-validates binding and amount)", async () => {
    const { admin, calls } = fakeAdmin({ finalize_competition_registration: () => ({ data: { outcome: "finalized" } }) });
    const result = await applyCompetitionCheckoutEvent(admin as never, { eventType: "checkout.session.completed", session: session(), stripeAccountId: ACCOUNT });
    expect(result).toMatchObject({ orderId: ORDER, outcome: "finalized", paymentIntentId: "pi_1" });
    expect(calls[0].args).toEqual({ p_order_id: ORDER, p_stripe_account_id: ACCOUNT, p_checkout_session_id: "cs_1", p_payment_intent_id: "pi_1", p_amount_cents: 10330, p_currency: "USD" });
  });

  it("an unpaid completion (delayed method) does not finalize", async () => {
    const { admin, calls } = fakeAdmin({});
    const result = await applyCompetitionCheckoutEvent(admin as never, { eventType: "checkout.session.completed", session: session({ payment_status: "unpaid" }), stripeAccountId: ACCOUNT });
    expect(result.outcome).toBe("pending_async");
    expect(calls).toHaveLength(0);
  });

  it("expired and async-failed sessions release the bound order", async () => {
    for (const [eventType, reason] of [["checkout.session.expired", "expired"], ["checkout.session.async_payment_failed", "failed"]] as const) {
      const { admin, calls } = fakeAdmin({ release_competition_registration: () => ({ data: { outcome: "released" } }) });
      await applyCompetitionCheckoutEvent(admin as never, { eventType, session: session({ payment_status: "unpaid" }), stripeAccountId: ACCOUNT });
      expect(calls[0]).toMatchObject({ name: "release_competition_registration", args: { p_order_id: ORDER, p_reason: reason, p_checkout_session_id: "cs_1", p_stripe_account_id: ACCOUNT } });
    }
  });

  it("refuses platform-scope events and malformed metadata without touching the database", async () => {
    const { admin, calls } = fakeAdmin({});
    await expect(applyCompetitionCheckoutEvent(admin as never, { eventType: "checkout.session.completed", session: session(), stripeAccountId: null })).rejects.toThrow();
    await expect(applyCompetitionCheckoutEvent(admin as never, { eventType: "checkout.session.completed", session: session({ metadata: { source: "competition_registration", order_id: "nope" } }), stripeAccountId: ACCOUNT })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("a database binding/amount refusal propagates so the webhook is not marked processed", async () => {
    const { admin } = fakeAdmin({ finalize_competition_registration: () => ({ error: { message: "COMP10C_AMOUNT_MISMATCH: settled amount does not match" } }) });
    await expect(applyCompetitionCheckoutEvent(admin as never, { eventType: "checkout.session.completed", session: session(), stripeAccountId: ACCOUNT })).rejects.toThrow(/AMOUNT_MISMATCH/);
  });
});

describe("source guards (Phase 10C invariants)", () => {
  const route = readFileSync(join(ROOT, "src/app/api/events/[slug]/competition/checkout/route.ts"), "utf8");
  const webhook = readFileSync(join(ROOT, "src/app/api/payments/webhook/route.ts"), "utf8");
  const register = readFileSync(join(ROOT, "src/app/events/[slug]/competition/register/page.tsx"), "utf8");
  const status = readFileSync(join(ROOT, "src/app/events/[slug]/competition/register/status/page.tsx"), "utf8");
  const orderPayment = readFileSync(join(ROOT, "src/lib/events/event-order-payment.ts"), "utf8");

  it("the checkout route never writes registration, signature or payment rows itself", () => {
    expect(route).not.toMatch(/\.insert\(/);
    expect(route).not.toMatch(/\.update\(/);
    expect(route).not.toMatch(/document_signatures/);
    expect(route).not.toMatch(/document_assignments/);
    expect(route).not.toMatch(/status:\s*"signed"/);
    expect(route).not.toMatch(/calculateCompetitionRegistrationQuote/);
    expect(route).toContain("startCompetitionRegistration(");
    expect(route).toContain("beginEventSigningCheckpoint(");
    expect(route).toContain("isUuid(body.clientRequestId)");
    expect(route).toContain("actorUserId: user?.id ?? null");
  });

  it("no page treats a success query parameter as payment evidence", () => {
    expect(register).not.toMatch(/success\s*===\s*"paid"/);
    expect(register).not.toMatch(/Registration payment completed/);
    expect(status).not.toMatch(/searchParams[^;]*success/);
    expect(status).toContain("loadCompetitionRegistrationStatus(");
  });

  it("the webhook routes competition sessions to the competition lifecycle before the event cart handler, and handles expiry", () => {
    const competition = webhook.indexOf("handleCompetitionRegistrationCheckoutEvent(\n    supabase,\n    stripe,\n    session,");
    const cart = webhook.indexOf("const handledEventCartOrder = await handleEventCartOrderCheckoutCompleted(");
    expect(competition).toBeGreaterThan(-1);
    expect(cart).toBeGreaterThan(competition);
    expect(webhook).toContain(`case "checkout.session.expired":`);
    expect(webhook.match(/paymentInsertError && paymentInsertError\.code !== "23505"/g)?.length).toBe(2);
    const failed = webhook.slice(webhook.indexOf(`case "checkout.session.async_payment_failed"`));
    const failedBlock = failed.slice(0, failed.indexOf("break;"));
    expect(failedBlock.indexOf("handleCompetitionRegistrationCheckoutEvent(")).toBeGreaterThan(0);
    expect(failedBlock.indexOf("handleCompetitionRegistrationCheckoutEvent(")).toBeLessThan(failedBlock.indexOf("_mark_package_payment_failed_and_reevaluate"));
  });

  it("competition entry revenue has its own category everywhere event revenue is summarized", () => {
    const categories = readFileSync(join(ROOT, "src/lib/accounting/categories.ts"), "utf8");
    const summary = readFileSync(join(ROOT, "src/lib/events/financial-summary.ts"), "utf8");
    const wave = readFileSync(join(ROOT, "src/lib/integrations/wave/categories.ts"), "utf8");
    const migration = readFileSync(join(ROOT, "src/lib/supabase/migrations/20261109090000_phase10c_competitor_registration.sql"), "utf8");
    expect(categories).toContain(`key: "competition_entry_revenue"`);
    expect(summary).toContain(`category === "competition_entry_revenue"`);
    expect(wave).toContain(`category === "competition_entry_revenue"`);
    expect(migration).toContain("case when v_competition then 'competition_entry_revenue' else 'event_ticket_revenue' end");
  });

  it("the generic event payment path refuses competition orders", () => {
    expect(orderPayment).toContain(`source === "competition_registration"`);
    expect(orderPayment).toContain("Competition registrations use the competition checkout.");
  });
});
