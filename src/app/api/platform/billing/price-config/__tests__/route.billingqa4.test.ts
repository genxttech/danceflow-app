import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BILLING-QA-4: GET /api/platform/billing/price-config is dark (404) unless enabled, answers the same 404 to everyone
 * but platform admins, requires a verified TOTP factor and an AAL2 session (as /platform does), never caches, fails
 * closed when the report builder refuses, and never returns a key, secret or non-Price value.
 */

const state = vi.hoisted(() => ({
  profile: null as { id: string; email: string; platform_role: string | null } | null,
  aal: "aal2" as string | null,
  totp: true,
  mfaThrows: false,
  reportThrows: false,
  authCalls: 0,
}));

vi.mock("@/lib/auth/platform", () => ({
  getCurrentUserProfile: async () => {
    state.authCalls += 1;
    return state.profile;
  },
}));
vi.mock("@/lib/auth/platform-mfa", () => ({
  getPlatformMfaStatus: async () => {
    if (state.mfaThrows) throw new Error("mfa lookup failed");
    return { currentLevel: state.aal, nextLevel: "aal2", hasVerifiedTotpFactor: state.totp, verifiedTotpFactors: [] };
  },
}));
vi.mock("@/lib/billing-qa/priceConfigReport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing-qa/priceConfigReport")>();
  return {
    ...actual,
    buildPriceConfigReport: (...args: Parameters<typeof actual.buildPriceConfigReport>) => {
      if (state.reportThrows) throw new Error("billing QA report: refusing to emit a report that contains a key or secret");
      return actual.buildPriceConfigReport(...args);
    },
  };
});

const { GET } = await import("@/app/api/platform/billing/price-config/route");

const ADMIN = { id: "u-1", email: "admin@example.test", platform_role: "platform_admin" };
// Fake values, assembled at runtime so secret scanners do not mistake fixtures for real keys.
const FAKE_LIVE_KEY = ["sk", "live", "routeTestSecretValue"].join("_");
const FAKE_PASTED_KEY = ["rk", "live", "pastedIntoPriceVariable"].join("_");

beforeEach(() => {
  state.profile = ADMIN;
  state.aal = "aal2";
  state.totp = true;
  state.mfaThrows = false;
  state.reportThrows = false;
  state.authCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("BILLING_QA_PRICE_CONFIG_ENDPOINT", "enabled");
  vi.stubEnv("STRIPE_SECRET_KEY", FAKE_LIVE_KEY);
  vi.stubEnv("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "pk_live_routeTest");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_routeTestPlatform");
  vi.stubEnv("STRIPE_CONNECT_WEBHOOK_SECRET", "whsec_routeTestConnect");
  vi.stubEnv("STRIPE_PRICE_STUDIO_STARTER_FOUNDER", "price_s");
  vi.stubEnv("STRIPE_PRICE_STUDIO_GROWTH_FOUNDER", "price_g");
  vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER", "price_p");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/platform/billing/price-config (BILLING-QA-4)", () => {
  it.each([undefined, "", "true", "ENABLED"])("dark unless exactly 'enabled' (%s): 404 before any auth lookup", async (flag) => {
    vi.stubEnv("BILLING_QA_PRICE_CONFIG_ENDPOINT", flag as string);
    const response = await GET();
    expect([response.status, await response.text()]).toEqual([404, "Not found"]);
    expect(state.authCalls).toBe(0);
  });

  it.each([
    ["anonymous", null],
    ["studio owner", { id: "u-2", email: "owner@example.test", platform_role: null }],
    ["other platform role", { id: "u-3", email: "support@example.test", platform_role: "platform_support" }],
  ])("%s: the same 404 as when the endpoint is dark", async (_label, profile) => {
    state.profile = profile;
    const response = await GET();
    expect([response.status, await response.text()]).toEqual([404, "Not found"]);
  });

  it("platform admin at AAL1: 403 platform_mfa_required", async () => {
    state.aal = "aal1";
    const response = await GET();
    expect([response.status, await response.json()]).toEqual([403, { error: "platform_mfa_required" }]);
  });

  it("platform admin at AAL2 without a verified TOTP factor (as /platform requires): 403", async () => {
    state.totp = false;
    expect((await GET()).status).toBe(403);
  });

  it("MFA status unavailable: fails closed with 503", async () => {
    state.mfaThrows = true;
    expect((await GET()).status).toBe(503);
  });

  it("report builder refuses: fails closed with 500 report_refused, no details, no-store", async () => {
    state.reportThrows = true;
    const response = await GET();
    expect([response.status, response.headers.get("cache-control"), await response.json()]).toEqual([500, "no-store", { error: "report_refused" }]);
  });

  it("platform admin with TOTP at AAL2: the config report, uncached, with no key, secret or pasted value in it", async () => {
    vi.stubEnv("STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY", `price_legacy129,${FAKE_PASTED_KEY}`);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    for (const secret of [FAKE_LIVE_KEY, FAKE_PASTED_KEY, "whsec_routeTestPlatform", "whsec_routeTestConnect"]) expect(text).not.toContain(secret);
    const report = JSON.parse(text);
    expect([report.mode, report.overall]).toEqual(["config", "FAIL"]); // the pasted value is a malformed legacy Price ID
    expect(report.config).toMatchObject({ STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_g", STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_legacy129,malformed", stripeAmountsChecked: false });
  });
});
