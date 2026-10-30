import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildPriceConfigReport } from "@/lib/billing-qa/priceConfigReport";
import {
  describeArgument,
  looksLikeStripeKey,
  redactKeys,
  expectationsFromPriceConfig,
  readBackSmoke,
  type BillingQaReadClient,
  type ReadbackSession,
  type ReadbackSubscription,
  type SmokeExpectations,
} from "@/lib/billing-qa/sessionReadback";
import { assertBillingQaReadKey } from "@/lib/billing-qa/stripeKey";

const PRICES = { starter: "price_starter59", growth: "price_growth99", pro: "price_pro159" } as const;
const AMOUNTS = { starter: 5900, growth: 9900, pro: 15900 } as const;
const EXPECT: SmokeExpectations = { offer: "founder", prices: { ...PRICES }, legacyPriceIds: ["price_pro129"] };
const CREATED = 1_793_000_000;

function session(plan: keyof typeof PRICES, overrides: Partial<ReadbackSession> = {}, metadata: Record<string, string> = {}): ReadbackSession {
  return {
    id: `cs_live_${plan}Session`,
    livemode: true,
    mode: "subscription",
    status: "open",
    payment_status: "unpaid",
    subscription: null,
    customer: "cus_smoke",
    created: CREATED,
    metadata: { source: "studio_subscription", studioId: "studio-qa", planCode: plan, offerType: "founder", ...metadata },
    line_items: { data: [{ quantity: 1, price: { id: PRICES[plan], unit_amount: AMOUNTS[plan], currency: "usd", recurring: { interval: "month", interval_count: 1 } } }] },
    ...overrides,
  };
}

function client(opts: {
  sessions?: ReadbackSession[];
  errors?: Record<string, unknown>;
  smokeSubs?: ReadbackSubscription[];
  portalSubs?: ReadbackSubscription[];
  portalSessions?: ReadbackSession[];
  grandfathered?: ReadbackSubscription;
} = {}) {
  const sessions = opts.sessions ?? (["starter", "growth", "pro"] as const).map((p) => session(p));
  const calls: string[] = [];
  const stripe: BillingQaReadClient = {
    checkout: {
      sessions: {
        retrieve: vi.fn(async (id: string) => {
          calls.push(`sessions.retrieve`);
          if (opts.errors?.[id]) throw opts.errors[id];
          const found = sessions.find((s) => s.id === id);
          if (!found) throw Object.assign(new Error("No such checkout session"), { code: "resource_missing", statusCode: 404 });
          return found;
        }),
        list: vi.fn(async () => {
          calls.push("sessions.list");
          return { data: opts.portalSessions ?? [] };
        }),
      },
    },
    subscriptions: {
      retrieve: vi.fn(async () => {
        calls.push("subscriptions.retrieve");
        return opts.grandfathered ?? { id: "sub_gf", livemode: true, status: "active", items: { data: [{ price: { id: "price_pro129", unit_amount: 12900 } }] } };
      }),
      list: vi.fn(async (params: { customer: string }) => {
        calls.push("subscriptions.list");
        return { data: params.customer === "cus_subscriber" ? opts.portalSubs ?? [{ id: "sub_live", status: "active" }] : opts.smokeSubs ?? [] };
      }),
    },
  };
  return { stripe, calls, ids: sessions.map((s) => s.id) };
}

const run = (c: ReturnType<typeof client>, extra: Partial<Parameters<typeof readBackSmoke>[0]> = {}) =>
  readBackSmoke({ stripe: c.stripe, keyMode: "live", sessionIds: c.ids, expectations: EXPECT, now: () => new Date("2026-10-25T12:00:00Z"), ...extra });
const byId = (report: Awaited<ReturnType<typeof readBackSmoke>>) => Object.fromEntries(report.checks.map((x) => [x.id, x]));

describe("BILLING-QA-5 smoke read-back", () => {
  it("three unpaid Founder Sessions on the configured Prices, smoke/portal/grandfathered checks: PASS, readback mode, reads only", async () => {
    const c = client();
    const report = await run(c, { smokeCustomer: "cus_smoke", portalCustomer: "cus_subscriber", grandfatheredSubscription: "sub_gf" });
    expect([report.mode, report.overall, report.counts]).toEqual(["readback", "PASS", { PASS: 13, FAIL: 0, BLOCKED: 0 }]);
    expect(byId(report)["grandfathered.price"].detail).toBe("$129.00/month, active");
    expect(new Set(c.calls)).toEqual(new Set(["sessions.retrieve", "sessions.list", "subscriptions.retrieve", "subscriptions.list"]));
    expect(report.config).toMatchObject({ stripeMode: "live", offer: "founder", sessions: 3, since: new Date((CREATED - 600) * 1000).toISOString(), "expected.pro": "price_pro159" });
  });

  it("a completed Session FAILs as session_completed (a live subscription may exist)", async () => {
    const c = client({ sessions: [session("starter"), session("growth", { status: "complete", subscription: "sub_oops" }), session("pro")] });
    const checks = byId(await run(c));
    expect(checks["session.growth.unpaid"]).toMatchObject({ status: "FAIL", reason: "session_completed", evidence: expect.objectContaining({ subscription: "sub_oops" }) });
  });

  it("wrong amount or a different Price FAIL session_price_mismatch", async () => {
    const legacyGrowth = session("growth", { line_items: { data: [{ quantity: 1, price: { id: "price_growth79", unit_amount: 7900, currency: "usd", recurring: { interval: "month" } } }] } });
    const checks = byId(await run(client({ sessions: [session("starter"), legacyGrowth, session("pro")] })));
    expect(checks["session.growth.price"]).toMatchObject({ status: "FAIL", reason: "session_price_mismatch", detail: "amount $79.00 (expected $99.00), Price is not the configured one" });
  });

  it("amount right but no expected Price ID: BLOCKED, never PASS", async () => {
    const report = await run(client(), { expectations: { offer: "founder", prices: {}, legacyPriceIds: [] } });
    expect(report.overall).toBe("BLOCKED");
    expect(byId(report)["session.pro.price"]).toMatchObject({ status: "BLOCKED", reason: "expected_price_id_unknown" });
  });

  it("not a DanceFlow subscription Session, wrong offer, or another customer's Session: FAIL", async () => {
    const odd = session("starter", { mode: "payment", customer: "cus_other" }, { source: "ai_credit_pack", offerType: "standard" });
    const checks = byId(await run(client({ sessions: [odd, session("growth"), session("pro")] }), { smokeCustomer: "cus_smoke" }));
    expect(checks["session.starter.session"]).toMatchObject({ status: "FAIL", reason: "session_not_danceflow_subscription" });
    expect(checks["session.starter.session"].detail).toBe("mode payment, source ai_credit_pack, offerType standard (expected founder), customer is not the smoke workspace's");
  });

  it("a missing plan is BLOCKED (plan_not_smoked); a duplicate plan gets its own check ids", async () => {
    const c = client({ sessions: [session("starter"), session("starter", { id: "cs_live_starterAgain" }), session("growth")] });
    const report = await run(c);
    const checks = byId(report);
    expect(checks["smoke.coverage"]).toMatchObject({ status: "BLOCKED", reason: "plan_not_smoked", detail: "no Session for pro" });
    expect(checks["session.starter.2.price"].status).toBe("PASS");
    expect(report.overall).toBe("BLOCKED");
  });

  it("--plans narrows coverage", async () => {
    const c = client({ sessions: [session("growth")] });
    expect(byId(await run(c, { plans: ["growth"] }))["smoke.coverage"].status).toBe("PASS");
  });

  it("smoke workspace subscription and existing-subscriber Session are FAILs", async () => {
    const c = client({ smokeSubs: [{ id: "sub_smoke" }], portalSessions: [session("pro", { id: "cs_live_portalWrong" })] });
    const checks = byId(await run(c, { smokeCustomer: "cus_smoke", portalCustomer: "cus_subscriber" }));
    expect(checks["smoke.no_subscription"]).toMatchObject({ status: "FAIL", reason: "smoke_subscription_created" });
    expect(checks["portal.no_checkout_session"]).toMatchObject({ status: "FAIL", reason: "existing_subscriber_got_checkout" });
  });

  it("grandfathered: Price changed FAILs; unknown legacy Price is BLOCKED", async () => {
    const moved = client({ grandfathered: { id: "sub_gf", livemode: true, status: "active", items: { data: [{ price: { id: "price_pro159", unit_amount: 15900 } }] } } });
    expect(byId(await run(moved, { grandfatheredSubscription: "sub_gf" }))["grandfathered.price"].reason).toBe("grandfathered_price_changed");
    const unknown = await run(client(), { grandfatheredSubscription: "sub_gf", expectations: { offer: "founder", prices: { ...PRICES }, legacyPriceIds: [] } });
    expect(byId(unknown)["grandfathered.price"]).toMatchObject({ status: "BLOCKED", reason: "legacy_price_unknown" });
  });

  it("Stripe errors: missing Session FAILs, no permission is BLOCKED", async () => {
    const c = client({ errors: { cs_live_growthSession: Object.assign(new Error("forbidden"), { statusCode: 403 }) } });
    const report = await run({ ...c, ids: [...c.ids, "cs_live_doesNotExist"] });
    const checks = byId(report);
    expect(checks["session.hSession"]).toMatchObject({ status: "BLOCKED", reason: "stripe_permission_denied" });
    expect(checks["session.NotExist"]).toMatchObject({ status: "FAIL", reason: "session_not_found" });
  });

  it("a Session id in the other mode, or not a Session id, is refused before any Stripe call", async () => {
    const c = client();
    await expect(run(c, { sessionIds: ["cs_test_abc"] })).rejects.toThrow(/test mode but the key is live mode/);
    await expect(run(c, { sessionIds: ["pi_live_abc"] })).rejects.toThrow(/not a Checkout Session id/);
    expect(c.calls).toHaveLength(0);
  });

  it("expectations come from a BILLING-QA-4 price-config report", () => {
    const config = buildPriceConfigReport({
      STRIPE_PRICE_STUDIO_STARTER_FOUNDER: "price_s59", STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_g99", STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_p159",
      STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_p249", STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_p129,price_older",
    });
    expect(expectationsFromPriceConfig(JSON.parse(JSON.stringify(config)))).toEqual({
      offer: "founder", prices: { starter: "price_s59", growth: "price_g99", pro: "price_p159" }, legacyPriceIds: ["price_p129", "price_older"], priceConfigOverall: "FAIL", // no Stripe keys in this config
    });
    const regular = buildPriceConfigReport({ FOUNDER_PRICING_ACTIVE: "false", REGULAR_PRICING_ACTIVATED: "true", REGULAR_PRICING_APPROVAL_REF: "ref", STRIPE_PRICE_STUDIO_PRO_STANDARD: "price_p249" });
    expect(expectationsFromPriceConfig(regular)).toMatchObject({ offer: "standard", prices: { pro: "price_p249" } });
    expect(() => expectationsFromPriceConfig({ tool: "something else" })).toThrow(/not a BILLING-QA-4/);
  });
});

describe("BILLING-QA-5 read key guard", () => {
  // Fake values, assembled at runtime so secret scanners do not mistake fixtures for real keys.
  const fake = (...parts: string[]) => parts.join("_");

  it("live mode accepts only a restricted key; a live secret key is refused", () => {
    expect(assertBillingQaReadKey(fake("rk", "live", "abc"))).toEqual({ key: fake("rk", "live", "abc"), mode: "live" });
    expect(() => assertBillingQaReadKey(fake("sk", "live", "abc"))).toThrow(expect.objectContaining({ code: "STRIPE_LIVE_SECRET_KEY_REFUSED" }));
  });

  it("test mode accepts secret or restricted test keys; missing and malformed are refused", () => {
    expect(assertBillingQaReadKey(fake("sk", "test", "abc")).mode).toBe("test");
    expect(assertBillingQaReadKey(fake("rk", "test", "abc")).mode).toBe("test");
    expect(() => assertBillingQaReadKey(undefined)).toThrow(expect.objectContaining({ code: "STRIPE_KEY_MISSING" }));
    expect(() => assertBillingQaReadKey("pk_live_abc")).toThrow(expect.objectContaining({ code: "STRIPE_KEY_MALFORMED" }));
  });

  it("never echoes the key in a refusal", () => {
    try {
      assertBillingQaReadKey(fake("sk", "live", "secretvalue"));
    } catch (error) {
      expect((error as Error).message).not.toContain("secretvalue");
    }
  });
});

describe("BILLING-QA-5 independent review fixes", () => {
  it("C3: the portal check is BLOCKED (not PASS) when the customer is not actually a live subscriber", async () => {
    const report = await run(client({ portalSubs: [{ id: "sub_old", status: "canceled" }] }), { portalCustomer: "cus_subscriber" });
    expect(byId(report)["portal.no_checkout_session"]).toMatchObject({ status: "BLOCKED", reason: "portal_customer_not_subscriber" });
    expect(report.overall).toBe("BLOCKED");
  });

  it("C5: a grandfathered subscription on any configured legacy Price passes", async () => {
    const c = client({ grandfathered: { id: "sub_gf", livemode: true, status: "trialing", items: { data: [{ price: { id: "price_older", unit_amount: 7900 } }] } } });
    const checks = byId(await run(c, { grandfatheredSubscription: "sub_gf", expectations: { ...EXPECT, legacyPriceIds: ["price_pro129", "price_older"] } }));
    expect(checks["grandfathered.price"]).toMatchObject({ status: "PASS", evidence: expect.objectContaining({ legacyPriceId: "price_older" }) });
  });

  it("C7: expectations from a price-config report that did not PASS fail the read-back", async () => {
    const checks = byId(await run(client(), { expectations: { ...EXPECT, priceConfigOverall: "FAIL" } }));
    expect(checks["config.report"]).toMatchObject({ status: "FAIL", reason: "price_config_report_not_pass" });
    expect(byId(await run(client(), { expectations: { ...EXPECT, priceConfigOverall: "PASS" } }))["config.report"].status).toBe("PASS");
  });

  it("C10: a refused value echoes at most its 8-character prefix", async () => {
    const pasted = ["rk", "live", "pastedKeyBodyThatMustNotLeak"].join("_");
    await expect(run(client(), { sessionIds: [pasted] })).rejects.toThrow(/^not a Checkout Session id: rk_live_…$/);
  });

  it("expectations from a config report never take a malformed legacy value", () => {
    const config = buildPriceConfigReport({ STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_p129,notAPrice", STRIPE_PRICE_STUDIO_GROWTH_FOUNDER_LEGACY: "price_g79" });
    expect(expectationsFromPriceConfig(config).legacyPriceIds).toEqual(["price_g79", "price_p129"]);
  });
});

describe("BILLING-QA-5 final review fixes (N1, N2)", () => {
  // Fake values, assembled at runtime so secret scanners do not mistake fixtures for real keys.
  const pastedKey = ["rk", "live", "PastedKeyBodyThatMustNeverBePrinted"].join("_");

  it("N1: a stray argument is echoed as an 8-character prefix; real flags in full", () => {
    expect(describeArgument(pastedKey)).toBe("rk_live_…");
    expect(describeArgument("--sesion")).toBe("--sesion");
    expect(describeArgument("--rk_live_abcdef")).toBe("--rk_liv…"); // not flag-shaped: still truncated
  });

  // Runs the real CLI from the repo root (tsx and the @/ path aliases resolve from there). It fails in argument
  // parsing, before any key, file or Stripe access, so no network is touched.
  const repoRoot = path.resolve(__dirname, "../../../..");
  const cli = (...args: string[]) => {
    const env = { ...process.env };
    delete env.BILLING_QA_STRIPE_READ_KEY;
    const run = spawnSync(process.execPath, ["--import", "tsx", path.join(repoRoot, "scripts/qa/billing-session-readback.ts"), ...args], {
      cwd: repoRoot, env, encoding: "utf8", timeout: 60_000,
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  };

  it("N1: the real CLI never prints a key pasted as a bare argument (exit 2, prefix only, no network)", () => {
    const run = cli("--session", "cs_live_abc", pastedKey);
    expect(run.status).toBe(2);
    expect(run.output).toContain("unknown argument rk_live_…");
    expect(run.output).not.toContain("PastedKeyBody");
  }, 90_000);

  it.each(["--read-key-file", "--price-config", "--out", "--session"])(
    "N1: a key pasted as the value of %s is refused without being printed (exit 2, no file read or written)",
    (flag) => {
      const run = cli("--session", "cs_live_abc", flag, pastedKey);
      expect(run.status).toBe(2);
      expect(run.output).toContain(`${flag}: that value looks like a Stripe key`);
      expect(run.output).not.toContain("PastedKeyBody");
    },
    90_000,
  );

  it("--read-key-file loads the key file: a live secret key in it is refused by the key guard (exit 2, not printed, no network)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bqa5-key-"));
    try {
      const file = path.join(dir, "readback.env");
      writeFileSync(file, `BILLING_QA_STRIPE_READ_KEY=${["sk", "live", "LiveSecretBodyNeverPrinted"].join("_")}\n`);
      const run = cli("--session", "cs_live_abc", "--read-key-file", file);
      expect(run.status).toBe(2);
      expect(run.output).toContain("STRIPE_LIVE_SECRET_KEY_REFUSED");
      expect(run.output).not.toContain("LiveSecretBody");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it("N1: key detection and redaction cover every key shape, and leave Stripe object ids alone", () => {
    const k = (...parts: string[]) => parts.join("_");
    for (const key of [k("sk", "live", "abc"), k("rk", "test", "abc"), k("pk", "live", "abc"), k("ek", "test", "abc"), k("whsec", "abc")]) {
      expect(looksLikeStripeKey(key), key.slice(0, 5)).toBe(true);
    }
    for (const id of ["cs_live_abc", "cus_abc", "price_abc", "sub_abc", "./price-config.json"]) expect(looksLikeStripeKey(id), id).toBe(false);
    expect(redactKeys(`ENOENT: no such file or directory, open '${pastedKey}'`)).toBe("ENOENT: no such file or directory, open 'rk_live_…'");
  });

  it("N2: with --since, a Session created before the recorded start FAILs; Sessions from this smoke pass", async () => {
    const stale = session("growth", { created: CREATED - 3600 });
    const c = client({ sessions: [session("starter"), stale, session("pro")] });
    const report = await run(c, { since: CREATED - 60 });
    const checks = byId(report);
    expect(checks["session.growth.fresh"]).toMatchObject({ status: "FAIL", reason: "session_before_smoke_start" });
    expect(checks["session.starter.fresh"].status).toBe("PASS");
    expect(checks["session.pro.fresh"].status).toBe("PASS");
    expect(report.overall).toBe("FAIL");
  });

  it("N2: without --since there is no freshness check (unchanged behaviour)", async () => {
    const report = await run(client());
    expect(report.checks.some((c) => c.id.endsWith(".fresh"))).toBe(false);
  });

  it("N2: a Session with no creation time is BLOCKED, never PASS", async () => {
    const c = client({ sessions: [session("starter", { created: undefined }), session("growth"), session("pro")] });
    expect(byId(await run(c, { since: CREATED - 60 }))["session.starter.fresh"]).toMatchObject({ status: "BLOCKED", reason: "session_created_unknown" });
  });
});
