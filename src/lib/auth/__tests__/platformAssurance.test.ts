import { beforeEach, describe, expect, it, vi } from "vitest";

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));

const ADMIN = "a6000000-0000-4000-8000-000000000501";
let role: "admin" | "other" = "admin";
const roleCalls: string[] = [];
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    roleCalls.push("role");
    if (role !== "admin") throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));

type ClaimsResult = { data: { claims: Record<string, unknown> } | null; error: { message: string } | null };
let claimsResult: ClaimsResult | "throw" = { data: null, error: null };
let getClaimsCalls = 0;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        getClaimsCalls += 1;
        if (claimsResult === "throw") throw new Error("boom");
        return claimsResult;
      },
    },
  }),
}));

import {
  STEP_UP_SKEW_SECONDS,
  STEP_UP_WINDOW_SECONDS,
  evaluateAssurance,
  requirePlatformStepUp,
  safePlatformReturnPath,
  stepUpChallengeUrl,
  stepUpMessage,
} from "../platform-assurance";

const NOW = 1_800_000_000;
const claims = (over: Record<string, unknown> = {}) => ({
  sub: ADMIN,
  exp: NOW + 3000,
  aal: "aal2",
  amr: [{ method: "totp", timestamp: NOW - 60 }, { method: "password", timestamp: NOW - 600 }],
  ...over,
});
const liveNow = () => Math.floor(Date.now() / 1000);

describe("evaluateAssurance (pure)", () => {
  it("accepts a fresh aal2 TOTP session for both tiers", () => {
    expect(evaluateAssurance(claims(), NOW, "aal2", ADMIN)).toEqual({ ok: true });
    expect(evaluateAssurance(claims(), NOW, "recent", ADMIN)).toEqual({ ok: true });
  });

  it("refuses an aal1 session", () => {
    expect(evaluateAssurance(claims({ aal: "aal1", amr: [{ method: "password", timestamp: NOW }] }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "aal1" });
  });

  it("refuses a missing, malformed or unknown aal claim", () => {
    for (const aal of [undefined, null, "", "AAL2", "aal3", 2, ["aal2"]]) {
      expect(evaluateAssurance(claims({ aal }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "aal1" });
    }
  });

  it("refuses missing / null / non-object claims", () => {
    for (const c of [null, undefined, "aal2", 5, []]) {
      expect(evaluateAssurance(c as never, NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "claims_unavailable" });
    }
  });

  it("refuses aal2 with no TOTP method (missing or non-totp amr)", () => {
    for (const amr of [undefined, [], "totp", [{ method: "password", timestamp: NOW }], [{ method: "otp", timestamp: NOW }], ["password"]]) {
      expect(evaluateAssurance(claims({ amr }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "no_totp" });
    }
  });

  it("refuses an expired or exp-less token", () => {
    expect(evaluateAssurance(claims({ exp: NOW }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "session_expired" });
    expect(evaluateAssurance(claims({ exp: NOW - 1 }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "session_expired" });
    expect(evaluateAssurance(claims({ exp: undefined }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "session_expired" });
    expect(evaluateAssurance(claims({ exp: "9999999999" }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "session_expired" });
  });

  it("refuses a token for a different subject", () => {
    expect(evaluateAssurance(claims({ sub: "someone-else" }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "subject_mismatch" });
    expect(evaluateAssurance(claims({ sub: undefined }), NOW, "aal2", ADMIN)).toEqual({ ok: false, reason: "subject_mismatch" });
    expect(evaluateAssurance(claims({ sub: "" }), NOW, "aal2", "")).toEqual({ ok: false, reason: "subject_mismatch" });
  });

  it("recent: refuses an expired step-up but the same session still passes the aal2 tier", () => {
    const old = claims({ amr: [{ method: "totp", timestamp: NOW - STEP_UP_WINDOW_SECONDS - 1 }] });
    expect(evaluateAssurance(old, NOW, "recent", ADMIN)).toEqual({ ok: false, reason: "stale" });
    expect(evaluateAssurance(old, NOW, "aal2", ADMIN)).toEqual({ ok: true });
  });

  it("recent: the window boundary is inclusive and uses the NEWEST totp entry", () => {
    const edge = claims({ amr: [{ method: "totp", timestamp: NOW - STEP_UP_WINDOW_SECONDS }] });
    expect(evaluateAssurance(edge, NOW, "recent", ADMIN)).toEqual({ ok: true });
    const mixed = claims({ amr: [{ method: "totp", timestamp: NOW - 99999 }, { method: "totp", timestamp: NOW - 10 }] });
    expect(evaluateAssurance(mixed, NOW, "recent", ADMIN)).toEqual({ ok: true });
  });

  it("recent: a password re-login timestamp does not renew the step-up", () => {
    const c = claims({ amr: [{ method: "password", timestamp: NOW }, { method: "totp", timestamp: NOW - STEP_UP_WINDOW_SECONDS - 5 }] });
    expect(evaluateAssurance(c, NOW, "recent", ADMIN)).toEqual({ ok: false, reason: "stale" });
  });

  it("recent: no usable timestamp is refused; a far-future timestamp is refused; small skew is tolerated", () => {
    for (const amr of [["totp"], [{ method: "totp" }], [{ method: "totp", timestamp: Number.NaN }], [{ method: "totp", timestamp: String(NOW) }]]) {
      expect(evaluateAssurance(claims({ amr }), NOW, "recent", ADMIN)).toEqual({ ok: false, reason: "stale" });
    }
    const future = claims({ amr: [{ method: "totp", timestamp: NOW + STEP_UP_SKEW_SECONDS + 1 }] });
    expect(evaluateAssurance(future, NOW, "recent", ADMIN)).toEqual({ ok: false, reason: "stale" });
    const skewed = claims({ amr: [{ method: "totp", timestamp: NOW + STEP_UP_SKEW_SECONDS }] });
    expect(evaluateAssurance(skewed, NOW, "recent", ADMIN)).toEqual({ ok: true });
  });

  it("the aal2 tier accepts the string amr format (no timestamp is needed)", () => {
    expect(evaluateAssurance(claims({ amr: ["totp", "password"] }), NOW, "aal2", ADMIN)).toEqual({ ok: true });
  });
});

describe("requirePlatformStepUp", () => {
  beforeEach(() => {
    redirects.length = 0;
    roleCalls.length = 0;
    getClaimsCalls = 0;
    role = "admin";
    const now = liveNow();
    claimsResult = { data: { claims: claims({ exp: now + 3000, amr: [{ method: "totp", timestamp: now - 30 }] }) }, error: null };
  });

  it("returns the admin for a verified fresh aal2 session", async () => {
    await expect(requirePlatformStepUp("recent")).resolves.toEqual({ id: ADMIN });
    expect(redirects).toEqual([]);
  });

  it("a non-admin is refused by the role check and no claims are read", async () => {
    role = "other";
    await expect(requirePlatformStepUp("aal2")).rejects.toThrow("NOT_PLATFORM_ADMIN");
    expect(getClaimsCalls).toBe(0);
  });

  it("the role check runs before the claims read", async () => {
    await requirePlatformStepUp("aal2");
    expect(roleCalls).toEqual(["role"]);
    expect(getClaimsCalls).toBe(1);
  });

  it("an aal1 session redirects to the MFA challenge and never returns", async () => {
    claimsResult = { data: { claims: claims({ aal: "aal1", exp: liveNow() + 3000 }) }, error: null };
    await expect(requirePlatformStepUp("aal2")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects).toEqual(["/platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fsms"]);
  });

  it("an expired step-up redirects with reason=stale for the recent tier only", async () => {
    const now = liveNow();
    claimsResult = { data: { claims: claims({ exp: now + 3000, amr: [{ method: "totp", timestamp: now - STEP_UP_WINDOW_SECONDS - 30 }] }) }, error: null };
    await expect(requirePlatformStepUp("recent")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects[0]).toContain("reason=stale");
    redirects.length = 0;
    await expect(requirePlatformStepUp("aal2")).resolves.toEqual({ id: ADMIN });
  });

  it("missing claims, a claims error and a thrown error all fail closed", async () => {
    const results: (ClaimsResult | "throw")[] = [
      { data: null, error: null },
      { data: null, error: { message: "jwt invalid" } },
      { data: { claims: null as never }, error: null },
      "throw",
    ];
    for (const result of results) {
      claimsResult = result;
      redirects.length = 0;
      await expect(requirePlatformStepUp("aal2")).rejects.toThrow("NEXT_REDIRECT");
      expect(redirects[0]).toContain("reason=claims_unavailable");
    }
  });

  it("claims for a different user than the session admin are refused", async () => {
    claimsResult = { data: { claims: claims({ sub: "another-user", exp: liveNow() + 3000 }) }, error: null };
    await expect(requirePlatformStepUp("aal2")).rejects.toThrow("NEXT_REDIRECT");
    expect(redirects[0]).toContain("reason=subject_mismatch");
  });
});

describe("return path and messages", () => {
  it("only accepts a plain /platform path as a return target", () => {
    expect(safePlatformReturnPath("/platform/sms")).toBe("/platform/sms");
    expect(safePlatformReturnPath("/platform")).toBe("/platform");
    for (const bad of ["https://evil.example/platform", "//evil.example", "/\\evil", "/platform/../app", "/platform/%2e%2e", "/platformx", "/platform?x=1", "/app", "", null, undefined, 5]) {
      expect(safePlatformReturnPath(bad)).toBe("/platform/sms");
    }
    expect(stepUpChallengeUrl("stale", "//evil.example")).toBe("/platform-mfa/challenge?stepup=1&reason=stale&next=%2Fplatform%2Fsms");
  });

  it("every refusal reason has a clear message saying the action was not performed; unknown reasons show none", () => {
    for (const r of ["stale", "aal1", "no_totp", "claims_unavailable", "subject_mismatch", "session_expired"]) {
      expect(stepUpMessage(r)).toMatch(/not performed/);
    }
    expect(stepUpMessage("bogus")).toBeNull();
    expect(stepUpMessage(undefined)).toBeNull();
  });
});
