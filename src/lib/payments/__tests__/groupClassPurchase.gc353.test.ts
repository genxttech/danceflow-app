import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { FakeTable, createFakeEntitlementClient, type Row } from "@/lib/packages/__tests__/fakeEntitlementSupabase";
import { createFakeStripe } from "./gc353FakeStripe";

vi.mock("server-only", () => ({}));

const {
  checkoutIdempotencyKey,
  computeCheckoutExpiry,
  hasLinkedStudioRelationship,
  loadPublicClassPaymentOffer,
  releaseOwnPublicClassPurchase,
  resolveStudioPaymentAccount,
  startPublicClassCheckout,
} = await import("../groupClassPurchase");

/**
 * GC-3.5-3 service layer: Connect readiness, the display offer, start/resume Checkout, attach-before-redirect, and release.
 * The database RPCs are simulated with the GC-3.5-2 contract that was proven against Postgres
 * (sql-tests/test_T_gc352_public_class_purchase.sql): start runs on the USER client and snapshots the policy price;
 * attach runs on the service-role client and binds ONE session per hold on the studio's account; release is own-hold only.
 */

const STUDIO = "studio-a";
const OTHER_STUDIO = "studio-b";
const CLASS = "11111111-1111-4111-8111-111111111111";
const USER = "user-1";
const OTHER_USER = "user-2";
const ACCT = "acct_studioA";
const NOW = Date.parse("2030-01-01T12:00:00Z");
const STARTS = "2030-01-03T12:00:00Z";

let studios: FakeTable;
let policies: FakeTable;
let links: FakeTable;
let holds: FakeTable;
let currentUser = USER;
let startError: string | null = null;
let holdSeq = 0;
let fake: ReturnType<typeof createFakeStripe>;
const rpcLog: Array<{ client: "user" | "admin"; name: string; args: Record<string, unknown> }> = [];

function policyCents() {
  const p = policies.rows.find((r) => r.appointment_id === CLASS);
  return Math.round(Number(p?.direct_payment_amount ?? 0) * 100);
}

function holdShape(h: Row) {
  return {
    hold_id: h.id, hold_status: h.status, amount_cents: h.amount_cents, currency: "usd", expires_at: h.expires_at,
    stripe_checkout_session_id: h.stripe_checkout_session_id ?? null, dancer_first_name: h.dancer_first_name, dancer_last_name: h.dancer_last_name,
  };
}

const userRpc = {
  start_public_class_purchase: (args: Record<string, unknown>) => {
    rpcLog.push({ client: "user", name: "start_public_class_purchase", args });
    if (startError) return { error: { message: startError } };
    const live = holds.rows.find(
      (h) => h.appointment_id === CLASS && h.purchaser_user_id === currentUser && h.status === "held" && Date.parse(String(h.expires_at)) > NOW,
    );
    if (live) return { data: [{ ...holdShape(live), reused: true }] };
    holdSeq += 1;
    const row: Row = {
      id: `0000000${holdSeq}-0000-4000-8000-00000000000${holdSeq}`.slice(-36),
      studio_id: STUDIO,
      appointment_id: CLASS,
      purchaser_user_id: currentUser,
      status: "held",
      amount_cents: policyCents(),
      expires_at: new Date(NOW + 30 * 60 * 1000).toISOString(),
      created_at: new Date(NOW + holdSeq).toISOString(),
      stripe_checkout_session_id: null,
      stripe_account_id: null,
      client_id: null, attendee_id: null, payment_id: null,
      dancer_first_name: String(args.p_first_name).trim(),
      dancer_last_name: String(args.p_last_name).trim(),
    };
    holds.rows.push(row);
    return { data: [{ ...holdShape(row), reused: false }] };
  },
  release_public_class_purchase: (args: Record<string, unknown>) => {
    rpcLog.push({ client: "user", name: "release_public_class_purchase", args });
    const h = holds.rows.find((r) => r.id === args.p_hold_id && r.purchaser_user_id === currentUser);
    if (!h) return { error: { message: "GC35_HOLD_NOT_FOUND: Purchase hold not found." } };
    if (h.status !== "held" && h.status !== "released") return { error: { message: "GC35_HOLD_NOT_RELEASABLE: x" } };
    h.status = "released";
    return { data: [{ hold_id: h.id, hold_status: "released" }] };
  },
};

const adminRpc = {
  attach_public_class_purchase_checkout: (args: Record<string, unknown>) => {
    rpcLog.push({ client: "admin", name: "attach_public_class_purchase_checkout", args });
    const h = holds.rows.find((r) => r.id === args.p_hold_id);
    if (!h) return { error: { message: "GC35_HOLD_NOT_FOUND: x" } };
    const studio = studios.rows.find((s) => s.id === h.studio_id);
    if (studio?.stripe_connected_account_id !== args.p_stripe_account_id) return { error: { message: "GC35_ACCOUNT_MISMATCH: x" } };
    if (h.stripe_checkout_session_id && h.stripe_checkout_session_id !== args.p_checkout_session_id) {
      return { error: { message: "GC35_CHECKOUT_ALREADY_ATTACHED: x" } };
    }
    h.stripe_checkout_session_id = args.p_checkout_session_id;
    h.stripe_account_id = args.p_stripe_account_id;
    h.expires_at = args.p_checkout_expires_at;
    return { data: [{ hold_id: h.id }] };
  },
};

let attachError: string | null = null;

function userClient() {
  return createFakeEntitlementClient({ group_class_enrollment_holds: holds }, userRpc) as unknown as SupabaseClient;
}
function adminClient() {
  return createFakeEntitlementClient(
    { studios, group_class_enrollment_policies: policies, client_account_links: links, group_class_enrollment_holds: holds },
    {
      attach_public_class_purchase_checkout: (args) =>
        attachError ? (rpcLog.push({ client: "admin", name: "attach_public_class_purchase_checkout", args }), { error: { message: attachError } }) : adminRpc.attach_public_class_purchase_checkout(args),
    },
  ) as unknown as SupabaseClient;
}

function start(over: Partial<Parameters<typeof startPublicClassCheckout>[0]> = {}) {
  return startPublicClassCheckout({
    userClient: userClient(),
    admin: adminClient(),
    stripe: fake.stripe as never,
    userId: currentUser,
    studioId: STUDIO,
    appointmentId: CLASS,
    classTitle: "Salsa Level 1",
    classDescription: "Salsa House · Thu",
    classStartsAt: STARTS,
    firstName: "Ada",
    lastName: "Lovelace",
    phone: "",
    customerEmail: "ada@example.test",
    successUrl: `https://app.example.test/studios/salsa-house/classes/${CLASS}/register?purchase=return`,
    cancelUrl: `https://app.example.test/studios/salsa-house/classes/${CLASS}/register?purchase=cancelled`,
    now: NOW,
    ...over,
  });
}

beforeEach(() => {
  studios = new FakeTable();
  policies = new FakeTable();
  links = new FakeTable();
  holds = new FakeTable();
  studios.rows.push(
    { id: STUDIO, stripe_connected_account_id: ACCT, stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true },
    { id: OTHER_STUDIO, stripe_connected_account_id: "acct_studioB", stripe_connect_onboarding_complete: true, stripe_connect_charges_enabled: true, stripe_connect_payouts_enabled: true },
  );
  policies.rows.push({
    appointment_id: CLASS, studio_id: STUDIO, publicly_discoverable: true, self_enrollment_allowed: true,
    accepted_funding_types: ["direct_payment"], direct_payment_amount: "25.00",
  });
  currentUser = USER;
  startError = null;
  attachError = null;
  holdSeq = 0;
  rpcLog.length = 0;
  fake = createFakeStripe();
});

describe("Connect readiness and the display offer", () => {
  it("requires the studio's own account with onboarding, charges and payouts all enabled", async () => {
    expect(await resolveStudioPaymentAccount(adminClient(), STUDIO)).toEqual({ ready: true, accountId: ACCT });
    for (const field of ["stripe_connect_onboarding_complete", "stripe_connect_charges_enabled", "stripe_connect_payouts_enabled"]) {
      studios.rows[0][field] = false;
      expect(await resolveStudioPaymentAccount(adminClient(), STUDIO)).toEqual({ ready: false });
      studios.rows[0][field] = true;
    }
    studios.rows[0].stripe_connected_account_id = "not-an-account";
    expect(await resolveStudioPaymentAccount(adminClient(), STUDIO)).toEqual({ ready: false });
  });

  it("A: shows the authoritative policy price for a direct-payment class", async () => {
    expect(await loadPublicClassPaymentOffer(adminClient(), { studioId: STUDIO, appointmentId: CLASS })).toEqual({ available: true, amountCents: 2500 });
  });

  it("no offer when direct payment is not accepted, the class is not public, self-enrollment is off or the price is invalid", async () => {
    const cases: Array<Partial<Row>> = [
      { accepted_funding_types: ["package"] },
      { publicly_discoverable: false },
      { self_enrollment_allowed: false },
      { direct_payment_amount: "12.345" },
      { direct_payment_amount: null },
    ];
    for (const change of cases) {
      const original = { ...policies.rows[0] };
      Object.assign(policies.rows[0], change);
      expect(await loadPublicClassPaymentOffer(adminClient(), { studioId: STUDIO, appointmentId: CLASS })).toEqual({ available: false, reason: "not_offered" });
      policies.rows[0] = original;
    }
  });

  it("the offer is scoped to the class's own studio (a forged studio finds no policy)", async () => {
    expect(await loadPublicClassPaymentOffer(adminClient(), { studioId: OTHER_STUDIO, appointmentId: CLASS })).toEqual({ available: false, reason: "not_offered" });
  });

  it("missing Connect readiness reports payment_not_ready", async () => {
    studios.rows[0].stripe_connect_charges_enabled = false;
    expect(await loadPublicClassPaymentOffer(adminClient(), { studioId: STUDIO, appointmentId: CLASS })).toEqual({ available: false, reason: "payment_not_ready" });
  });

  it("detects any linked relationship at the studio (self or managing someone)", async () => {
    expect(await hasLinkedStudioRelationship(adminClient(), { userId: USER, studioId: STUDIO })).toBe(false);
    links.rows.push({ id: "l1", user_id: USER, studio_id: STUDIO, status: "linked", relationship_type: "guardian", can_manage_bookings: false });
    expect(await hasLinkedStudioRelationship(adminClient(), { userId: USER, studioId: STUDIO })).toBe(true);
    expect(await hasLinkedStudioRelationship(adminClient(), { userId: USER, studioId: OTHER_STUDIO })).toBe(false);
  });
});

describe("start / Checkout (B-I)", () => {
  it("missing Connect readiness blocks safely BEFORE any hold is created", async () => {
    studios.rows[0].stripe_connect_payouts_enabled = false;
    expect(await start()).toEqual({ kind: "error", code: "unavailable" });
    expect(rpcLog.find((c) => c.name === "start_public_class_purchase")).toBeUndefined();
    expect(fake.calls.create).toHaveLength(0);
  });

  it("B/C/D/F/G: creates the hold on the user session, Checkout on the studio account for the hold amount, attaches, then redirects", async () => {
    const result = await start();
    expect(result.kind).toBe("redirect");
    const startCall = rpcLog.find((c) => c.name === "start_public_class_purchase")!;
    expect(startCall.client).toBe("user");
    expect(Object.keys(startCall.args).sort()).toEqual(["p_appointment_id", "p_first_name", "p_last_name", "p_phone"]);

    expect(fake.calls.create).toHaveLength(1);
    const { params, opts } = fake.calls.create[0];
    expect(opts?.stripeAccount).toBe(ACCT);
    expect(params.mode).toBe("payment");
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params).not.toHaveProperty("payment_intent_data.application_fee_amount");
    expect((params.payment_intent_data as Record<string, unknown>).application_fee_amount).toBeUndefined();
    const line = (params.line_items as Array<{ price_data: { unit_amount: number; currency: string } }>)[0].price_data;
    expect(line).toMatchObject({ unit_amount: 2500, currency: "usd" });
    // metadata carries only stable server ids -- no names, email or phone
    const hold = holds.rows[0];
    expect(params.metadata).toEqual({ source: "group_class_direct_payment", hold_id: hold.id, studio_id: STUDIO, appointment_id: CLASS });
    expect(params.customer_email).toBe("ada@example.test");

    // attached before the redirect, on the service-role client, with the same session/account
    const attach = rpcLog.find((c) => c.name === "attach_public_class_purchase_checkout")!;
    expect(attach.client).toBe("admin");
    expect(attach.args).toMatchObject({ p_hold_id: hold.id, p_stripe_account_id: ACCT, p_checkout_session_id: fake.calls.create[0] && [...fake.sessions.values()][0].id });
    expect(hold.stripe_checkout_session_id).toBe([...fake.sessions.values()][0].id);
    expect(result).toEqual({ kind: "redirect", url: [...fake.sessions.values()][0].url });
  });

  it("E: the Stripe idempotency key is deterministic for the hold and the expiry stays within the GC-3.5-2 window", async () => {
    await start();
    const { params, opts } = fake.calls.create[0];
    const hold = holds.rows[0];
    expect(opts?.idempotencyKey).toBe(checkoutIdempotencyKey(String(hold.id), params.expires_at as number));
    expect(opts?.idempotencyKey).toMatch(/^gc35-hold:[0-9a-f-]{36}:checkout-session:\d+$/);
    const expires = (params.expires_at as number) * 1000;
    expect(expires - NOW).toBeGreaterThanOrEqual(30 * 60 * 1000);
    expect(expires - NOW).toBeLessThanOrEqual(35 * 60 * 1000);
  });

  it("H: double-click / refresh reuses the hold's one session -- no second charge path", async () => {
    const first = await start();
    const second = await start();
    expect(second).toEqual(first);
    expect(fake.calls.create).toHaveLength(1);
    expect(holds.rows.filter((h) => h.status === "held")).toHaveLength(1);
  });

  it("H: a concurrent second create for the same unattached hold gets the SAME Stripe session (same idempotency key)", async () => {
    // Two requests racing before either attached: identical params + key -> Stripe returns one session.
    const expiresA = computeCheckoutExpiry({ holdExpiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(), classStartsAt: STARTS, now: NOW });
    const expiresB = computeCheckoutExpiry({ holdExpiresAt: new Date(NOW + 30 * 60 * 1000).toISOString(), classStartsAt: STARTS, now: NOW + 20_000 });
    expect(expiresA).toBe(expiresB);
  });

  it("D: the Checkout amount is the hold's snapshot even after staff change the price; a new purchaser gets the new price", async () => {
    await start();
    policies.rows[0].direct_payment_amount = "30.00";
    // existing hold: resumes its own session at 25.00 -- no new session at the new price
    const resumed = await start();
    expect(resumed.kind).toBe("redirect");
    expect(fake.calls.create).toHaveLength(1);
    expect((fake.calls.create[0].params.line_items as Array<{ price_data: { unit_amount: number } }>)[0].price_data.unit_amount).toBe(2500);
    // a different purchaser now gets 30.00
    currentUser = OTHER_USER;
    await start();
    expect(fake.calls.create).toHaveLength(2);
    expect((fake.calls.create[1].params.line_items as Array<{ price_data: { unit_amount: number } }>)[0].price_data.unit_amount).toBe(3000);
  });

  it("G: attach failure expires the created session and never redirects to it", async () => {
    attachError = "GC35_HOLD_EXPIRED: This purchase hold has expired.";
    const result = await start();
    expect(result).toEqual({ kind: "error", code: "checkout_failed" });
    const created = [...fake.sessions.values()][0];
    expect(fake.calls.expire.map((c) => c.id)).toEqual([created.id]);
    expect(created.status).toBe("expired");
  });

  it("attach refusing the checkout window maps to a closed state", async () => {
    attachError = "GC35_CHECKOUT_CUTOFF: Online registration for this class has closed.";
    expect(await start()).toEqual({ kind: "error", code: "closed" });
  });

  it("Stripe create failure is a generic retry state (no raw Stripe text, hold kept for retry)", async () => {
    fake.failures.create = true;
    expect(await start()).toEqual({ kind: "error", code: "checkout_failed" });
    expect(holds.rows[0].stripe_checkout_session_id).toBeNull();
  });

  it("a session already paid shows finalizing instead of a new checkout", async () => {
    await start();
    fake.pay([...fake.sessions.values()][0].id);
    expect(await start()).toEqual({ kind: "finalizing" });
  });

  it("I: an expired session releases its hold and starts a fresh hold + session", async () => {
    await start();
    const first = [...fake.sessions.values()][0];
    first.status = "expired";
    const result = await start();
    expect(result.kind).toBe("redirect");
    expect(holds.rows[0].status).toBe("released");
    expect(holds.rows.filter((h) => h.status === "held")).toHaveLength(1);
    expect(fake.calls.create).toHaveLength(2);
  });

  it("database refusals map to safe kinds (raw text never returned)", async () => {
    const cases: Array<[string, string]> = [
      ["GC35_CLASS_FULL: This class is full.", "full"],
      ["GC35_ALREADY_LINKED: x", "already_linked"],
      ["GC35_CHECKOUT_CUTOFF: x", "closed"],
      ["GC35_CLASS_CANCELLED: x", "cancelled"],
      ["GC35_DIRECT_PAYMENT_UNAVAILABLE: x", "unavailable"],
      ["GC35_PAYMENT_PENDING: x", "payment_pending"],
      ["GC35_NAME_INVALID: x", "name_invalid"],
      ["GC35_PHONE_INVALID: x", "phone_invalid"],
      ["GC35_EMAIL_UNVERIFIED: x", "sign_in"],
      ["permission denied for table secret_stuff", "checkout_failed"],
    ];
    for (const [message, code] of cases) {
      startError = message;
      expect(await start()).toEqual({ kind: "error", code });
    }
    expect(fake.calls.create).toHaveLength(0);
  });

  it("computeCheckoutExpiry: null (closed) when no valid 30-minute window remains before class start", () => {
    const holdExpires = new Date(NOW + 30 * 60 * 1000).toISOString();
    expect(computeCheckoutExpiry({ holdExpiresAt: holdExpires, classStartsAt: new Date(NOW + 29 * 60 * 1000).toISOString(), now: NOW })).toBeNull();
    expect(computeCheckoutExpiry({ holdExpiresAt: holdExpires, classStartsAt: STARTS, now: NOW })).toBe(Math.floor((NOW + 32 * 60 * 1000) / 1000));
  });
});

describe("release / cancel (I)", () => {
  it("releases the purchaser's own hold after expiring its open session", async () => {
    await start();
    const hold = holds.rows[0];
    const session = [...fake.sessions.values()][0];
    expect(await releaseOwnPublicClassPurchase({ userClient: userClient(), stripe: fake.stripe as never, userId: USER, holdId: String(hold.id) })).toBe("released");
    expect(session.status).toBe("expired");
    expect(fake.calls.expire[0].opts?.stripeAccount).toBe(ACCT);
    expect(hold.status).toBe("released");
    // Stripe identity stays on the hold for any late-payment reconciliation
    expect(hold.stripe_checkout_session_id).toBe(session.id);
    expect(hold.stripe_account_id).toBe(ACCT);
  });

  it("does not release a hold whose Checkout was already paid (the webhook finalizes)", async () => {
    await start();
    fake.pay([...fake.sessions.values()][0].id);
    expect(await releaseOwnPublicClassPurchase({ userClient: userClient(), stripe: fake.stripe as never, userId: USER, holdId: String(holds.rows[0].id) })).toBe("finalizing");
    expect(holds.rows[0].status).toBe("held");
  });

  it("another user's hold cannot be released (not found, nothing called)", async () => {
    await start();
    currentUser = OTHER_USER;
    rpcLog.length = 0;
    expect(await releaseOwnPublicClassPurchase({ userClient: userClient(), stripe: fake.stripe as never, userId: OTHER_USER, holdId: String(holds.rows[0].id) })).toBe("not_found");
    expect(rpcLog).toHaveLength(0);
    expect(fake.calls.expire).toHaveLength(0);
    expect(holds.rows[0].status).toBe("held");
  });

  it("a failed Stripe expire keeps the hold (no release that could orphan a payable session)", async () => {
    await start();
    fake.failures.expire = true;
    expect(await releaseOwnPublicClassPurchase({ userClient: userClient(), stripe: fake.stripe as never, userId: USER, holdId: String(holds.rows[0].id) })).toBe("error");
    expect(holds.rows[0].status).toBe("held");
  });
});
