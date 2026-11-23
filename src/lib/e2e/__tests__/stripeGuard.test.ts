import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFeeRecorded, CHECKOUT_PAYMENT_NOT_PROVEN, classifyStripeError, redactReport, runStripeGuard, serializeReport, summarizeReport, type GuardConfig, type GuardReport } from "../stripeGuard";

const PLATFORM = "acct_PLATFORM1";
const CONNECTED = "acct_CONNECTED1";
const config: GuardConfig = { expectPlatform: PLATFORM, connectedAccount: CONNECTED, successUrl: "http://127.0.0.1:3000/ok", cancelUrl: "http://127.0.0.1:3000/no" };
const KEY = "sk_test_unit123";

/** Lets a test replace the production verifier (to prove the guard fails when a verifier ACCEPTS what it must refuse, or throws a Stripe error). */
const verifierOverride = vi.hoisted(() => ({ fn: null as null | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock("../../competition/registrationLifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../competition/registrationLifecycle")>();
  return { ...actual, verifySettlementWithStripe: (...args: Parameters<typeof actual.verifySettlementWithStripe>) => (verifierOverride.fn ? verifierOverride.fn(...args) : actual.verifySettlementWithStripe(...args)) };
});
afterEach(() => { verifierOverride.fn = null; });

type Overrides = Partial<{
  live: boolean; platformId: string; createError: unknown; piError: unknown; retrieveError: unknown; expireError: unknown; fee: number | null; chargeFee: string | null; chargeFeeAmount: number | null; received: number; expireStatus: string;
  /** Stripe shows the retrieved session as complete/paid (what a real paid session would look like). */
  retrievePaid: boolean; lostMetadata: boolean;
}>;

type FakeSession = { id: string; object: string; mode: string; status: string; payment_status: string; livemode: boolean; payment_intent: unknown; amount_total: number; currency: string; metadata: Record<string, string> };

/** A Stripe-shaped fake that records calls; every call that needs the connected account must pass stripeAccount. */
function fakeStripe(o: Overrides = {}) {
  const calls: string[] = [];
  const sessions = new Map<string, FakeSession>();
  const created: Array<Record<string, unknown>> = [];
  let n = 0;
  const stripe = {
    balance: { retrieve: async () => ({ livemode: o.live ?? false }) },
    accounts: {
      retrieve: async (id: string) => (
        { id, charges_enabled: false, payouts_enabled: false, capabilities: { card_payments: "inactive", transfers: "inactive" }, requirements: { currently_due: new Array(7).fill("x"), disabled_reason: "requirements.past_due" } }
      ),
    },
    checkout: {
      sessions: {
        create: async (params: { metadata?: Record<string, string> }, opts: { stripeAccount?: string }) => {
          calls.push(`create:${opts?.stripeAccount}`);
          if (o.createError) throw o.createError;
          created.push(params as Record<string, unknown>);
          const id = `cs_test_a1b2c3d4e5${++n}`;
          sessions.set(id, { id, object: "checkout.session", mode: "payment", status: "open", payment_status: "unpaid", livemode: false, payment_intent: null, amount_total: 100, currency: "usd", metadata: params.metadata ?? {} });
          return sessions.get(id)!;
        },
        expire: async (id: string, _p: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`expire:${opts?.stripeAccount}`);
          if (o.expireError) throw o.expireError;
          const s = sessions.get(id)!;
          s.status = o.expireStatus ?? "expired";
          return s;
        },
        retrieve: async (id: string, _p: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`retrieve:${opts?.stripeAccount}`);
          if (o.retrieveError) throw o.retrieveError;
          const s = { ...sessions.get(id)! };
          if (o.lostMetadata) s.metadata = {};
          if (o.retrievePaid) return { ...s, status: "complete", payment_status: "paid", payment_intent: { id: "pi_test_C1234abcd", status: "succeeded", amount_received: 100, currency: "usd" } };
          return s;
        },
      },
    },
    rawRequest: async (_method: string, path: string) => {
      if (path === "/v1/account") { calls.push("account-read"); return { id: o.platformId ?? PLATFORM }; }
      return { livemode: false, total_summary: { due: 100 } };
    },
    paymentIntents: {
      create: async (_params: unknown, opts: { stripeAccount?: string }) => {
        calls.push(`pi:${opts?.stripeAccount}`);
        if (o.piError) throw o.piError;
        return {
          id: "pi_test_C1234abcd", currency: "usd", amount: 100, status: "succeeded", amount_received: o.received ?? 100, application_fee_amount: o.fee === undefined ? 10 : o.fee,
          latest_charge: { application_fee: o.chargeFee === undefined ? "fee_1" : o.chargeFee, application_fee_amount: o.chargeFeeAmount === undefined ? 10 : o.chargeFeeAmount },
        };
      },
    },
  };
  return { stripe: stripe as never, calls, created };
}

const stripeError = (over: Record<string, unknown>) => Object.assign(new Error(String(over.message)), over);

describe("stripe guard", () => {
  it("passes: records the restricted account state, proves session creation (A), a documented-API card payment with the fee (C), then the settlement verifier against real shapes (D1, D2)", async () => {
    const { stripe, calls } = fakeStripe();
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(true);
    expect(report.connected).toMatchObject({ charges_enabled: false, card_payments: "inactive", currently_due_count: 7 });
    expect(report.steps.map((s) => s.name).filter((name) => name.startsWith("canary"))).toHaveLength(4);
    expect(calls.filter((c) => c.startsWith("create")).every((c) => c === `create:${CONNECTED}`)).toBe(true);
    expect(calls).toContain(`expire:${CONNECTED}`);
  });

  it("refuses a live key shape before any Stripe call, and a live balance", async () => {
    const a = fakeStripe();
    expect((await runStripeGuard({ stripe: a.stripe, key: "sk_live_abc123", config })).ok).toBe(false);
    expect(a.calls).toEqual([]);
    const b = await runStripeGuard({ stripe: fakeStripe({ live: true }).stripe, key: KEY, config });
    expect(b.ok).toBe(false);
    expect(b.stop?.step).toBe("identity");
  });

  it("refuses a key from a different Stripe account", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ platformId: "acct_OTHER" }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toBe("identity");
  });

  it("a capability error on session creation STOPS and reports Stripe's exact error and request id, and says not to request onboarding", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", param: "stripe_account", message: "The account is restricted: card_payments capability is not active.", raw: { request_id: "req_abc123", statusCode: 400 } });
    const report = await runStripeGuard({ stripe: fakeStripe({ createError: err }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", code: "account_invalid", requestId: "req_abc123", statusCode: 400 });
    expect(report.stop?.message).toMatch(/Do not request sandbox onboarding/);
    expect(report.stop?.message).toMatch(/Canary C PASSED/);
    expect(report.stop?.message).toMatch(/2 of 4 canaries failed \(canary A, canary D1\); passed: canary C, canary D2\./);
    expect(failedIds(report)).toEqual(["canary A", "canary D1"]);
    expect(report.stop?.step).toMatch(/canary (A|D1)/);
  });

  it("a capability failure on the direct payment STOPS in canary C with the exact error (A and D1 are still attempted)", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", message: "This account cannot process charges until its requirements are completed.", raw: { request_id: "req_pay1" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ piError: err }).stripe, key: KEY, config });
    expect(report.steps.some((s) => s.name.startsWith("canary A") && s.ok)).toBe(true);
    expect(report.stop?.step).toMatch(/canary C/);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", requestId: "req_pay1" });
  });

  it("a plain card decline is not a capability error", async () => {
    const err = stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined.", raw: { request_id: "req_d" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ piError: err }).stripe, key: KEY, config });
    expect(report.stop?.failure).toMatchObject({ kind: "other", code: "card_declined" });
  });

  it("fails when the application fee is missing or wrong, or the amount is wrong", async () => {
    for (const over of [{ fee: null }, { fee: 5 }, { chargeFee: null, chargeFeeAmount: null }, { chargeFeeAmount: 5 }, { received: 99 }] as Overrides[]) {
      const report = await runStripeGuard({ stripe: fakeStripe(over).stripe, key: KEY, config });
      expect(report.ok, JSON.stringify(over)).toBe(false);
      expect(report.stop?.step).toMatch(/canary C/);
    }
  });

  it("fails if the canary session does not expire", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ expireStatus: "open" }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toMatch(/canary A/);
  });

  it("never lets a key fragment or webhook secret into the reported error", () => {
    const failure = classifyStripeError(stripeError({ type: "StripeAuthenticationError", message: "Invalid API Key provided: sk_test_****wxyz (whsec_abc123)", statusCode: 401 }));
    expect(failure.message).not.toMatch(/sk_test_|whsec_/);
  });

  it("classifies authentication failures and reads raw fields", () => {
    expect(classifyStripeError(stripeError({ type: "StripeAuthenticationError", message: "Invalid API Key provided", statusCode: 401 })).kind).toBe("authentication");
    expect(classifyStripeError(stripeError({ message: "x", raw: { code: "rate_limit", request_id: "req_9" } }))).toMatchObject({ code: "rate_limit", requestId: "req_9", kind: "other" });
  });
});

describe("the whole report is masked before it leaves the process (security review, PR 683)", () => {
  const LEAK = /(sk|rk|pk)_(test|live)_|whsec_|eyJ[A-Za-z0-9_-]{10,}\./;
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZSJ9.c2lnbmF0dXJl";

  it("a fake secret in EVERY Stripe error field is masked in the failure, the JSON, the summary and the file text", async () => {
    const err = stripeError({
      type: "StripeError_sk_test_TYPE111", code: "rk_live_CODE222", param: "whsec_PARAM333", message: `Bearer ${JWT} for sk_test_****MSG444`,
      raw: { request_id: "req_sk_test_REQ555", statusCode: 400 },
    });
    const report = await runStripeGuard({ stripe: fakeStripe({ createError: err }).stripe, key: KEY, config });
    expect(report.stop).toBeTruthy();
    const failure = report.stop!.failure;
    for (const field of [failure.type, failure.code, failure.param, failure.message, failure.requestId]) expect(String(field)).not.toMatch(LEAK);
    expect(failure.message).toContain("[redacted-");
    expect(serializeReport(report)).not.toMatch(LEAK);
    expect(summarizeReport(report)).not.toMatch(LEAK);
  });

  it("secrets planted anywhere in a report (step names, details, connected state, stop message) are masked and the output still parses", () => {
    const planted: GuardReport = {
      ok: false, notProven: [],
      steps: [{ name: "step sk_test_STEPNAME", ok: false, detail: { token: JWT, note: "whsec_DETAIL", nested: { deep: "rk_live_DEEP" } } }],
      connected: { id: "acct_X", memo: "sk_test_CONNECTED" },
      stop: { step: "canary sk_test_STEP", message: "STOP whsec_MESSAGE", failure: { kind: "capability", type: "sk_test_T", code: "rk_test_C", param: "whsec_P", message: "m sk_test_M", requestId: "req_sk_test_R", statusCode: 400 } },
    };
    const json = serializeReport(planted);
    expect(json).not.toMatch(LEAK);
    const parsed = JSON.parse(json) as GuardReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.stop?.failure.kind).toBe("capability");
    expect(parsed.stop?.failure.statusCode).toBe(400);
    expect(summarizeReport(planted)).not.toMatch(LEAK);
    expect(redactReport(planted).connected).toMatchObject({ id: "acct_X" });
  });

  it("a report with nothing secret is unchanged by masking", () => {
    const clean: GuardReport = { ok: true, notProven: [], steps: [{ name: "canary A", ok: true, detail: { amount_received: 100 } }], connected: { id: "acct_1", charges_enabled: false } };
    expect(redactReport(clean)).toEqual(clean);
  });

  it("the guard CLI can only print or write the masked report: no raw JSON.stringify and every sink uses summarizeReport / serializeReport", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "scripts", "qa", "cf1-stripe-guard.ts"), "utf8").split("\n").filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join("\n");
    expect(source).not.toContain("JSON.stringify");
    expect(source).toMatch(/const summary = summarizeReport\(report\)/);
    expect(source).toMatch(/console\.log\(summary\)/);
    expect(source).toMatch(/appendFileSync\([^)]*summary/);
    expect(source).toMatch(/writeFileSync\([^)]*serializeReport\(report\)/);
    expect(source).not.toMatch(/console\.(log|error)\([^)]*report\b(?!\))/);
  });
});


describe("restricted keys (rk_test_)", () => {
  const RK = "rk_test_unit123";
  const permissionError = (extra: Record<string, unknown> = {}) => stripeError({
    type: "StripePermissionError", statusCode: 403,
    message: "The provided key 'rk_test_***********abcd' does not have the required permissions for this endpoint on account 'acct_CONNECTED1'. Having the 'rak_payment_page_write' permission would allow this request to continue.",
    raw: { request_id: "req_perm1", statusCode: 403 }, ...extra,
  });

  it("passes with a restricted key: never reads GET /v1/account, proves the platform through the pinned connected account, runs C, A, D1 and D2", async () => {
    const { stripe, calls } = fakeStripe({ platformId: "acct_WOULD_MISMATCH" });
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.ok).toBe(true);
    expect(calls).not.toContain("account-read");
    expect(report.steps.some((step) => step.name.includes("restricted TEST key owns the pinned connected account"))).toBe(true);
    expect(ids(report).map(([n]) => n)).toEqual(["canary C", "canary A", "canary D1", "canary D2"]);
    expect(calls.filter((c) => c.startsWith("pi:")).every((c) => c === `pi:${CONNECTED}`)).toBe(true);
  });

  it("a STANDARD key still must read its own account and still fails on a different platform (no weakening)", async () => {
    const { stripe, calls } = fakeStripe({ platformId: "acct_OTHER" });
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(calls).toContain("account-read");
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toBe("identity");
  });

  it("only sk_test_ and rk_test_ pass the key check: live, publishable and malformed keys stop before any Stripe call", async () => {
    for (const bad of ["rk_live_abc123", "sk_live_abc123", "pk_test_abc123", "rak_test_abc", "rk_test_", ""]) {
      const { stripe, calls } = fakeStripe();
      const report = await runStripeGuard({ stripe, key: bad, config });
      expect(report.ok, bad).toBe(false);
      expect(calls, bad).toEqual([]);
    }
  });

  it("a restricted key that cannot retrieve the pinned connected account STOPS as a permission error, naming Stripe's exact error", async () => {
    const { stripe } = fakeStripe();
    (stripe as unknown as { accounts: { retrieve: () => Promise<never> } }).accounts.retrieve = async () => { throw permissionError({ raw: { request_id: "req_perm0", statusCode: 403 } }); };
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toBe("connected account");
    expect(report.stop?.failure).toMatchObject({ kind: "permission", statusCode: 403, requestId: "req_perm0" });
    expect(report.stop?.failure.message).toMatch(/rak_payment_page_write/);
    expect(report.stop?.failure.message).not.toMatch(/rk_test_[A-Za-z0-9]/);
  });

  it("a permission error is NOT a capability error even though Stripe's text says 'restricted' (and the reverse still holds)", () => {
    expect(classifyStripeError(permissionError()).kind).toBe("permission");
    expect(classifyStripeError(stripeError({ type: "StripePermissionError", message: "This restricted key cannot do that" })).kind).toBe("permission");
    expect(classifyStripeError(stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", message: "The account is restricted", raw: { statusCode: 400 } })).kind).toBe("capability");
    expect(classifyStripeError(stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined." })).kind).toBe("other");
  });

  it("PARTIAL result: canary C passes, canary D1 hits a permission error (reading the session needs a permission) - the report says the ACCOUNT is fine and the KEY is the limit, and does not pass", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ retrieveError: permissionError() }).stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.steps.some((step) => step.ok && step.name.startsWith("canary C"))).toBe(true);
    expect(report.stop?.step).toMatch(/canary D1/);
    expect(report.stop?.failure.kind).toBe("permission");
    expect(report.stop?.message).toMatch(/Canary C PASSED/);
    expect(report.stop?.message).toMatch(/never switch to another key silently/);
    expect(report.stop?.message).toMatch(/Do not request sandbox onboarding/);
    expect(summarizeReport(report)).not.toMatch(/rk_test_[A-Za-z0-9]/);
  });

  it("a capability error at canary C is reported, and A, D1 and D2 are STILL attempted so their answers are not hidden", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", message: "Your account cannot currently make live charges.", raw: { request_id: "req_c1", statusCode: 400 } });
    const { stripe } = fakeStripe({ piError: err });
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.step).toMatch(/canary C/);
    expect(report.stop?.failure.kind).toBe("capability");
    expect(failedIds(report)).toEqual(["canary C", "canary D2"]);
    expect(ids(report).filter(([, ok]) => ok).map(([n]) => n)).toEqual(["canary A", "canary D1"]);
    expect(report.steps.find((step) => step.name.startsWith("canary D2"))?.status).toBe("NOT PROVEN");
  });

  it("the guard CLI maps permission errors to exit 3, capability to 2, anything else to 1 (source tripwire)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "scripts", "qa", "cf1-stripe-guard.ts"), "utf8");
    expect(source).toMatch(/kind === "capability" \? 2 : report\.stop\?\.failure\.kind === "permission" \? 3 : 1/);
  });
});


describe("canary C first (owner decision 2026-11-20 after run 44653007956)", () => {
  // The exact Stripe error observed on the sandbox connected account (request id as reported by Stripe).
  const businessName = () => stripeError({
    type: "StripeInvalidRequestError", statusCode: 400,
    message: "In order to use Checkout, you must set an account or business name at https://dashboard.stripe.com/account.",
    raw: { request_id: "req_67Z382HA0utgTP", statusCode: 400 },
  });

  it("the observed business-name error is an account-setup (capability-class) error, not 'other'", () => {
    expect(classifyStripeError(businessName())).toMatchObject({ kind: "capability", statusCode: 400, requestId: "req_67Z382HA0utgTP" });
  });

  it("C passes, then Checkout is refused for the missing name: the report says what C proves, what is blocked, quotes the exact error, and A and D1 are reported", async () => {
    const { stripe, calls } = fakeStripe({ createError: businessName() });
    const report = await runStripeGuard({ stripe, key: "rk_test_unit123", config });
    expect(report.ok).toBe(false);
    expect(report.steps.map((step) => [step.name.slice(0, 8), step.ok]).filter(([n]) => String(n).startsWith("canary"))).toEqual([["canary C", true], ["canary A", false], ["canary D", false], ["canary D", true]]);
    expect(calls.filter((c) => c.startsWith("pi:"))).toEqual(["pi:acct_CONNECTED1"]);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", requestId: "req_67Z382HA0utgTP" });
    expect(report.stop?.failure.message).toBe("In order to use Checkout, you must set an account or business name at https://dashboard.stripe.com/account.");
    expect(report.stop?.message).toMatch(/Canary C PASSED/);
    expect(report.stop?.message).toMatch(/only Checkout is blocked/);
    expect(report.stop?.message).toMatch(/Do not request sandbox onboarding/);
  });

  it("nothing is weakened: a fee or amount mismatch at C is still a FAILED run (non-ok report, non-zero exit kind), reported with the field values it saw", async () => {
    for (const over of [{ fee: 5 }, { fee: null }, { chargeFee: null, chargeFeeAmount: null }, { chargeFeeAmount: 5 }, { received: 99 }] as Overrides[]) {
      const { stripe } = fakeStripe(over);
      const report = await runStripeGuard({ stripe, key: "rk_test_unit123", config });
      expect(report.ok, JSON.stringify(over)).toBe(false);
      expect(report.failures?.some((f) => f.step.startsWith("canary C")), JSON.stringify(over)).toBe(true);
      expect(report.stop?.failure.kind, JSON.stringify(over)).toBe("other");
    }
  });
});


describe("fee evidence on the charge (run 44725454494: C reached the charge-level fee check)", () => {
  it("passes when the charge records the fee AMOUNT even if no fee object id is present", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ chargeFee: null, chargeFeeAmount: 10 }).stripe, key: "rk_test_unit123", config });
    expect(report.ok).toBe(true);
  });
  it("passes when the charge carries a fee object but no amount field", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ chargeFee: "fee_1", chargeFeeAmount: null }).stripe, key: "rk_test_unit123", config });
    expect(report.ok).toBe(true);
  });
  it("FAILS with the exact fields it saw when the charge records neither; a wrong amount fails even if a fee object exists", async () => {
    const neither = await runStripeGuard({ stripe: fakeStripe({ chargeFee: null, chargeFeeAmount: null }).stripe, key: "rk_test_unit123", config });
    expect(neither.ok).toBe(false);
    expect(neither.failures?.find((f) => f.step.startsWith("canary C"))?.failure.message).toBe("the charge does not record the application fee (charge.application_fee_amount=null, charge.application_fee=null)");
    const wrong = await runStripeGuard({ stripe: fakeStripe({ chargeFee: "fee_1", chargeFeeAmount: 5 }).stripe, key: "rk_test_unit123", config });
    expect(wrong.ok).toBe(false);
    expect(wrong.failures?.find((f) => f.step.startsWith("canary C"))?.failure.message).toMatch(/charge records application fee 5, expected 10/);
  });
  it("the PaymentIntent-level fee is still required in addition to the charge-level evidence", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ fee: 5 }).stripe, key: "rk_test_unit123", config });
    expect(report.ok).toBe(false);
    expect(report.failures?.find((f) => f.step.startsWith("canary C"))?.failure.message).toMatch(/application fee on the PaymentIntent is 5, expected 10/);
  });
});

describe("canaries run independently (owner decision 2026-11-20)", () => {
  const RK = "rk_test_unit123";
  it("every failure is reported, the most severe drives the stop, the run is not ok, and passed canaries are listed", async () => {
    const decline = stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined.", raw: { request_id: "req_d" } });
    const permission = stripeError({ type: "StripePermissionError", statusCode: 403, message: "The provided key does not have the required permissions. Having the 'rak_payment_page_write' permission would allow this request to continue.", raw: { request_id: "req_p" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ piError: decline, retrieveError: permission }).stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.failures?.map((f) => [f.step.slice(0, 8), f.failure.kind])).toEqual([["canary C", "other"], ["canary D", "permission"], ["canary D", "other"]]);
    expect(report.stop?.failure.kind).toBe("permission");
    expect(report.stop?.message).toMatch(/3 of 4 canaries failed \(canary C, canary D1, canary D2\); passed: canary A\./);
    const text = summarizeReport(report);
    expect(text).toMatch(/also failed: canary C/);
    expect(text).toMatch(/card_declined/);
  });
  it("a precondition failure is still fatal: no canary is attempted and the message says so", async () => {
    const { stripe, calls } = fakeStripe({ live: true });
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.stop?.message).toMatch(/Not attempted: canary C, canary A, canary D1, canary D2/);
    expect(calls).toEqual([]);
  });
});

describe("assertFeeRecorded (unit)", () => {
  const charge = (over: Record<string, unknown>) => over as never;
  it("accepts the documented amount, or a fee object, and nothing else", () => {
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: 10, application_fee: null }), 10)).not.toThrow();
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: null, application_fee: "fee_x" }), 10)).not.toThrow();
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: null, application_fee: null }), 10)).toThrow(/does not record/);
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: 9, application_fee: "fee_x" }), 10)).toThrow(/records application fee 9/);
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, null, 10)).toThrow(/no charge/);
    expect(() => assertFeeRecorded({ application_fee_amount: null }, charge({ application_fee_amount: 10 }), 10)).toThrow(/PaymentIntent is null/);
  });
  it("never puts an id in its message (types and numbers only)", () => {
    try { assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: null, application_fee: "fee_SECRETISH123" }), 9); } catch (e) { expect(String((e as Error).message)).not.toMatch(/fee_SECRETISH123/); }
    expect(() => assertFeeRecorded({ application_fee_amount: 10 }, charge({ application_fee_amount: null, application_fee: null }), 10)).toThrow(/application_fee=null/);
  });
});

const ids = (report: GuardReport) => report.steps.filter((s) => s.name.startsWith("canary")).map((s) => [/^canary \w+/.exec(s.name)?.[0], s.ok]);
const failedIds = (report: GuardReport) => (report.failures ?? []).map((f) => /^canary \w+/.exec(f.step)?.[0]);
const permissionErr = () => stripeError({ type: "StripePermissionError", statusCode: 403, message: "The provided key does not have the required permissions. Having the 'rak_checkout_session_read' permission would allow this request to continue.", raw: { request_id: "req_perm_d", statusCode: 403 } });
const capabilityErr = () => stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", statusCode: 400, message: "The account is restricted: card_payments capability is not active.", raw: { request_id: "req_cap_d", statusCode: 400 } });

describe("canary B is retired (owner decision 2026-11-22, Path A)", () => {
  it("never runs, never fails the run, and every report says Checkout-hosted payment completion is NOT PROVEN", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe().stripe, key: KEY, config });
    expect(report.ok).toBe(true);
    expect(report.steps.some((s) => /canary B/.test(s.name))).toBe(false);
    expect(report.notProven).toEqual(["Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)"]);
    expect(CHECKOUT_PAYMENT_NOT_PROVEN).toBe(report.notProven[0]);
    expect(summarizeReport(report)).toContain("NOT PROVEN: Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)");
    expect(summarizeReport(report)).toContain("## Stripe guard: PASSED");
  });

  it("is stated even when a precondition stops the run and when canaries fail", async () => {
    const stopped = await runStripeGuard({ stripe: fakeStripe({ live: true }).stripe, key: KEY, config });
    expect(stopped.notProven).toHaveLength(1);
    expect(stopped.stop?.message).toContain("Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)");
    expect(stopped.stop?.message).toMatch(/Not attempted: canary C, canary A, canary D1, canary D2\./);
    const failed = await runStripeGuard({ stripe: fakeStripe({ piError: capabilityErr() }).stripe, key: KEY, config });
    expect(failed.stop?.message).toContain("Checkout-hosted payment completion: NOT PROVEN (not attempted under Path A)");
  });

  it("the guard path opens no browser: neither the guard nor its CLI imports the browser driver, playwright or the hosted-Checkout module", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of [["src", "lib", "e2e", "stripeGuard.ts"], ["scripts", "qa", "cf1-stripe-guard.ts"]]) {
      const source = readFileSync(join(process.cwd(), ...file), "utf8").split("\n").filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line)).join("\n");
      expect(source, file.join("/")).not.toMatch(/playwright|stripeHostedCheckout|cf1-hosted-checkout|payHosted|chromium/);
    }
  });
});

describe("canary D1: the settlement verifier refuses a forged paid event against REAL session shapes (no payment)", () => {
  it("passes: create open competition-shaped session, real retrieve refuses, expire, real retrieve refuses again; masked ids only", async () => {
    const { stripe, calls, created } = fakeStripe();
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(true);
    expect(ids(report)).toEqual([["canary C", true], ["canary A", true], ["canary D1", true], ["canary D2", true]]);
    const d1Calls = calls.slice(calls.indexOf(`create:${CONNECTED}`, calls.indexOf(`expire:${CONNECTED}`)));
    expect(d1Calls).toEqual([`create:${CONNECTED}`, `retrieve:${CONNECTED}`, `expire:${CONNECTED}`, `retrieve:${CONNECTED}`]);
    const d1Params = created[1] as { metadata: Record<string, string>; payment_intent_data: { application_fee_amount: number }; mode: string };
    expect(Object.keys(d1Params.metadata).sort()).toEqual(["order_id", "source"]);
    expect(d1Params.metadata.source).toBe("competition_registration");
    expect(d1Params.metadata.order_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(d1Params.mode).toBe("payment");
    expect(d1Params.payment_intent_data.application_fee_amount).toBe(10);
    const step = report.steps.find((s) => s.name.startsWith("canary D1"))!;
    expect(step.status).toBe("PASS");
    expect(step.detail).toEqual({ session: "cs_test_...5e1".replace("5e1", String(step.detail?.session).slice(-4)), refused_open: true, refused_expired: true });
    const text = serializeReport(report);
    expect(text).not.toMatch(/cs_test_a1b2c3d4e5\d/);
    expect(text).not.toContain(d1Params.metadata.order_id);
  });

  it("FAILS if the verifier would accept the forged paid event (Stripe's record shows complete/paid), and still expires the session", async () => {
    const { stripe, calls } = fakeStripe({ retrievePaid: true });
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(["canary D1"]);
    expect(report.failures?.[0].failure.message).toMatch(/ACCEPTED a forged paid event for an open session/);
    expect(calls.filter((c) => c.startsWith("expire:")).length).toBe(2);
    expect(report.steps.find((s) => s.name.startsWith("canary D1"))?.status).toBe("FAIL");
  });

  it("FAILS (not a false pass) when the refusal is for a different reason, e.g. Stripe returned the session without the competition metadata", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ lostMetadata: true }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(["canary D1"]);
    expect(report.failures?.[0].failure.message).toMatch(/different reason than an unpaid session: Competition settlement refused: order binding mismatch/);
  });

  it("FAILS when the session does not expire, and the expiry failure is reported", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ expireStatus: "open" }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(failedIds(report)).toEqual(["canary A", "canary D1"]);
    expect(report.failures?.[1].failure.message).toBe("canary D1 session did not expire");
  });

  it("a failing expire call is reported (and an earlier failure is not replaced by it)", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ expireError: capabilityErr(), retrievePaid: true }).stripe, key: KEY, config });
    const d1 = report.failures?.find((f) => f.step.startsWith("canary D1"));
    expect(d1?.failure.message).toMatch(/ACCEPTED a forged paid event/);
  });

  it("maps a permission error on the real retrieve to kind permission (exit 3), and does not hide C, A or D2", async () => {
    const { stripe, calls } = fakeStripe({ retrieveError: permissionErr() });
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(ids(report)).toEqual([["canary C", true], ["canary A", true], ["canary D1", false], ["canary D2", true]]);
    expect(report.stop?.step).toMatch(/^canary D1/);
    expect(report.stop?.failure).toMatchObject({ kind: "permission", requestId: "req_perm_d", statusCode: 403 });
    expect(report.stop?.message).toMatch(/never switch to another key silently/);
    expect(calls.filter((c) => c.startsWith("expire:")).length).toBe(2);
  });

  it("maps a capability error on session creation to kind capability (exit 2); A and D1 fail, C and D2 still answer", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ createError: capabilityErr() }).stripe, key: KEY, config });
    expect(ids(report)).toEqual([["canary C", true], ["canary A", false], ["canary D1", false], ["canary D2", true]]);
    expect(report.stop?.failure.kind).toBe("capability");
    expect(report.stop?.message).toMatch(/2 of 4 canaries failed \(canary A, canary D1\); passed: canary C, canary D2\./);
  });

  it("maps a capability error on the real retrieve to kind capability", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ retrieveError: capabilityErr() }).stripe, key: KEY, config });
    expect(report.failures?.find((f) => f.step.startsWith("canary D1"))?.failure).toMatchObject({ kind: "capability", code: "account_invalid" });
  });
});

describe("canary D2: PaymentIntent semantics against canary C's real succeeded object (NOT a paid Checkout Session)", () => {
  it("passes, makes no Stripe call of its own, and says what it does and does not prove", async () => {
    const { stripe, calls } = fakeStripe();
    const report = await runStripeGuard({ stripe, key: KEY, config });
    const step = report.steps.find((s) => s.name.startsWith("canary D2"))!;
    expect(step.ok).toBe(true);
    expect(step.status).toBe("PASS");
    expect(step.name).toMatch(/refused an amount off by one cent \(PaymentIntent field semantics ONLY; NOT a paid Checkout Session\)/);
    expect(step.detail).toEqual({ payment_intent: "pi_test_...abcd", amount_received: 100, application_fee_amount: 10 });
    expect(JSON.stringify(report)).not.toContain("pi_test_C1234abcd");
    expect(calls.filter((c) => c.startsWith("pi:"))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("retrieve:"))).toHaveLength(2); // both belong to D1
  });

  it("is NOT PROVEN (and the run fails) when canary C produced no succeeded PaymentIntent; D1 and A are unaffected", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ piError: stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined." }) }).stripe, key: KEY, config });
    expect(report.ok).toBe(false);
    expect(report.steps.find((s) => s.name.startsWith("canary D2"))).toMatchObject({ ok: false, status: "NOT PROVEN" });
    expect(ids(report)).toEqual([["canary C", false], ["canary A", true], ["canary D1", true], ["canary D2", false]]);
    expect(report.failures?.find((f) => f.step.startsWith("canary D2"))?.failure.message).toMatch(/^NOT PROVEN: canary C produced no succeeded PaymentIntent/);
    expect(summarizeReport(report)).toMatch(/- NOT PROVEN: canary D2/);
  });

  it("FAILS when the verifier would accept a session amount one cent above or below the real amount received", async () => {
    for (const delta of [1, -1]) {
      verifierOverride.fn = async (...args: unknown[]) => {
        const { verifySettlementWithStripe } = await vi.importActual<typeof import("../../competition/registrationLifecycle")>("../../competition/registrationLifecycle");
        const p = args[1] as { eventSession: { amount_total: number } };
        // D1 calls (event amount 100 against an unpaid session) stay real; D2 calls with an altered amount are wrongly accepted.
        if (p.eventSession.amount_total === 100 + delta) return { paymentIntentId: "x", amountCents: 100 + delta, currency: "USD" };
        return verifySettlementWithStripe(args[0] as never, args[1] as never);
      };
      const report = await runStripeGuard({ stripe: fakeStripe().stripe, key: KEY, config });
      expect(report.ok, String(delta)).toBe(false);
      expect(failedIds(report), String(delta)).toEqual(["canary D2"]);
      expect(report.failures?.[0].failure.message, String(delta)).toMatch(delta > 0 ? /one cent above/ : /one cent below/);
    }
  });

  it("FAILS when the verifier returns different values for the real PaymentIntent", async () => {
    verifierOverride.fn = async (...args: unknown[]) => {
      const { verifySettlementWithStripe } = await vi.importActual<typeof import("../../competition/registrationLifecycle")>("../../competition/registrationLifecycle");
      const p = args[1] as { eventSession: { id: string } };
      if (p.eventSession.id === "cs_test_synthetic_d2") return { paymentIntentId: "pi_other", amountCents: 100, currency: "USD" };
      return verifySettlementWithStripe(args[0] as never, args[1] as never);
    };
    const report = await runStripeGuard({ stripe: fakeStripe().stripe, key: KEY, config });
    expect(failedIds(report)).toEqual(["canary D2"]);
    expect(report.failures?.[0].failure.message).toMatch(/returned different values/);
  });

  it("maps permission and capability errors that surface in D2 (kind and exit class), independently of D1", async () => {
    for (const [make, kind] of [[permissionErr, "permission"], [capabilityErr, "capability"]] as const) {
      verifierOverride.fn = async (...args: unknown[]) => {
        const { verifySettlementWithStripe } = await vi.importActual<typeof import("../../competition/registrationLifecycle")>("../../competition/registrationLifecycle");
        if ((args[1] as { eventSession: { id: string } }).eventSession.id === "cs_test_synthetic_d2") throw make();
        return verifySettlementWithStripe(args[0] as never, args[1] as never);
      };
      const report = await runStripeGuard({ stripe: fakeStripe().stripe, key: KEY, config });
      expect(ids(report), kind).toEqual([["canary C", true], ["canary A", true], ["canary D1", true], ["canary D2", false]]);
      expect(report.stop?.failure.kind, kind).toBe(kind);
    }
  });

  it("D1 and D2 fail independently: both are reported when the verifier misbehaves everywhere, and C and A still pass", async () => {
    verifierOverride.fn = async () => { throw permissionErr(); };
    const report = await runStripeGuard({ stripe: fakeStripe().stripe, key: KEY, config });
    expect(ids(report)).toEqual([["canary C", true], ["canary A", true], ["canary D1", false], ["canary D2", false]]);
    expect(failedIds(report)).toEqual(["canary D1", "canary D2"]);
    expect(report.stop?.message).toMatch(/2 of 4 canaries failed \(canary D1, canary D2\); passed: canary C, canary A\./);
  });
});

describe("whole-report masking holds for the new fields", () => {
  it("a credential planted in the notProven list or a D1/D2 step detail is masked", () => {
    const report: GuardReport = { ok: false, notProven: ["x sk_test_PLANTED123"], steps: [{ name: "canary D1", ok: true, status: "PASS", detail: { session: "whsec_PLANTED" } }] };
    expect(serializeReport(report)).not.toMatch(/PLANTED/);
    expect(summarizeReport(report)).not.toMatch(/PLANTED/);
  });
});
