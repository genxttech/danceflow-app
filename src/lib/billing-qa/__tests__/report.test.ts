import { describe, expect, it } from "vitest";
import { blocked, buildReport, exitCodeFor, fail, overallStatus, pass, renderReportTable } from "@/lib/billing-qa/report";
import { assertBillingQaTestModeKey } from "@/lib/billing-qa/stripeKey";

const build = (checks: ReturnType<typeof pass>[]) =>
  buildReport({ tool: "t", startedAt: "2026-10-25T00:00:00.000Z", completedAt: "2026-10-25T00:00:01.000Z", config: {}, checks });

describe("BILLING-QA report status", () => {
  it("PASS only when every check passed", () => {
    expect(overallStatus([pass("a", "A"), pass("b", "B")])).toBe("PASS");
  });

  it("an empty report is BLOCKED, never PASS", () => {
    expect(overallStatus([])).toBe("BLOCKED");
    expect(exitCodeFor(build([]).overall)).toBe(4);
  });

  it("BLOCKED is never counted as a pass", () => {
    expect(overallStatus([pass("a", "A"), blocked("b", "B", "price_id_not_configured")])).toBe("BLOCKED");
  });

  it("FAIL wins over BLOCKED", () => {
    expect(overallStatus([blocked("a", "A", "stripe_unavailable"), fail("b", "B", "price_mismatch")])).toBe("FAIL");
  });

  it("exit codes: 0 PASS, 1 FAIL, 4 BLOCKED", () => {
    expect([exitCodeFor("PASS"), exitCodeFor("FAIL"), exitCodeFor("BLOCKED")]).toEqual([0, 1, 4]);
  });

  it("counts and renders every check", () => {
    const report = build([pass("a", "A"), fail("b", "B", "price_mismatch", "amount $49.00")]);
    expect(report.counts).toEqual({ PASS: 1, FAIL: 1, BLOCKED: 0 });
    const table = renderReportTable(report);
    expect(table).toContain("— FAIL");
    expect(table).toMatch(/FAIL\s+b\s+price_mismatch\s+amount \$49\.00/);
  });

  it("refuses duplicate ids and FAIL/BLOCKED without a reason code", () => {
    expect(() => build([pass("a", "A"), pass("a", "A again")])).toThrow(/duplicate/);
    expect(() => build([{ id: "x", title: "X", status: "FAIL" }])).toThrow(/reason code/);
  });

  it("refuses to emit a report that contains a key or secret", () => {
    expect(() => build([pass("a", "A", { leaked: "sk_test_abc123" })])).toThrow(/secret/);
    expect(() => build([pass("a", "A", undefined, "whsec_abc123")])).toThrow(/secret/);
    expect(() => build([pass("a", "A", { priceId: "price_1ABC" })])).not.toThrow();
  });
});

describe("BILLING-QA test-mode key guard", () => {
  it("accepts secret and restricted test keys", () => {
    expect(assertBillingQaTestModeKey(" sk_test_abc ")).toBe("sk_test_abc");
    expect(assertBillingQaTestModeKey("rk_test_abc")).toBe("rk_test_abc");
  });

  it("refuses live, missing and malformed keys without echoing the value", () => {
    expect(() => assertBillingQaTestModeKey("sk_live_secretvalue")).toThrow(expect.objectContaining({ code: "STRIPE_KEY_LIVE_MODE" }));
    expect(() => assertBillingQaTestModeKey("rk_live_secretvalue")).toThrow(expect.objectContaining({ code: "STRIPE_KEY_LIVE_MODE" }));
    expect(() => assertBillingQaTestModeKey(undefined)).toThrow(expect.objectContaining({ code: "STRIPE_KEY_MISSING" }));
    expect(() => assertBillingQaTestModeKey("pk_test_abc")).toThrow(expect.objectContaining({ code: "STRIPE_KEY_MALFORMED" }));
    try {
      assertBillingQaTestModeKey("sk_live_secretvalue");
    } catch (error) {
      expect((error as Error).message).not.toContain("secretvalue");
    }
  });
});
