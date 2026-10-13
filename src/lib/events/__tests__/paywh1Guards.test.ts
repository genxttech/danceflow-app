import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PAY-WH-1 source guards: invariants of the event-cart payment lifecycle that must not regress in the application
 * layer. Behaviour is covered by cartLifecycle.paywh1.test.ts, eventClaims.paywh1.test.ts, the route tests and the
 * Postgres suites in src/lib/supabase/migrations/sql-tests.
 */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8").replace(/\r\n/g, "\n");

describe("checkout and resume never create an unrecorded or outliving Stripe object", () => {
  const checkout = read("src", "app", "api", "events", "cart", "checkout", "route.ts");
  const resume = read("src", "lib", "events", "event-order-payment.ts");

  it("every web Checkout Session expires before its capacity hold and is recorded as a payment attempt", () => {
    for (const source of [checkout, resume]) {
      expect(source).toContain("checkoutSessionExpiresAtForHold(holdUntil)");
      expect(source).toMatch(/stripe\.checkout\.sessions\.create\(\s*\{\s*mode: "payment",[^}]*?expires_at: sessionExpiresAt,/);
      expect(source).toContain('kind: "checkout_session"');
      expect(source).not.toMatch(/stripe_checkout_session_id: session\.id/);
    }
  });

  it("a native PaymentIntent is recorded as an attempt and never written over the order", () => {
    expect(resume).toContain('kind: "payment_intent"');
    expect(resume).not.toMatch(/stripe_payment_intent_id: intent\.id/);
  });

  it("resume extends (and re-checks) the hold before creating any Stripe object, and reuses only recorded attempts", () => {
    const extend = resume.indexOf("await extendEventCartOrderHold(admin, order.id, holdUntil)");
    expect(extend).toBeGreaterThan(0);
    expect(extend).toBeLessThan(resume.indexOf("stripe.paymentIntents.create("));
    expect(extend).toBeLessThan(resume.indexOf("stripe.checkout.sessions.create("));
    expect(resume).not.toMatch(/if \(order\.stripe_payment_intent_id\)/);
    expect(resume).not.toMatch(/if \(order\.stripe_checkout_session_id\)/);
  });

  it("resume closes a Session that would outlive the hold only after the replacement is recorded", () => {
    const record = resume.indexOf('kind: "checkout_session"');
    const expire = resume.indexOf("if (staleSessionId) await stripe.checkout.sessions.expire(staleSessionId");
    expect(record).toBeGreaterThan(0);
    expect(expire).toBeGreaterThan(record);
    expect(resume).toContain("existing.expires_at < holdSeconds");
  });

  it("checkout failures release through the two-phase lifecycle and expire an unrecorded Session first", () => {
    const catchBlock = checkout.slice(checkout.indexOf('console.error("event cart checkout failed:", error);'));
    expect(catchBlock.indexOf("stripe.checkout.sessions.expire(createdCheckoutSessionId")).toBeGreaterThan(0);
    expect(catchBlock.indexOf("stripe.checkout.sessions.expire(createdCheckoutSessionId"))
      .toBeLessThan(catchBlock.indexOf("releaseEventCartOrder({ admin: supabase, stripe, orderId: order.id"));
    expect(catchBlock).not.toMatch(/\.from\("event_registrations"\)\s*\.update/);
  });

  it("stale cleanup only releases orders that never reached Stripe", () => {
    const student = read("src", "app", "api", "student", "events", "[eventId]", "checkout", "route.ts");
    for (const source of [checkout, student]) {
      expect(source).toContain("releaseUnattemptedEventCartOrders(supabase");
      expect(source).not.toMatch(/\.eq\("attendee_email", buyerEmail\)\s*\.eq\("status", "pending"\)/);
    }
  });
});

describe("release route", () => {
  const release = read("src", "app", "api", "events", "cart", "release", "route.ts");
  it("ordinary carts use the two-phase release; competition carts keep their own lifecycle", () => {
    expect(release).toContain("if (!competitionCart) {");
    expect(release.indexOf("releaseEventCartOrder({")).toBeLessThan(release.indexOf("// Competition carts keep their own (Phase 10C) release behaviour."));
    expect(release).toContain("order?.metadata?.holdToken ?? order?.metadata?.hold_token");
  });
});

describe("shared sender", () => {
  const dispatch = read("src", "lib", "notifications", "dispatch.ts");
  it("leases queued deliveries (with a fallback before the database is migrated) and sends email idempotently", () => {
    expect(dispatch).toContain('supabase.rpc("claim_outbound_deliveries"');
    expect(dispatch).toMatch(/error\.code === "PGRST202" \|\| error\.code === "42883"/);
    expect(dispatch).toContain("{ idempotencyKey: `outbound-delivery:${row.id}` }");
  });
});

describe("reconcile sweeper", () => {
  it("is scheduled and authenticated like every other cron", () => {
    const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string }> };
    expect(vercel.crons.some((cron) => cron.path === "/api/cron/event-cart-orders")).toBe(true);
    const cron = read("src", "app", "api", "cron", "event-cart-orders", "route.ts");
    expect(cron).toContain("const authFailure = getCronAuthFailure(request);");
    expect(cron).toContain("drainEventSettlementOutbox({ admin, stripe, limit: 50 })");
  });
});
