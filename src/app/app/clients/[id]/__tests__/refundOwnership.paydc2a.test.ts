import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOwnershipFakeSupabase,
  createStripeRecorder,
  stripeError,
  type Row,
} from "@/lib/payments/__tests__/ownershipFakes";

/**
 * PAY-DC-2A: client payment refunds use the stored immutable owner; the studio's
 * current connected account is only a D1(b) proof candidate for NULL ownership.
 */

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";
const A = "acct_storedA";
const B = "acct_currentB";

let db: ReturnType<typeof createOwnershipFakeSupabase>;
let recorder: ReturnType<typeof createStripeRecorder>;

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => db.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO_ID, studioRole: "studio_owner" }),
}));
vi.mock("@/lib/payments/stripe", () => ({ getStripe: () => recorder.stripe }));

import { refundClientPaymentAction } from "@/app/app/clients/[id]/actions";

function payment(overrides: Row = {}): Row {
  return {
    id: "pay-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    amount: 50,
    currency: "usd",
    status: "paid",
    payment_type: "package",
    notes: null,
    stripe_payment_intent_id: "pi_1",
    stripe_charge_id: null,
    stripe_refund_id: null,
    refund_amount: 0,
    stripe_account_id: null,
    ...overrides,
  };
}

function seed(paymentRow: Row, studioAccount: string | null = B) {
  db = createOwnershipFakeSupabase({
    payments: [paymentRow],
    studios: [{ id: STUDIO_ID, stripe_connected_account_id: studioAccount }],
  });
}

async function refund(amount = "50") {
  const form = new FormData();
  form.set("clientId", CLIENT_ID);
  form.set("paymentId", "pay-1");
  form.set("amount", amount);
  form.set("reason", "Customer request");
  form.set("returnTo", `/app/clients/${CLIENT_ID}`);
  try {
    await refundClientPaymentAction(form);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return decodeURIComponent(digest.split(";")[2] ?? "");
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stored owner is authoritative", () => {
  it("stored A + studio currently B -> refund only on A; B is never used and the studio is not loaded", async () => {
    seed(payment({ stripe_account_id: A }), B);
    recorder = createStripeRecorder({ objectAccounts: { pi_1: A } });

    const url = await refund();

    expect(url).toContain("success=payment_refunded");
    expect(recorder.calls.map((call) => call.method)).toEqual(["refunds.create"]);
    expect(recorder.accountsUsed()).toEqual([A]);
    expect(recorder.accountsUsed()).not.toContain(B);
    expect(db.fromCalls).not.toContain("studios");
    expect(db.rows("payments")[0]).toMatchObject({ status: "refunded", stripe_refund_id: "re_test_1", stripe_account_id: A });
  });

  it.each([
    ["resource_missing", { code: "resource_missing", statusCode: 404 }],
    ["account_invalid", { code: "account_invalid", statusCode: 400 }],
    ["permission", { statusCode: 403, type: "StripePermissionError" }],
  ])("Stripe rejects stored A (%s) -> fails closed, no DB mutation, no fallback", async (_label, fields) => {
    seed(payment({ stripe_account_id: A }), B);
    recorder = createStripeRecorder({ refundError: stripeError(fields) });

    const url = await refund();

    expect(url).toContain("error=refund_payment_account_unavailable");
    expect(url).not.toMatch(/acct_|stripe error/);
    expect(recorder.accountsUsed()).toEqual([A]);
    expect(db.mutations).toHaveLength(0);
    expect(db.rows("payments")[0]).toMatchObject({ status: "paid", stripe_refund_id: null });
  });

  it("other Stripe refund failure on stored A -> refund_stripe_failed, no DB mutation", async () => {
    seed(payment({ stripe_account_id: A }), B);
    recorder = createStripeRecorder({ refundError: stripeError({ code: "charge_disputed", statusCode: 400 }) });

    const url = await refund();

    expect(url).toContain("error=refund_stripe_failed");
    expect(db.mutations).toHaveLength(0);
  });
});

describe("historical NULL owner (D1(b))", () => {
  it("NULL + studio currently B -> retrieve on B, persist B, then refund on B (in order)", async () => {
    seed(payment(), B);
    recorder = createStripeRecorder({ objectAccounts: { pi_1: B } });

    const url = await refund();

    expect(url).toContain("success=payment_refunded");
    expect(recorder.calls.map((call) => call.method)).toEqual(["paymentIntents.retrieve", "refunds.create"]);
    expect(recorder.accountsUsed()).toEqual([B, B]);
    const ownerWrite = db.mutations.findIndex((m) => m.values.stripe_account_id === B);
    expect(ownerWrite).toBeGreaterThanOrEqual(0);
    // REFUND-RECON-1: the refund is recorded by the canonical reconciliation RPC (after the owner was persisted and
    // Stripe confirmed the refund on B), never by a direct status/refund-id write.
    expect(db.mutations.some((m) => "stripe_refund_id" in m.values || "status" in m.values)).toBe(false);
    expect(db.rpcCalls.map((call) => call.name)).toEqual(["_apply_payment_refund_and_reevaluate"]);
    expect(db.rpcCalls[0].params).toMatchObject({ p_payment_id: "pay-1", p_stripe_refund_id: "re_test_1" });
    expect(db.rows("payments")[0]).toMatchObject({ stripe_account_id: B, status: "refunded", stripe_refund_id: "re_test_1" });
  });

  it("NULL, not found on B -> no refund, unverified", async () => {
    seed(payment(), B);
    recorder = createStripeRecorder({ objectAccounts: { pi_1: "acct_platformOrOther" } });

    const url = await refund();

    expect(url).toContain("error=refund_payment_account_unverified");
    expect(recorder.calls.map((call) => call.method)).toEqual(["paymentIntents.retrieve"]);
    expect(recorder.accountsUsed()).toEqual([B]);
    expect(db.mutations).toHaveLength(0);
  });

  it("NULL, studio has no connected account -> zero Stripe calls", async () => {
    seed(payment(), null);
    recorder = createStripeRecorder();

    const url = await refund();

    expect(url).toContain("error=refund_stripe_not_connected");
    expect(recorder.calls).toHaveLength(0);
    expect(db.mutations).toHaveLength(0);
  });

  it("NULL, verification error -> no refund, check failed", async () => {
    seed(payment(), B);
    recorder = createStripeRecorder({ retrieveError: stripeError({ statusCode: 500, type: "StripeAPIError" }) });

    const url = await refund();

    expect(url).toContain("error=refund_ownership_check_failed");
    expect(recorder.calls.some((call) => call.method === "refunds.create")).toBe(false);
  });

  it("never calls Stripe without a stripeAccount (no platform fallback)", async () => {
    seed(payment(), B);
    recorder = createStripeRecorder({ objectAccounts: { pi_1: B } });

    await refund();

    expect(recorder.accountsUsed().every((account) => typeof account === "string" && account.startsWith("acct_"))).toBe(true);
  });
});

describe("existing gates unchanged", () => {
  it("unpaid payments are refused before any Stripe call", async () => {
    seed(payment({ status: "pending", stripe_account_id: A }));
    recorder = createStripeRecorder();

    expect(await refund()).toContain("error=refund_payment_not_paid");
    expect(recorder.calls).toHaveLength(0);
  });

  it("amounts above the remaining balance are refused before any Stripe call", async () => {
    seed(payment({ stripe_account_id: A }));
    recorder = createStripeRecorder();

    expect(await refund("60")).toContain("error=refund_exceeds_remaining");
    expect(recorder.calls).toHaveLength(0);
  });
});
