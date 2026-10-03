import { beforeEach, describe, expect, it, vi } from "vitest";
import { ATTRIBUTION_COOKIE_NAME, serializeAttribution } from "@/lib/public/attribution";

/**
 * BR-4C: signup copies ONLY validated, namespaced first-touch attribution into auth user
 * metadata (both the passwordless public path and the business path), and a forged cookie
 * cannot inject other keys or override the fixed ones.
 */

vi.mock("server-only", () => ({}));

const cookieStore: Record<string, string> = {};

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieStore[name] !== undefined ? { value: cookieStore[name] } : undefined),
  }),
  headers: async () => new Map(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "k",
  rateLimitErrorMessage: () => "limited",
}));

vi.mock("@/lib/security/redirects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/redirects")>()),
  getTrustedRequestOrigin: () => "https://www.idanceflow.com",
}));

const signInWithOtp = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { signInWithOtp: (...args: unknown[]) => signInWithOtp(...args) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

const sendEmailVerificationLink = vi.fn();
vi.mock("@/lib/auth/verifiedEmail", () => ({
  sendEmailVerificationLink: (...args: unknown[]) => sendEmailVerificationLink(...args),
}));

vi.mock("@/lib/auth/studio", () => ({ getAccessibleStudioRolesForUser: vi.fn() }));
vi.mock("@/lib/auth/verifiedIdentity", () => ({ getMyVerifiedEmail: vi.fn() }));
vi.mock("@/lib/auth/portal-linking", () => ({
  claimGroupLessonRecapsForUser: vi.fn(),
  decidePortalDestination: vi.fn(),
  ensurePortalProfileAndClientLinks: vi.fn(),
  getGroupLessonRecapTokenFromPath: vi.fn(),
  listLinkedPortalDestinations: vi.fn(),
  PORTAL_SELECTED_STUDIO_COOKIE: "portal_selected_studio_id",
}));

import { signupAction } from "@/app/(auth)/actions";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function run(fields: Record<string, string>) {
  try {
    await signupAction(form(fields));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("REDIRECT:")) throw error;
  }
}

const GOOD = serializeAttribution(
  { utm_source: "flyer", utm_medium: "qr", utm_campaign: "br4" },
  new Date("2026-10-03T12:00:00Z"),
)!;

beforeEach(() => {
  for (const key of Object.keys(cookieStore)) delete cookieStore[key];
  signInWithOtp.mockReset().mockResolvedValue({ error: null });
  sendEmailVerificationLink.mockReset().mockResolvedValue(true);
});

describe("public (dancer) signup", () => {
  it("includes namespaced attribution next to the existing metadata", async () => {
    cookieStore[ATTRIBUTION_COOKIE_NAME] = GOOD;

    await run({ fullName: "Alex Dancer", email: "alex@example.test", signupIntent: "public" });

    const { options } = signInWithOtp.mock.calls[0][0] as { options: { data: Record<string, string> } };
    expect(options.data).toEqual({
      attribution_utm_source: "flyer",
      attribution_utm_medium: "qr",
      attribution_utm_campaign: "br4",
      attribution_captured_on: "2026-10-03",
      full_name: "Alex Dancer",
      signup_intent: "public",
    });
  });

  it("behaves exactly as before when there is no attribution cookie", async () => {
    await run({ fullName: "Alex Dancer", email: "alex@example.test", signupIntent: "public" });

    const { options } = signInWithOtp.mock.calls[0][0] as { options: { data: Record<string, string> } };
    expect(options.data).toEqual({ full_name: "Alex Dancer", signup_intent: "public" });
  });
});

describe("business signup", () => {
  it("includes namespaced attribution in the new user's metadata", async () => {
    cookieStore[ATTRIBUTION_COOKIE_NAME] = GOOD;

    await run({
      fullName: "Sam Studio",
      email: "sam@example.test",
      signupIntent: "studio",
      selectedPlan: "starter",
    });

    const { userMetadata } = sendEmailVerificationLink.mock.calls[0][0] as { userMetadata: Record<string, unknown> };
    expect(userMetadata).toEqual({
      attribution_utm_source: "flyer",
      attribution_utm_medium: "qr",
      attribution_utm_campaign: "br4",
      attribution_captured_on: "2026-10-03",
      full_name: "Sam Studio",
      signup_intent: "studio",
      selected_plan: "starter",
    });
  });

  it("metadata is unchanged when no attribution exists", async () => {
    await run({ fullName: "Sam Studio", email: "sam@example.test", signupIntent: "organizer" });

    const { userMetadata } = sendEmailVerificationLink.mock.calls[0][0] as { userMetadata: Record<string, unknown> };
    expect(userMetadata).toEqual({ full_name: "Sam Studio", signup_intent: "organizer", selected_plan: null });
  });
});

describe("forged or malformed cookies", () => {
  const forged = encodeURIComponent(
    JSON.stringify({
      utm_source: "flyer",
      full_name: "Evil Admin",
      signup_intent: "platform_admin",
      selected_plan: "enterprise",
      role: "platform_admin",
      platform_role: "platform_admin",
      email: "victim@example.test",
      captured_on: "2026-10-03",
    }),
  );

  it("cannot inject arbitrary keys or override fixed metadata (public path)", async () => {
    cookieStore[ATTRIBUTION_COOKIE_NAME] = forged;

    await run({ fullName: "Alex Dancer", email: "alex@example.test", signupIntent: "public" });

    const { options } = signInWithOtp.mock.calls[0][0] as { options: { data: Record<string, string> } };
    expect(options.data).toEqual({
      attribution_utm_source: "flyer",
      attribution_captured_on: "2026-10-03",
      full_name: "Alex Dancer",
      signup_intent: "public",
    });
  });

  it("cannot inject arbitrary keys or override fixed metadata (business path)", async () => {
    cookieStore[ATTRIBUTION_COOKIE_NAME] = forged;

    await run({ fullName: "Sam Studio", email: "sam@example.test", signupIntent: "studio", selectedPlan: "starter" });

    const { userMetadata } = sendEmailVerificationLink.mock.calls[0][0] as { userMetadata: Record<string, unknown> };
    expect(Object.keys(userMetadata).sort()).toEqual(
      [
        "attribution_captured_on",
        "attribution_utm_source",
        "full_name",
        "selected_plan",
        "signup_intent",
      ].sort(),
    );
    expect(userMetadata.full_name).toBe("Sam Studio");
    expect(userMetadata.signup_intent).toBe("studio");
    expect(userMetadata.selected_plan).toBe("starter");
  });

  it.each(["not-json", "%E0%A4%A", encodeURIComponent("[]"), "a".repeat(5000)])(
    "malformed cookie %#: signup proceeds with no attribution",
    async (value) => {
      cookieStore[ATTRIBUTION_COOKIE_NAME] = value;

      await run({ fullName: "Alex Dancer", email: "alex@example.test", signupIntent: "public" });

      const { options } = signInWithOtp.mock.calls[0][0] as { options: { data: Record<string, string> } };
      expect(options.data).toEqual({ full_name: "Alex Dancer", signup_intent: "public" });
    },
  );

  it("a form field cannot supply attribution; only the validated cookie is read", async () => {
    await run({
      fullName: "Alex Dancer",
      email: "alex@example.test",
      signupIntent: "public",
      attribution_utm_source: "from-form",
      utm_source: "from-form",
    });

    const { options } = signInWithOtp.mock.calls[0][0] as { options: { data: Record<string, string> } };
    expect(options.data).toEqual({ full_name: "Alex Dancer", signup_intent: "public" });
  });
});
