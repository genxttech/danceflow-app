import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildCompetitionStripeRefundParams,
  classifyCompetitionRefundStripeError,
  competitionObservationFromStripeRefund,
  observeCompetitionRefundFromWebhook,
  refundErrorCode,
  type CompetitionRefundRequest,
} from "@/lib/payments/competitionRefunds";
import { buildRefundSummary, parseDollarsToCents } from "@/lib/payments/competitionRefundSummary";
import { createOwnershipFakeSupabase, type Row } from "@/lib/payments/__tests__/ownershipFakes";
import { handleChargeRefunded, handleStripeRefundUpdated } from "@/app/api/payments/webhook/route";
import { buildEventProfitabilityByEventId } from "@/lib/events/financial-summary";

const REQUEST_ID = "0c1d2000-0000-4000-8000-000000000001";
const request: CompetitionRefundRequest = {
  refundId: "0c1d2000-0000-4000-8000-0000000000aa",
  replay: false,
  status: "requested",
  amountCents: 2772,
  currency: "USD",
  paymentIntentId: "pi_r2",
  stripeAccountId: "acct_stored1",
  stripeRefundId: null,
};

describe("Stripe refund parameters (D3, idempotency, stored owner)", () => {
  it("refunds the exact amount on the stored owner's account with a request-scoped idempotency key", () => {
    const { params, options } = buildCompetitionStripeRefundParams(REQUEST_ID, request);
    expect(params).toEqual({
      payment_intent: "pi_r2",
      amount: 2772,
      metadata: { danceflow_refund_request_id: REQUEST_ID, danceflow_refund_id: request.refundId },
    });
    expect(options).toEqual({ stripeAccount: "acct_stored1", idempotencyKey: `comp-refund:${REQUEST_ID}` });
  });

  it("D3: never asks Stripe to refund the platform application fee", () => {
    const { params } = buildCompetitionStripeRefundParams(REQUEST_ID, request);
    expect(params).not.toHaveProperty("refund_application_fee");
    expect(params).not.toHaveProperty("reverse_transfer");
  });

  it("refuses a missing account or a non-integer amount", () => {
    expect(() => buildCompetitionStripeRefundParams(REQUEST_ID, { ...request, stripeAccountId: "" })).toThrow();
    expect(() => buildCompetitionStripeRefundParams(REQUEST_ID, { ...request, amountCents: 10.5 })).toThrow();
    expect(() => buildCompetitionStripeRefundParams(REQUEST_ID, { ...request, amountCents: 0 })).toThrow();
  });
});

describe("Stripe error classification", () => {
  it("definitive refusals release the cap", () => {
    expect(classifyCompetitionRefundStripeError({ type: "StripeInvalidRequestError", statusCode: 400 })).toBe("definitive");
    expect(classifyCompetitionRefundStripeError({ type: "StripePermissionError", statusCode: 403 })).toBe("definitive");
  });

  it("anything that might have created a refund stays unknown (cap held until Stripe reports)", () => {
    expect(classifyCompetitionRefundStripeError({ type: "StripeConnectionError" })).toBe("unknown");
    expect(classifyCompetitionRefundStripeError({ type: "StripeAPIError", statusCode: 500 })).toBe("unknown");
    expect(classifyCompetitionRefundStripeError({ type: "StripeRateLimitError", statusCode: 429 })).toBe("unknown");
    expect(classifyCompetitionRefundStripeError({ statusCode: 409 })).toBe("unknown");
    expect(classifyCompetitionRefundStripeError(new Error("socket hang up"))).toBe("unknown");
  });
});

describe("refund object mapping", () => {
  it("takes the refund's own amount and status, never the cumulative charge total", () => {
    const refund = { id: "re_1", amount: 409, status: "succeeded", metadata: { danceflow_refund_request_id: REQUEST_ID } } as unknown as Stripe.Refund;
    expect(competitionObservationFromStripeRefund(refund)).toEqual({ status: "succeeded", stripeRefundId: "re_1", amountCents: 409, requestId: REQUEST_ID });
  });

  it("drops unknown statuses and malformed request ids", () => {
    const refund = { id: "re_1", amount: 1, status: "weird", metadata: { danceflow_refund_request_id: "x'; drop" } } as unknown as Stripe.Refund;
    expect(competitionObservationFromStripeRefund(refund)).toMatchObject({ status: null, requestId: null });
  });

  it("extracts the stable error code from an RPC message", () => {
    expect(refundErrorCode("COMP_REFUND_EXCEEDS_LINE_CAP: 2273 cents requested")).toBe("COMP_REFUND_EXCEEDS_LINE_CAP");
    expect(refundErrorCode("boom")).toBe("COMP_REFUND_FAILED");
  });
});

describe("dollar parsing", () => {
  it("parses dollars to integer cents", () => {
    expect(parseDollarsToCents("22.72")).toBe(2272);
    expect(parseDollarsToCents("5")).toBe(500);
    expect(parseDollarsToCents("5.5")).toBe(550);
    expect(parseDollarsToCents(" ")).toBeNull();
  });

  it("refuses negatives, more than two decimals and junk", () => {
    expect(() => parseDollarsToCents("-1")).toThrow();
    expect(() => parseDollarsToCents("1.234")).toThrow();
    expect(() => parseDollarsToCents("1e3")).toThrow();
  });
});

describe("refund page summary (same caps as SQL)", () => {
  const items = [
    ...[1, 2, 3, 4].map((n) => ({ id: `i${n}`, item_type: "competition_entry", description: `Entry ${n}`, total_price: 25, metadata: { contest_id: "c1" } })),
    { id: "fee", item_type: "add_on", description: "Fee", total_price: 10, metadata: { line_type: "fee" } },
    { id: "disc", item_type: "add_on", description: "Early bird", total_price: 0, metadata: { line_type: "discount", discount_amount: 10 } },
  ];
  const entries = [1, 2, 3, 4].map((n) => ({
    id: `e${n}`, order_item_id: `i${n}`, display_name: `Entry ${n}`, status: "confirmed", sort_order: n, program_id: "p1", division_id: "d1",
  }));

  it("shows net caps, refunded and remaining, and offers withdrawal only for unplaced / open entries (Q1)", () => {
    const lines = buildRefundSummary({
      items,
      entries,
      placements: [
        { entryId: "e2", heatId: "h1", roundId: "r1", lockState: "locked", status: "scheduled" },
        { entryId: "e3", heatId: "h2", roundId: "r2", lockState: "open", status: "danced" },
        { entryId: "e4", heatId: "h3", roundId: "r2", lockState: "open", status: "scheduled" },
      ],
      allocations: [
        { order_item_id: "i1", amount_cents: 1000, refund_status: "succeeded" },
        { order_item_id: "i1", amount_cents: 500, refund_status: "pending" },
        { order_item_id: "i1", amount_cents: 700, refund_status: "failed" },
      ],
    });
    const byId = Object.fromEntries(lines.map((line) => [line.orderItemId, line]));
    expect(lines.map((line) => line.capCents)).toEqual([2272, 2273, 2273, 2273, 909]);
    expect(byId.i1).toMatchObject({ refundedCents: 1000, remainingCents: 772, canWithdraw: true, participation: "unplaced" });
    expect(byId.i2).toMatchObject({ participation: "locked", canWithdraw: false });
    expect(byId.i3).toMatchObject({ participation: "locked", canWithdraw: false });
    expect(byId.i4).toMatchObject({ participation: "open", canWithdraw: true });
    expect(byId.fee).toMatchObject({ kind: "fee", canWithdraw: false });
    expect(byId.disc).toBeUndefined();
  });
});

describe("event P&L reads C1 refund entries (review P1-3)", () => {
  it("dated competition refunds reduce net revenue; a reversal adds it back; ticket accounting is unchanged", () => {
    const byEvent = buildEventProfitabilityByEventId([
      { eventId: "ev", sourceTable: "event_payments", category: "competition_entry_revenue", grossAmount: 100, refundAmount: 0, feeAmount: 0, netAmount: 100 },
      { eventId: "ev", sourceTable: "event_order_refunds", category: "competition_entry_refund", direction: "debit", refundAmount: 27.72, netAmount: 27.72 },
      { eventId: "ev", sourceTable: "event_order_refunds", category: "competition_entry_refund", direction: "debit", refundAmount: 68.19, netAmount: 68.19 },
      { eventId: "ev", sourceTable: "event_order_refund_reversals", category: "competition_entry_refund", direction: "credit", refundAmount: 27.72, netAmount: 27.72 },
      { eventId: "ev", sourceTable: "event_payments", category: "event_ticket_revenue", grossAmount: 20, refundAmount: 5, feeAmount: 0, netAmount: 15 },
    ]);
    const ev = byEvent.get("ev")!;
    expect(Number(ev.gross_ticket_revenue)).toBe(120);
    expect(Number(ev.refunds)).toBeCloseTo(68.19 + 5, 2);
    expect(Number(ev.net_ticket_revenue)).toBeCloseTo(100 - 68.19 + 15, 2);
  });
});

describe("webhook routing (minimal R2 branch)", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const stripe = {
    charges: { retrieve: async () => ({ payment_intent: "pi_comp", amount_refunded: 2772 }) },
    paymentIntents: { retrieve: async () => { throw new Error("fee sync not modelled"); } },
  } as unknown as Stripe;

  function competitionDb(observed: Row[]) {
    return createOwnershipFakeSupabase(
      {
        payments: [],
        event_payments: [{ id: "ep-1", registration_id: "reg-1", amount: 100, refund_amount: 0, stripe_payment_intent_id: "pi_comp", stripe_account_id: "acct_A" }],
        event_registrations: [{ id: "reg-1", payment_status: "paid", status: "confirmed" }],
      },
      {
        rpcOverride: (name, params) => {
          if (name === "observe_competition_stripe_refund") {
            observed.push(params);
            return { data: { handled: true, outcome: "applied" }, error: null };
          }
          if (name === "is_competition_order_payment_intent") return { data: true, error: null };
          return undefined;
        },
      },
    );
  }

  it("refund.* for a competition PaymentIntent goes to the observe RPC per refund object; the pro-rata path never writes", async () => {
    const observed: Row[] = [];
    const db = competitionDb(observed);
    const refund = { id: "re_c1", amount: 2772, status: "succeeded", payment_intent: "pi_comp", charge: "ch_1", metadata: { danceflow_refund_request_id: REQUEST_ID } } as unknown as Stripe.Refund;

    await handleStripeRefundUpdated(db.client as unknown as SupabaseClient, stripe, refund, "acct_A", "evt_1");

    expect(observed).toEqual([{
      p_payment_intent_id: "pi_comp", p_stripe_account_id: "acct_A", p_stripe_refund_id: "re_c1", p_request_id: REQUEST_ID,
      p_amount_cents: 2772, p_status: "succeeded", p_stripe_event_id: "evt_1",
    }]);
    expect(db.mutations.filter((m) => m.table === "event_payments" || m.table === "event_registrations")).toHaveLength(0);
  });

  it("a pending competition refund is still observed (the ledger records every status)", async () => {
    const observed: Row[] = [];
    const db = competitionDb(observed);
    const refund = { id: "re_c2", amount: 100, status: "pending", payment_intent: "pi_comp", metadata: {} } as unknown as Stripe.Refund;
    await handleStripeRefundUpdated(db.client as unknown as SupabaseClient, stripe, refund, "acct_A");
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ p_status: "pending", p_request_id: null });
  });

  it("charge.refunded for a competition PaymentIntent never applies the pro-rata event path", async () => {
    const db = competitionDb([]);
    const charge = { id: "ch_1", payment_intent: "pi_comp", amount_refunded: 2772, refunds: { data: [{ id: "re_c1" }] } } as unknown as Stripe.Charge;
    await handleChargeRefunded(db.client as unknown as SupabaseClient, stripe, charge, "acct_A");
    expect(db.mutations.filter((m) => m.table === "event_payments" || m.table === "event_registrations")).toHaveLength(0);
  });

  it("an unknown refund status falls back to routing only (no observe call)", async () => {
    const observed: Row[] = [];
    const db = competitionDb(observed);
    const refund = { id: "re_c3", amount: 100, status: "weird", payment_intent: "pi_comp" } as unknown as Stripe.Refund;
    const handled = await observeCompetitionRefundFromWebhook(db.adminClient as unknown as SupabaseClient, refund, "pi_comp", "acct_A", null);
    expect(handled).toBe(true);
    expect(observed).toHaveLength(0);
  });
});
