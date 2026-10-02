import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const rpcCalls: string[] = [];
let proofAnswer: string = "binding_required";
let exchangeFails = false;
const verifyOtp = vi.fn();
const exchangeCodeForSession = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      verifyOtp: async (...args: unknown[]) => {
        verifyOtp(...args);
        return { error: exchangeFails ? { message: "expired", code: "otp_expired", status: 403 } : null };
      },
      exchangeCodeForSession: async (...args: unknown[]) => {
        exchangeCodeForSession(...args);
        return { error: exchangeFails ? { message: "bad", code: "bad_code", status: 400 } : null };
      },
      getUser: async () => ({ data: { user: { id: "user-1", email: "owner@example.com", user_metadata: {} } }, error: null }),
      getSession: async () => ({ data: { session: { access_token: "proof-token" } } }),
    },
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      if (fn === "record_email_proof_web") return { data: proofAnswer, error: null };
      return { data: 0, error: null };
    },
  }),
}));

const adminSignOut = vi.fn();
let revokeFails = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        signOut: async (...args: unknown[]) => {
          adminSignOut(...args);
          return { error: revokeFails ? { code: "x" } : null };
        },
      },
    },
  }),
}));

vi.mock("@/lib/auth/portal-linking", () => ({
  claimGroupLessonRecapsForUser: async () => ({ claimedCount: 0 }),
  decidePortalDestination: () => ({ type: "none" }),
  ensurePortalProfileAndClientLinks: async () => undefined,
  getAuthUserFullName: () => null,
  getGroupLessonRecapTokenFromPath: () => null,
  listLinkedPortalDestinations: async () => [],
  PORTAL_SELECTED_STUDIO_COOKIE: "portal_selected_studio_id",
}));

vi.mock("@/lib/auth/studio", () => ({
  getAccessibleStudioRolesForUser: async () => [],
  isOrganizerRole: () => false,
}));

const { GET, resolveEmailBindingDestination } = await import("../route");

async function callback(query: string) {
  const response = await GET(new NextRequest(`http://localhost:3000/callback?${query}`));
  return new URL(response.headers.get("location") ?? "", "http://localhost:3000");
}

beforeEach(() => {
  rpcCalls.length = 0;
  proofAnswer = "binding_required";
  exchangeFails = false;
  revokeFails = false;
  adminSignOut.mockReset();
  verifyOtp.mockReset();
  exchangeCodeForSession.mockReset();
});

describe("LAUNCH-SEC-1C-A callback proof recording", () => {
  it("records proof after a successful token_hash exchange and routes a first proof to binding", async () => {
    const location = await callback("token_hash=th&type=magiclink&next=%2Fget-started%2Fcomplete%3Fintent%3Dstudio");
    expect(rpcCalls.filter((fn) => fn === "record_email_proof_web")).toHaveLength(1);
    expect(adminSignOut).toHaveBeenCalledWith("proof-token", "others");
    expect(location.pathname).toBe("/account/verify-email");
    expect(location.searchParams.get("next")).toBe("/get-started/complete?intent=studio");
    expect(location.searchParams.get("revoke")).toBeNull();
  });

  it("flags a failed other-session revocation and still routes to binding (stays blocked)", async () => {
    revokeFails = true;
    const location = await callback("token_hash=th&type=magiclink");
    expect(location.pathname).toBe("/account/verify-email");
    expect(location.searchParams.get("revoke")).toBe("failed");
  });

  it("does not route to binding or revoke when the database records no proof", async () => {
    proofAnswer = "no_fresh_mailbox_auth";
    const location = await callback("token_hash=th&type=magiclink&next=%2Fapp%2Fsettings");
    expect(location.pathname).toBe("/app/settings");
    expect(adminSignOut).not.toHaveBeenCalled();
  });

  it("an already bound identity continues normally", async () => {
    proofAnswer = "bound";
    const location = await callback("token_hash=th&type=magiclink&next=%2Fapp%2Fsettings");
    expect(location.pathname).toBe("/app/settings");
    expect(adminSignOut).not.toHaveBeenCalled();
  });

  it("a failed exchange never records proof", async () => {
    exchangeFails = true;
    const location = await callback("token_hash=th&type=signup");
    expect(location.pathname).toBe("/login");
    expect(rpcCalls).not.toContain("record_email_proof_web");
  });

  it("the PKCE code path stays fail-closed: no proof, whatever `type` says", async () => {
    for (const type of ["signup", "recovery", "magiclink", "email"]) {
      await callback(`code=abc&type=${type}`);
    }
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(4);
    expect(rpcCalls).not.toContain("record_email_proof_web");
    expect(adminSignOut).not.toHaveBeenCalled();
  });

  it("LAUNCH-SEC-1C-A1 D/E: the token is verified with the link's type (signup or magiclink)", async () => {
    await callback("token_hash=new-owner&type=signup&next=%2Fget-started%2Fcomplete");
    await callback("token_hash=existing&type=magiclink");
    expect(verifyOtp.mock.calls.map((call) => call[0])).toEqual([
      { token_hash: "new-owner", type: "signup" },
      { token_hash: "existing", type: "magiclink" },
    ]);
  });

  it("LAUNCH-SEC-1C-A1 G: a link type alone never creates proof; the database decides after verification", async () => {
    exchangeFails = true;
    await callback("token_hash=tampered&type=recovery");
    expect(rpcCalls).not.toContain("record_email_proof_web");
    exchangeFails = false;
    proofAnswer = "no_fresh_mailbox_auth";
    const location = await callback("token_hash=tampered&type=signup&next=%2Fapp");
    expect(rpcCalls.filter((fn) => fn === "record_email_proof_web")).toHaveLength(1);
    expect(location.pathname).toBe("/app");
  });

  it("recovery destinations are replaced by binding, keeping only a safe inner next", () => {
    expect(resolveEmailBindingDestination("/reset-password?intent=studio&next=%2Fapp", false)).toBe(
      "/account/verify-email?next=%2Fapp",
    );
    expect(resolveEmailBindingDestination("/reset-password?next=https%3A%2F%2Fevil.example", false)).toBe(
      "/account/verify-email",
    );
    expect(resolveEmailBindingDestination("/account", true)).toBe("/account/verify-email?revoke=failed");
  });
});
