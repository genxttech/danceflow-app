import { describe, expect, it } from "vitest";
import { classifyStripeError, redactReport, runStripeGuard, serializeReport, summarizeReport, type GuardConfig, type GuardReport } from "../stripeGuard";

const PLATFORM = "acct_PLATFORM1";
const CONNECTED = "acct_CONNECTED1";
const config: GuardConfig = { expectPlatform: PLATFORM, connectedAccount: CONNECTED, successUrl: "http://127.0.0.1:3000/ok", cancelUrl: "http://127.0.0.1:3000/no" };
const KEY = "sk_test_unit123";

type Overrides = Partial<{
  live: boolean; platformId: string; createError: unknown; piError: unknown; confirmError: unknown; fee: number | null; chargeFee: string | null; received: number; expireStatus: string;
}>;

type FakeSession = { id: string; status: string; payment_status: string; livemode: boolean; payment_intent: string | null; customer_email: null };

/** A Stripe-shaped fake that records calls; every call that needs the connected account must pass stripeAccount. */
function fakeStripe(o: Overrides = {}) {
  const calls: string[] = [];
  const sessions = new Map<string, FakeSession>();
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
        create: async (_params: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`create:${opts?.stripeAccount}`);
          if (o.createError) throw o.createError;
          const id = `cs_test_${++n}`;
          sessions.set(id, { id, status: "open", payment_status: "unpaid", livemode: false, payment_intent: null, customer_email: null });
          return sessions.get(id)!;
        },
        expire: async (id: string, _p: unknown, opts: { stripeAccount?: string }) => {
          calls.push(`expire:${opts?.stripeAccount}`);
          const s = sessions.get(id)!;
          s.status = o.expireStatus ?? "expired";
          return s;
        },
        retrieve: async (id: string) => sessions.get(id)!,
      },
    },
    paymentMethods: { create: async () => ({ id: "pm_1" }) },
    rawRequest: async (method: string, path: string) => {
      if (method === "POST") {
        calls.push("confirm");
        if (o.confirmError) throw o.confirmError;
        const s = sessions.get(path.split("/")[3])!;
        s.status = "complete";
        s.payment_status = "paid";
        s.payment_intent = "pi_1";
        return {};
      }
      if (path === "/v1/account") { calls.push("account-read"); return { id: o.platformId ?? PLATFORM }; }
      return { livemode: false, total_summary: { due: 100 } };
    },
    paymentIntents: {
      create: async (params: { application_fee_amount?: number; confirm?: boolean; payment_method?: string }, opts: { stripeAccount?: string }) => {
        calls.push(`pi:${opts?.stripeAccount}`);
        if (o.piError) throw o.piError;
        void params;
        return {
          status: "succeeded", amount_received: o.received ?? 100, application_fee_amount: o.fee === undefined ? 10 : o.fee,
          latest_charge: { application_fee: o.chargeFee === undefined ? "fee_1" : o.chargeFee },
        };
      },
      retrieve: async () => ({
        amount_received: o.received ?? 100,
        application_fee_amount: o.fee === undefined ? 10 : o.fee,
        latest_charge: { application_fee: o.chargeFee === undefined ? "fee_1" : o.chargeFee },
      }),
    },
  };
  return { stripe: stripe as never, calls };
}

const stripeError = (over: Record<string, unknown>) => Object.assign(new Error(String(over.message)), over);

describe("stripe guard", () => {
  it("passes: records the restricted account state, proves session creation (A), a documented-API card payment with the fee (C), then Checkout payment (B)", async () => {
    const { stripe, calls } = fakeStripe();
    const report = await runStripeGuard({ stripe, key: KEY, config });
    expect(report.ok).toBe(true);
    expect(report.connected).toMatchObject({ charges_enabled: false, card_payments: "inactive", currently_due_count: 7 });
    expect(report.steps.map((s) => s.name).filter((name) => name.startsWith("canary"))).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("create")).every((c) => c === `create:${CONNECTED}`)).toBe(true);
    expect(calls).toContain(`expire:${CONNECTED}`);
    expect(calls).toContain("confirm");
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
    expect(report.stop?.step).toMatch(/canary A/);
  });

  it("a payment-confirmation failure on a capability STOPS in canary B with the exact error (canary A passing proves session creation only)", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", message: "This account cannot process charges until its requirements are completed.", raw: { request_id: "req_pay1" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ confirmError: err }).stripe, key: KEY, config });
    expect(report.steps.some((s) => s.name.startsWith("canary A") && s.ok)).toBe(true);
    expect(report.stop?.step).toMatch(/canary B/);
    expect(report.stop?.failure).toMatchObject({ kind: "capability", requestId: "req_pay1" });
  });

  it("a plain card decline is not a capability error", async () => {
    const err = stripeError({ type: "StripeCardError", code: "card_declined", message: "Your card was declined.", raw: { request_id: "req_d" } });
    const report = await runStripeGuard({ stripe: fakeStripe({ confirmError: err }).stripe, key: KEY, config });
    expect(report.stop?.failure).toMatchObject({ kind: "other", code: "card_declined" });
  });

  it("fails when the application fee is missing or wrong, or the amount is wrong", async () => {
    for (const over of [{ fee: null }, { fee: 5 }, { chargeFee: null }, { received: 99 }] as Overrides[]) {
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
      ok: false,
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
    const clean: GuardReport = { ok: true, steps: [{ name: "canary A", ok: true, detail: { amount_received: 100 } }], connected: { id: "acct_1", charges_enabled: false } };
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

  it("passes with a restricted key: never reads GET /v1/account, proves the platform through the pinned connected account, runs A, C and B", async () => {
    const { stripe, calls } = fakeStripe({ platformId: "acct_WOULD_MISMATCH" });
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.ok).toBe(true);
    expect(calls).not.toContain("account-read");
    expect(report.steps.some((step) => step.name.includes("restricted TEST key owns the pinned connected account"))).toBe(true);
    expect(report.steps.filter((step) => step.name.startsWith("canary")).map((step) => step.name.slice(0, 8))).toEqual(["canary A", "canary C", "canary B"]);
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

  it("PARTIAL result: canary C passes, canary B hits a permission error (the payment page is not a documented restricted-key permission) - the report says the ACCOUNT is fine and the KEY is the limit, and does not pass", async () => {
    const report = await runStripeGuard({ stripe: fakeStripe({ confirmError: permissionError() }).stripe, key: RK, config });
    expect(report.ok).toBe(false);
    expect(report.steps.some((step) => step.ok && step.name.startsWith("canary C"))).toBe(true);
    expect(report.stop?.step).toMatch(/canary B/);
    expect(report.stop?.failure.kind).toBe("permission");
    expect(report.stop?.message).toMatch(/Canary C PASSED/);
    expect(report.stop?.message).toMatch(/never switch to another key silently/);
    expect(report.stop?.message).toMatch(/Do not request sandbox onboarding/);
    expect(summarizeReport(report)).not.toMatch(/rk_test_[A-Za-z0-9]/);
  });

  it("a capability error at canary C stops there, before the Checkout payment attempt", async () => {
    const err = stripeError({ type: "StripeInvalidRequestError", code: "account_invalid", message: "Your account cannot currently make live charges.", raw: { request_id: "req_c1", statusCode: 400 } });
    const { stripe, calls } = fakeStripe({ piError: err });
    const report = await runStripeGuard({ stripe, key: RK, config });
    expect(report.stop?.step).toMatch(/canary C/);
    expect(report.stop?.failure.kind).toBe("capability");
    expect(calls).not.toContain("confirm");
  });

  it("the guard CLI maps permission errors to exit 3, capability to 2, anything else to 1 (source tripwire)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(process.cwd(), "scripts", "qa", "cf1-stripe-guard.ts"), "utf8");
    expect(source).toMatch(/kind === "capability" \? 2 : report\.stop\?\.failure\.kind === "permission" \? 3 : 1/);
  });
});
