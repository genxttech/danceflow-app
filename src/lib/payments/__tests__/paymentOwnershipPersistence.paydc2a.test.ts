import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PAY-DC-2A source guards: every approved connected-charge write path persists the
 * exact account passed to Stripe, the migration backfills only provable Terminal
 * rows, and stored-owner refund paths never consult the studio's current account.
 */

const read = (...parts: string[]) => readFileSync(join(process.cwd(), ...parts), "utf8");

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  return source.slice(from, to === -1 ? undefined : to);
}

describe("creation-time ownership persistence", () => {
  it("client checkout stamps the account the session was created on", () => {
    const source = read("src", "lib", "payments", "client-checkout-session.ts");
    expect(source).toMatch(/stripeAccount: connectedAccountId,[\s\S]*stripe_account_id: connectedAccountId,/);
  });

  it("portal floor rental stamps the account the session was created on", () => {
    const source = read("src", "lib", "payments", "portal-floor-rental-checkout-session.ts");
    expect(source).toMatch(/stripeAccount: connectedAccountId,[\s\S]*stripe_account_id: connectedAccountId,/);
  });

  it("Terminal take-payment stamps the PaymentIntent's account", () => {
    const source = read("src", "app", "api", "stripe", "terminal", "payments", "start", "route.ts");
    expect(source).toMatch(/stripe_payment_intent_id: paymentIntent\.id,\s*\/\/[^\n]*\n\s*stripe_account_id: connectedAccountId,/);
  });

  it("Quick Charge / Quick Pay stamps the PaymentIntent's account", () => {
    const source = read("src", "lib", "payments", "terminal-quick-charge.ts");
    expect(source).toMatch(/stripe_payment_intent_id: paymentIntent\.id,\s*\/\/[^\n]*\n\s*stripe_account_id: studio\.stripe_connected_account_id,/);
    expect(source).toMatch(/stripeAccount: studio\.stripe_connected_account_id, idempotencyKey/);
  });

  it("Terminal ticket fulfilment stamps event_payments from the terminal session", () => {
    const source = read("src", "lib", "payments", "terminal-fulfillment.ts");
    expect(source).toContain("stripe_payment_intent_id, stripe_account_id");
    expect(source).toContain("stripe_account_id: session.stripe_account_id ?? null");
    expect(source).toMatch(/update\(\{ stripe_account_id: session\.stripe_account_id \}\)[\s\S]*?\.is\("stripe_account_id", null\)/);
  });

  it("connected event and membership webhook writes stamp event.account", () => {
    const source = read("src", "app", "api", "payments", "webhook", "route.ts");
    expect(source.match(/stripe_account_id: stripeAccountId \?\? null,/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(source).toContain("await stampEventPaymentOwner(supabase, existingPayment.id, stripeAccountId);");
  });
});

describe("migration", () => {
  const sql = read("src", "lib", "supabase", "migrations", "20260926120000_paydc2a_payment_stripe_account_ownership.sql");
  const statements = sql.replace(/--[^\n]*/g, "");

  it("adds nullable ownership columns, format checks, indexes and the immutability trigger", () => {
    expect(statements).toMatch(/alter table public\.payments\s+add column if not exists stripe_account_id text null/);
    expect(statements).toMatch(/alter table public\.event_payments\s+add column if not exists stripe_account_id text null/);
    expect(statements).toContain("payments_stripe_account_id_format");
    expect(statements).toContain("event_payments_stripe_account_id_format");
    expect(statements).toContain("payments_stripe_account_pi_idx");
    expect(statements).toContain("event_payments_stripe_account_pi_idx");
    expect(statements).toContain("before update of stripe_account_id on public.payments");
    expect(statements).toContain("before update of stripe_account_id on public.event_payments");
    expect(statements).toMatch(/old\.stripe_account_id is not null\s+and new\.stripe_account_id is distinct from old\.stripe_account_id/);
  });

  it("backfills only payments, only from terminal_payment_sessions on id + PI + studio", () => {
    const updates = statements.match(/update public\.[a-z_]+/g) ?? [];
    expect(updates).toEqual(["update public.payments"]);
    expect(statements).toContain("from public.terminal_payment_sessions tps");
    expect(statements).toContain("p.terminal_payment_session_id = tps.id");
    expect(statements).toContain("tps.stripe_payment_intent_id = p.stripe_payment_intent_id");
    expect(statements).toContain("tps.studio_id = p.studio_id");
    expect(statements).toContain("p.stripe_account_id is null");
  });

  it("never infers ownership from the studio's current connected account", () => {
    expect(statements).not.toContain("stripe_connected_account_id");
    expect(statements).not.toContain("studios");
  });
});

describe("stored-owner refund paths never consult the current studio account", () => {
  it("client refund loads the studio account only in the NULL-ownership branch", () => {
    const source = read("src", "app", "app", "clients", "[id]", "actions.ts");
    const action = sliceBetween(source, "export async function refundClientPaymentAction", "\nexport async function ");
    const storedBranch = sliceBetween(action, 'if (storedOwner.kind === "stored") {', "} else {");
    expect(storedBranch).not.toContain("stripe_connected_account_id");
    expect(storedBranch).not.toContain("studios");
    expect(action).toContain("stripeAccount: refundStripeAccount");
    expect(action).not.toMatch(/stripeAccount: studio\./);
  });

  it("event refund uses the stored owner in the stored branch and never the platform", () => {
    const source = read("src", "app", "app", "events", "[id]", "registrations", "actions.ts");
    const action = sliceBetween(source, "export async function refundEventRegistrationAction", "\nasync function loadEventRefundOwnership");
    const storedBranch = sliceBetween(action, 'if (storedOwner.kind === "stored") {', "} else {");
    expect(storedBranch).not.toContain("stripe_connected_account_id");
    expect(action).toContain("stripeAccount: refundStripeAccount");
    expect(action).toContain("if (isRedirectError(error)) throw error;");
  });
});
