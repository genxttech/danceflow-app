import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { handleCheckoutSessionCompleted, handleCompetitionRegistrationCheckoutEvent } from "@/app/api/payments/webhook/route";

/**
 * Phase 10C: competition Checkout Sessions are finalized/released ONLY through the database
 * lifecycle functions; the generic event-cart fulfilment (which writes event_orders /
 * event_registrations / event_payments directly) never runs for them.
 */

const ORDER = "11111111-2222-4333-8444-555555555555";

function fakeSupabase(outcome = "finalized") {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const writes: string[] = [];
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    for (const method of ["select", "eq", "in", "order", "limit", "is", "neq"]) self[method] = () => self;
    self.maybeSingle = async () => ({ data: null, error: null });
    self.single = async () => ({ data: null, error: null });
    self.update = () => { writes.push(`update:${table}`); return self; };
    self.insert = () => { writes.push(`insert:${table}`); return self; };
    self.then = (resolve: (value: unknown) => void) => resolve({ data: [], error: null });
    return self;
  };
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return { data: { outcome }, error: null };
    },
    from: (table: string) => chain(table),
  };
  return { supabase: client as unknown as SupabaseClient, rpcCalls, writes };
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "cs_comp_1",
    payment_status: "paid",
    payment_intent: null,
    amount_total: 10330,
    currency: "usd",
    metadata: { source: "competition_registration", order_id: ORDER },
    ...overrides,
  } as unknown as Stripe.Checkout.Session;
}

const stripe = {} as Stripe;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("competition registration webhook routing", () => {
  it("checkout.session.completed finalizes through finalize_competition_registration with no direct event writes", async () => {
    const { supabase, rpcCalls, writes } = fakeSupabase();
    await handleCheckoutSessionCompleted(supabase, stripe, session(), "acct_studioA", "evt_1", "checkout.session.completed");
    expect(rpcCalls.map((call) => call.name)).toEqual(["finalize_competition_registration"]);
    expect(rpcCalls[0].args).toMatchObject({ p_order_id: ORDER, p_stripe_account_id: "acct_studioA", p_checkout_session_id: "cs_comp_1", p_amount_cents: 10330, p_currency: "USD" });
    expect(writes.filter((write) => /event_orders|event_registrations|event_payments/.test(write))).toEqual([]);
  });

  it("a replayed delivery is idempotent at the database (already_finalized) and still writes nothing directly", async () => {
    const { supabase, rpcCalls, writes } = fakeSupabase("already_finalized");
    await handleCheckoutSessionCompleted(supabase, stripe, session(), "acct_studioA", "evt_1", "checkout.session.completed");
    await handleCheckoutSessionCompleted(supabase, stripe, session(), "acct_studioA", "evt_1", "checkout.session.completed");
    expect(rpcCalls).toHaveLength(2);
    expect(writes.filter((write) => /event_orders|event_registrations|event_payments/.test(write))).toEqual([]);
  });

  it("checkout.session.expired releases the order bound to that session", async () => {
    const { supabase, rpcCalls } = fakeSupabase("released");
    const handled = await handleCompetitionRegistrationCheckoutEvent(supabase, stripe, session({ payment_status: "unpaid" }), "acct_studioA", "checkout.session.expired");
    expect(handled).toBe(true);
    expect(rpcCalls[0]).toMatchObject({ name: "release_competition_registration", args: { p_order_id: ORDER, p_reason: "expired", p_checkout_session_id: "cs_comp_1", p_stripe_account_id: "acct_studioA" } });
  });

  it("ordinary event sessions are not claimed by the competition handler", async () => {
    const { supabase, rpcCalls } = fakeSupabase();
    const handled = await handleCompetitionRegistrationCheckoutEvent(supabase, stripe, session({ metadata: { source: "event_cart_order", order_id: ORDER } }), "acct_studioA", "checkout.session.completed");
    expect(handled).toBe(false);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a platform-scope (no event.account) competition event is refused", async () => {
    const { supabase, rpcCalls } = fakeSupabase();
    await expect(handleCheckoutSessionCompleted(supabase, stripe, session(), null, "evt_1", "checkout.session.completed")).rejects.toThrow();
    expect(rpcCalls).toHaveLength(0);
  });
});
