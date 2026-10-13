import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PAY-WH-1A source guards: application wiring of the audit remediation that must not regress. Behaviour is covered by
 * terminalEventSale.paywh1a, settlementAlerts.paywh1a, the Postgres suites (test_T_paywh1a_remediation.sql,
 * paywh1a_concurrency.sh) and the Stripe test-mode E2E spec.
 */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8").replace(/\r\n/g, "\n");

describe("initial payment-method scope: card only for ordinary event carts", () => {
  const checkout = read("src", "app", "api", "events", "cart", "checkout", "route.ts");
  const resume = read("src", "lib", "events", "event-order-payment.ts");
  it("web Checkout Sessions (new and resumed) accept cards only", () => {
    for (const source of [checkout, resume]) {
      expect(source).toMatch(/stripe\.checkout\.sessions\.create\(\s*\{\s*mode: "payment",[\s\S]*?payment_method_types: \["card"\],/);
    }
  });
  it("native PaymentSheet PaymentIntents accept cards only (no automatic/delayed methods)", () => {
    expect(resume).toMatch(/stripe\.paymentIntents\.create\(\s*\{[\s\S]*?payment_method_types: \["card"\],/);
    expect(resume).not.toContain("automatic_payment_methods");
  });
});

describe("box-office capacity (M-2)", () => {
  it("a card-reader sale is created with its terminal hold", () => {
    const sell = read("src", "app", "app", "events", "sell-tickets", "actions.ts");
    expect(sell).toContain("terminal_hold_until: useCardReader ? new Date(Date.now() + 15 * 60_000).toISOString() : null,");
  });
  it("the reader is started only after the database re-takes the hold (capacity re-checked before any charge)", () => {
    const start = read("src", "app", "api", "stripe", "terminal", "payments", "start", "route.ts");
    expect(start).toContain(
      'if (payment.payment_type === "event_registration" && payment.external_reference) {\n      const { data: hold, error: holdError } = await supabase.rpc("hold_terminal_event_registration", {',
    );
    expect(start).toContain('if (holdError || holdResult.ok !== true) {');
    const hold = start.indexOf('supabase.rpc("hold_terminal_event_registration"');
    expect(hold).toBeGreaterThan(0);
    expect(hold).toBeLessThan(start.indexOf("stripe.paymentIntents.create("));
    expect(start).toContain('"terminal_tickets_unavailable"');
  });
  it("cancelled / failed reader payments release the hold", () => {
    for (const route of ["cancel", "refresh"]) {
      expect(read("src", "app", "api", "stripe", "terminal", "payments", route, "route.ts")).toContain("await releaseTerminalEventHold({");
    }
  });
  it("fulfilment confirms through the database and a not-fulfilled charge is surfaced, never reported as success", () => {
    const fulfilment = read("src", "lib", "payments", "terminal-fulfillment.ts");
    expect(fulfilment).toContain('supabase.rpc("confirm_terminal_event_registration"');
    expect(fulfilment).not.toMatch(/\.from\("event_registrations"\)\s*\.update\(\{\s*status: "confirmed",/);
    expect(fulfilment).not.toMatch(/event_id: registration\.event_id,\s*registration_id/);
    for (const route of ["cancel", "refresh"]) {
      expect(read("src", "app", "api", "stripe", "terminal", "payments", route, "route.ts"))
        .toContain('if (error instanceof TerminalEventNotFulfilledError) {');
    }
    expect(read("src", "app", "api", "payments", "webhook", "route.ts")).toContain("if (error instanceof TerminalEventNotFulfilledError) return true;");
  });
});

describe("competition desk payments (M-1)", () => {
  const desk = read("src", "app", "app", "events", "[id]", "competition", "checkin", "actions.ts");
  it("go through the locked database operation; no client writes of payments, registrations or orders", () => {
    const action = desk.slice(desk.indexOf("export async function recordCompetitionCheckinPaymentAction"), desk.indexOf("export async function completeCompetitionCheckinAction"));
    expect(action).toContain('supabase.rpc("record_competition_checkin_payment"');
    expect(action).not.toContain('.from("event_payments")');
    expect(action).not.toContain('.from("event_registrations")');
    expect(action).not.toContain('.from("event_orders")');
  });
});

describe("related settlement-integrity fixes", () => {
  it("the legacy single-registration Checkout branch only settles orderless registrations", () => {
    const webhook = read("src", "app", "api", "payments", "webhook", "route.ts");
    const branch = webhook.slice(webhook.indexOf("async function handleEventRegistrationCheckoutCompleted"));
    expect(branch.slice(0, 3000)).toMatch(/\.eq\("id", registrationId\)\s*\/\/[^\n]*\n\s*\.is\("order_id", null\)/);
    expect(branch).toContain('throw new Error("event_registration_checkout_not_orderless")');
  });
  it("staff mark-paid and refund refuse order-backed registrations before any write or Stripe call", () => {
    const actions = read("src", "app", "app", "events", "[id]", "registrations", "actions.ts");
    for (const name of ["markEventRegistrationPaidAction", "refundEventRegistrationAction"]) {
      const body = actions.slice(actions.indexOf(`export async function ${name}`));
      const refusal = body.indexOf('error=order_backed_registration_payment_locked');
      expect(refusal).toBeGreaterThan(0);
      for (const later of ["markRegistrationPaymentStatus(", "stripe.refunds.create("]) {
        const at = body.indexOf(later);
        if (at > 0 && at < body.indexOf("\nexport async function", 10)) expect(refusal).toBeLessThan(at);
      }
    }
  });
  it("the sweeper records reconcile outcomes (backoff), drains staff alerts and runs every 5 minutes", () => {
    const cron = read("src", "app", "api", "cron", "event-cart-orders", "route.ts");
    expect(cron).toContain('admin.rpc("note_event_cart_reconcile_outcome"');
    expect(cron).toContain("drainSettlementExceptionAlerts({ admin, limit: 50 })");
    const vercel = JSON.parse(read("vercel.json")) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons.find((cron) => cron.path === "/api/cron/event-cart-orders")?.schedule).toBe("*/5 * * * *");
  });
  it("webhook settlement logs every recorded exception and delivers its alert right away (cron is the backstop)", () => {
    const cartWebhook = read("src", "lib", "events", "cartWebhook.ts");
    expect(cartWebhook).toContain('console.error("event cart payment exception recorded", result.outcome, result.exception_id);');
    expect(cartWebhook).toContain("await drainSettlementExceptionAlerts({ admin, limit: 5 });");
  });
});

describe("exception visibility", () => {
  it("the event registrations page shows the exceptions panel; the platform has an oversight page", () => {
    expect(read("src", "app", "app", "events", "[id]", "registrations", "page.tsx")).toContain("<PaymentExceptionsPanel eventId={typedEvent.id} />");
    const platform = read("src", "app", "platform", "payment-exceptions", "page.tsx");
    expect(platform.indexOf("await requirePlatformAdmin();")).toBeLessThan(platform.indexOf("createAdminClient()"));
    expect(read("src", "app", "platform", "PlatformAdminNav.tsx")).toContain('href: "/platform/payment-exceptions"');
  });
});
