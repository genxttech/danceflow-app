import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyRefundStripeError,
  isRefundOwnershipErrorCode,
  persistProvenStripeAccount,
  proveStripeAccountOwnership,
  REFUND_OWNERSHIP_ERROR_MESSAGES,
  selectStoredStripeAccount,
} from "@/lib/payments/paymentStripeAccount";
import { createOwnershipFakeSupabase, createStripeRecorder, stripeError } from "./ownershipFakes";

/** PAY-DC-2A: ownership helper — stored owner authoritative, NULL proven via Stripe only. */

const A = "acct_storedA";
const B = "acct_currentB";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("selectStoredStripeAccount", () => {
  it("one distinct stored owner is authoritative", () => {
    expect(selectStoredStripeAccount([A])).toEqual({ kind: "stored", stripeAccount: A });
    expect(selectStoredStripeAccount([A, A, null, undefined, ""])).toEqual({ kind: "stored", stripeAccount: A });
  });

  it("conflicting stored owners are a conflict", () => {
    expect(selectStoredStripeAccount([A, "acct_otherC"])).toEqual({ kind: "conflict" });
  });

  it("no stored owner is none", () => {
    expect(selectStoredStripeAccount([])).toEqual({ kind: "none" });
    expect(selectStoredStripeAccount([null, undefined])).toEqual({ kind: "none" });
  });

  it("takes no current-account input at all", () => {
    expect(selectStoredStripeAccount.length).toBe(1);
  });
});

describe("proveStripeAccountOwnership (D1(b), NULL rows only)", () => {
  it("no candidate account -> not connected, zero Stripe calls", async () => {
    const recorder = createStripeRecorder();
    const result = await proveStripeAccountOwnership({
      candidateAccountId: null,
      paymentIntentId: "pi_1",
      chargeId: null,
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(result).toEqual({ ok: false, code: "refund_stripe_not_connected" });
    expect(recorder.calls).toHaveLength(0);
  });

  it("successful account-scoped retrieve proves ownership", async () => {
    const recorder = createStripeRecorder({ objectAccounts: { pi_1: B } });
    const result = await proveStripeAccountOwnership({
      candidateAccountId: B,
      paymentIntentId: "pi_1",
      chargeId: "ch_1",
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(result).toEqual({ ok: true, stripeAccount: B });
    expect(recorder.calls.map((call) => call.method)).toEqual(["paymentIntents.retrieve"]);
    expect(recorder.accountsUsed()).toEqual([B]);
  });

  it("charge-only rows are proven via charges.retrieve", async () => {
    const recorder = createStripeRecorder({ objectAccounts: { ch_1: B } });
    const result = await proveStripeAccountOwnership({
      candidateAccountId: B,
      paymentIntentId: null,
      chargeId: "ch_1",
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(result).toEqual({ ok: true, stripeAccount: B });
    expect(recorder.calls.map((call) => call.method)).toEqual(["charges.retrieve"]);
  });

  it("not found on the candidate -> unverified", async () => {
    const recorder = createStripeRecorder({ objectAccounts: { pi_1: "acct_elsewhere" } });
    const result = await proveStripeAccountOwnership({
      candidateAccountId: B,
      paymentIntentId: "pi_1",
      chargeId: null,
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(result).toEqual({ ok: false, code: "refund_payment_account_unverified" });
  });

  it("any other verification error -> check failed", async () => {
    const recorder = createStripeRecorder({ retrieveError: stripeError({ statusCode: 500, type: "StripeAPIError" }) });
    const result = await proveStripeAccountOwnership({
      candidateAccountId: B,
      paymentIntentId: "pi_1",
      chargeId: null,
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(result).toEqual({ ok: false, code: "refund_ownership_check_failed" });
  });

  it("never calls Stripe without a stripeAccount and never refunds", async () => {
    const recorder = createStripeRecorder({ objectAccounts: { pi_1: B } });
    await proveStripeAccountOwnership({
      candidateAccountId: B,
      paymentIntentId: "pi_1",
      chargeId: null,
      stripe: recorder.stripe as unknown as Stripe,
    });
    expect(recorder.accountsUsed().every((account) => typeof account === "string" && account.length > 0)).toBe(true);
    expect(recorder.calls.some((call) => call.method === "refunds.create")).toBe(false);
  });
});

describe("classifyRefundStripeError", () => {
  it.each([
    [{ code: "resource_missing", statusCode: 404 }],
    [{ code: "account_invalid", statusCode: 400 }],
    [{ statusCode: 401, type: "StripeAuthenticationError" }],
    [{ statusCode: 403, type: "StripePermissionError" }],
  ])("%o -> refund_payment_account_unavailable", (fields) => {
    expect(classifyRefundStripeError(stripeError(fields))).toBe("refund_payment_account_unavailable");
  });

  it("other failures -> refund_stripe_failed", () => {
    expect(classifyRefundStripeError(stripeError({ code: "charge_already_refunded", statusCode: 400 }))).toBe(
      "refund_stripe_failed",
    );
    expect(classifyRefundStripeError(new Error("network"))).toBe("refund_stripe_failed");
  });
});

describe("persistProvenStripeAccount", () => {
  it("sets the owner only on NULL rows", async () => {
    const db = createOwnershipFakeSupabase({ payments: [{ id: "pay-1", stripe_account_id: null }] });
    const ok = await persistProvenStripeAccount({
      supabase: db.client as unknown as SupabaseClient,
      table: "payments",
      ids: ["pay-1"],
      stripeAccount: B,
    });
    expect(ok).toBe(true);
    expect(db.rows("payments")[0].stripe_account_id).toBe(B);
  });

  it("a concurrent different owner is a failure (immutability)", async () => {
    const db = createOwnershipFakeSupabase({ payments: [{ id: "pay-1", stripe_account_id: A }] });
    const ok = await persistProvenStripeAccount({
      supabase: db.client as unknown as SupabaseClient,
      table: "payments",
      ids: ["pay-1"],
      stripeAccount: B,
    });
    expect(ok).toBe(false);
    expect(db.rows("payments")[0].stripe_account_id).toBe(A);
  });
});

describe("fixed messages", () => {
  it("every ownership code has a message without account ids or provider text", () => {
    for (const [code, message] of Object.entries(REFUND_OWNERSHIP_ERROR_MESSAGES)) {
      expect(isRefundOwnershipErrorCode(code)).toBe(true);
      expect(message).not.toMatch(/acct_|pi_|ch_|stripe error/i);
    }
    expect(isRefundOwnershipErrorCode("refund_failed")).toBe(false);
  });

  it("the helper never references the platform or current studio configuration", () => {
    const source = readFileSync(join(process.cwd(), "src", "lib", "payments", "paymentStripeAccount.ts"), "utf8");
    expect(source).not.toContain("stripe_connected_account_id");
    expect(source).not.toContain("getStripe");
  });
});
