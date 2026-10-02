import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ cookie: true }) }));

const completePasswordBinding = vi.fn();
vi.mock("@/lib/auth/verifiedEmail", () => ({
  completePasswordBinding: (...args: unknown[]) => completePasswordBinding(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dev-test.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";

const { POST } = await import("../route");

function request(body: unknown, token: string | null = "mobile-proof-token") {
  return new Request("https://app.example/api/student/account/email-binding", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => completePasswordBinding.mockReset());

describe("LAUNCH-SEC-1C-A mobile binding endpoint", () => {
  it("requires a bearer session", async () => {
    const response = await POST(request({ password: "long-enough-1" }, null));
    expect(response.status).toBe(401);
    expect(completePasswordBinding).not.toHaveBeenCalled();
  });

  it("binds with the bearer token only; body identity fields are ignored", async () => {
    completePasswordBinding.mockResolvedValue({ ok: true, email: "s@example.com" });
    const response = await POST(
      request({ password: "long-enough-1", userId: "other", sessionId: "forged", email: "x@example.com" }),
    );
    expect(response.status).toBe(200);
    const args = completePasswordBinding.mock.calls[0][0];
    expect(args.accessToken).toBe("mobile-proof-token");
    expect(args.password).toBe("long-enough-1");
    expect(Object.keys(args).sort()).toEqual(["accessToken", "adminClient", "password", "userClient"]);
  });

  it("a session that is not the fresh proof session is refused without detail", async () => {
    completePasswordBinding.mockResolvedValue({ ok: false, code: "not_ready" });
    const response = await POST(request({ password: "long-enough-1" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Your verification link has expired. Sign in with a new email link to continue.",
    });
  });
});
