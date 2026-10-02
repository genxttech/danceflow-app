import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () => new Map([["host", "app.example"]]),
  cookies: async () => ({ get: () => undefined }),
}));

class RedirectSignal extends Error {
  constructor(public readonly location: string) {
    super(`redirect:${location}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (location: string) => {
    throw new RedirectSignal(location);
  },
}));

vi.mock("@/lib/security/rate-limit", () => ({
  checkRateLimit: () => ({ allowed: true }),
  getServerActionRateLimitKey: async () => "key",
  rateLimitErrorMessage: () => "slow down",
}));

vi.mock("@/lib/security/redirects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/redirects")>()),
  getTrustedRequestOrigin: () => "https://app.example",
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));

const sendEmailVerificationLink = vi.fn();
const completePasswordBinding = vi.fn();
vi.mock("@/lib/auth/verifiedEmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/verifiedEmail")>()),
  sendEmailVerificationLink: (...args: unknown[]) => sendEmailVerificationLink(...args),
  completePasswordBinding: (...args: unknown[]) => completePasswordBinding(...args),
}));

const signInWithPassword = vi.fn();
const signUp = vi.fn();
const signInWithOtp = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "Current@Example.com" } } }),
      getSession: async () => ({ data: { session: { access_token: "proof-token" } } }),
      signInWithPassword: (...args: unknown[]) => signInWithPassword(...args),
      signUp: (...args: unknown[]) => signUp(...args),
      signInWithOtp: (...args: unknown[]) => signInWithOtp(...args),
    },
  }),
}));

const { bindPasswordAction, sendVerificationEmailAction } = await import("../actions");
const { signupAction } = await import("@/app/(auth)/actions");

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.location;
    throw error;
  }
  throw new Error("expected redirect");
}

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

beforeEach(() => {
  sendEmailVerificationLink.mockReset().mockResolvedValue(true);
  completePasswordBinding.mockReset();
  signInWithPassword.mockReset().mockResolvedValue({ error: null });
  signUp.mockReset();
  signInWithOtp.mockReset();
});

describe("LAUNCH-SEC-1C-A Verify your email", () => {
  it("only ever emails the signed-in user's CURRENT auth email (form email ignored)", async () => {
    const location = await redirectOf(() =>
      sendVerificationEmailAction(form({ email: "attacker@example.com", next: "/app" })),
    );
    expect(sendEmailVerificationLink).toHaveBeenCalledTimes(1);
    const args = sendEmailVerificationLink.mock.calls[0][0];
    expect(args.email).toBe("current@example.com");
    expect(args.purpose).toBe("verify");
    expect(args.nextPath).toBe("/account/verify-email?next=%2Fapp");
    expect(location).toBe("/account/verify-email?next=%2Fapp&sent=1");
  });

  it("drops an unsafe next path", async () => {
    await redirectOf(() => sendVerificationEmailAction(form({ next: "https://evil.example" })));
    expect(sendEmailVerificationLink.mock.calls[0][0].nextPath).toBe("/account/verify-email");
  });
});

describe("LAUNCH-SEC-1C-A password binding action", () => {
  it("binding failure stays blocked: no sign-in, error shown", async () => {
    completePasswordBinding.mockResolvedValue({ ok: false, code: "not_ready" });
    const location = await redirectOf(() =>
      bindPasswordAction(form({ password: "long-enough-1", confirmPassword: "long-enough-1", next: "/app" })),
    );
    expect(location).toBe("/account/verify-email?next=%2Fapp&error=not_ready");
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("passes only the server session token and password, then requires a NEW session", async () => {
    completePasswordBinding.mockResolvedValue({ ok: true, email: "current@example.com" });
    const location = await redirectOf(() =>
      bindPasswordAction(
        form({
          password: "long-enough-1",
          confirmPassword: "long-enough-1",
          next: "/app",
          userId: "someone-else",
          sessionId: "forged",
          email: "forged@example.com",
        }),
      ),
    );
    const args = completePasswordBinding.mock.calls[0][0];
    expect(Object.keys(args).sort()).toEqual(["accessToken", "adminClient", "password", "userClient"]);
    expect(args.accessToken).toBe("proof-token");
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "current@example.com", password: "long-enough-1" });
    expect(location).toBe("/app");
  });

  it("mismatched confirmation never reaches binding", async () => {
    const location = await redirectOf(() =>
      bindPasswordAction(form({ password: "long-enough-1", confirmPassword: "different-22" })),
    );
    expect(location).toBe("/account/verify-email?error=password_mismatch");
    expect(completePasswordBinding).not.toHaveBeenCalled();
  });
});

describe("LAUNCH-SEC-1C-A passwordless-first business signup", () => {
  it("sends a confirmation link carrying intent/plan context and never signs up with a password", async () => {
    const location = await redirectOf(() =>
      signupAction(
        form({
          fullName: "Jane Owner",
          email: "Owner@Example.com",
          password: "ignored-password",
          signupIntent: "studio",
          selectedPlan: "growth",
          legalAccepted: "on",
        }),
      ),
    );

    expect(signUp).not.toHaveBeenCalled();
    expect(signInWithOtp).not.toHaveBeenCalled();
    const args = sendEmailVerificationLink.mock.calls[0][0];
    expect(args.email).toBe("owner@example.com");
    expect(args.purpose).toBe("signup");
    expect(args.nextPath).toBe("/get-started/complete?intent=studio&plan=growth");
    expect(args.userMetadata).toEqual({ full_name: "Jane Owner", signup_intent: "studio", selected_plan: "growth" });
    const url = new URL(location, "https://app.example");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("mode")).toBe("check-email");
    expect(url.searchParams.get("next")).toBe("/get-started/complete?intent=studio&plan=growth");
  });

  it("reports a send failure without creating anything else", async () => {
    sendEmailVerificationLink.mockResolvedValue(false);
    const result = await signupAction(
      form({ fullName: "Jane Owner", email: "owner@example.com", signupIntent: "organizer" }),
    );
    expect(result).toEqual({ error: "We could not send your confirmation email. Please try again in a moment." });
    expect(signUp).not.toHaveBeenCalled();
  });
});
