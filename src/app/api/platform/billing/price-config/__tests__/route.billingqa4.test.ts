import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BILLING-QA-4: GET /api/platform/billing/price-config is dark (404) unless enabled, hidden (404) from everyone but
 * platform admins, requires a TOTP-verified (AAL2) session, never caches, and never returns a key or secret.
 */

const state = vi.hoisted(() => ({
  profile: null as { id: string; email: string; platform_role: string | null } | null,
  aal: "aal2" as string | null,
  mfaThrows: false,
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
    return { currentLevel: state.aal, nextLevel: "aal2", hasVerifiedTotpFactor: true, verifiedTotpFactors: [] };
  },
}));

const { GET } = await import("@/app/api/platform/billing/price-config/route");

const ADMIN = { id: "u-1", email: "admin@example.test", platform_role: "platform_admin" };
// Fake value, assembled at runtime so secret scanners do not mistake the fixture for a real key.
const FAKE_LIVE_KEY = ["sk", "live", "routeTestSecretValue"].join("_");

beforeEach(() => {
  state.profile = ADMIN;
  state.aal = "aal2";
  state.mfaThrows = false;
  state.authCalls = 0;
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
});

describe("GET /api/platform/billing/price-config (BILLING-QA-4)", () => {
  it.each([undefined, "", "true", "ENABLED"])("dark unless exactly 'enabled' (%s): 404 before any auth lookup", async (flag) => {
    vi.stubEnv("BILLING_QA_PRICE_CONFIG_ENDPOINT", flag as string);
    const response = await GET();
    expect(response.status).toBe(404);
    expect(state.authCalls).toBe(0);
  });

  it.each([
    ["anonymous", null],
    ["studio owner", { id: "u-2", email: "owner@example.test", platform_role: null }],
    ["other platform role", { id: "u-3", email: "support@example.test", platform_role: "platform_support" }],
  ])("%s: 404, indistinguishable from the endpoint not existing", async (_label, profile) => {
    state.profile = profile;
    const response = await GET();
    expect([response.status, await response.text()]).toEqual([404, "Not found"]);
  });

  it("platform admin without a TOTP-verified session: 403 platform_mfa_required", async () => {
    state.aal = "aal1";
    const response = await GET();
    expect([response.status, await response.json()]).toEqual([403, { error: "platform_mfa_required" }]);
  });

  it("MFA status unavailable: fails closed with 503", async () => {
    state.mfaThrows = true;
    expect((await GET()).status).toBe(503);
  });

  it("platform admin at AAL2: the config report, uncached, with no key or secret in it", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    for (const secret of [FAKE_LIVE_KEY, "whsec_routeTestPlatform", "whsec_routeTestConnect"]) expect(text).not.toContain(secret);
    const report = JSON.parse(text);
    expect([report.mode, report.overall]).toEqual(["config", "PASS"]);
    expect(report.config).toMatchObject({ STRIPE_PRICE_STUDIO_GROWTH_FOUNDER: "price_g", stripeAmountsChecked: false });
  });
});
