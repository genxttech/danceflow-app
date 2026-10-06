import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * GC-3.4B-0: studio invitation actions and page.
 *  S3 -- the actions pass the session's canonical verified email
 *        (my_verified_email), never user.email.
 *  S5 -- a successful accept reaches its destination (redirect() is no longer
 *        swallowed by a catch, so no `error=NEXT_REDIRECT`).
 *  S6 -- a handled invitation renders only a generic state; a mismatched or
 *        unverified signed-in account sees no client, email or relationship
 *        detail.
 */

const h = vi.hoisted(() => ({
  user: null as null | { id: string; email: string },
  verifiedEmail: null as string | null,
  rpcCalls: [] as string[],
  invitation: null as Record<string, unknown> | null,
  accept: vi.fn(),
  reject: vi.fn(),
}));

class RedirectSignal extends Error {
  constructor(public url: string) {
    // Mirrors Next.js: redirect() throws an error whose message is NEXT_REDIRECT.
    super("NEXT_REDIRECT");
  }
}

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
    rpc: async (fn: string) => {
      h.rpcCalls.push(fn);
      if (fn === "my_verified_email") return { data: h.verifiedEmail, error: null };
      return { data: null, error: { message: "unexpected rpc" } };
    },
  }),
}));

vi.mock("@/lib/student-identity/lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/student-identity/lifecycle")>();
  return {
    clientInvitationIdentity: actual.clientInvitationIdentity,
    getClientInvitationByToken: async () => h.invitation,
    acceptClientInvitation: (...args: unknown[]) => h.accept(...args),
    rejectClientInvitation: (...args: unknown[]) => h.reject(...args),
  };
});

const { acceptStudioInviteAction, rejectStudioInviteAction } = await import("../actions");
const StudioInvitePage = (await import("../page")).default;

const TOKEN = "tok_123";

function form(token = TOKEN) {
  const data = new FormData();
  data.set("token", token);
  return data;
}

async function redirectOf(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof RedirectSignal) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

function invitation(overrides: Record<string, unknown> = {}) {
  return {
    id: "invite-1",
    studioId: "studio-a",
    clientId: "client-a",
    status: "invited",
    invitedEmail: "parent@example.com",
    inviteExpiresAt: "2099-01-01T00:00:00Z",
    studioName: "Studio A",
    studioSlug: "studio-a",
    clientFirstName: "Kiddo",
    clientLastName: "Secretname",
    conflictDetails: "Client record was already connected to a different DanceFlow account.",
    relationshipType: "guardian",
    ...overrides,
  };
}

async function renderPage(error?: string) {
  const node = await StudioInvitePage({
    params: Promise.resolve({ token: TOKEN }),
    searchParams: Promise.resolve(error ? { error } : {}),
  });
  return renderToStaticMarkup(node);
}

const PRIVATE = /Kiddo|Secretname|parent@example\.com|guardian|already connected to a different/i;

beforeEach(() => {
  h.user = { id: "user-1", email: "parent@example.com" };
  h.verifiedEmail = "parent@example.com";
  h.rpcCalls.length = 0;
  h.invitation = invitation();
  h.accept.mockReset();
  h.reject.mockReset();
});

describe("acceptStudioInviteAction", () => {
  it("passes the verified email, never user.email, and lands on the portal (no NEXT_REDIRECT)", async () => {
    h.accept.mockResolvedValue(invitation());

    const url = await redirectOf(() => acceptStudioInviteAction(form()));

    expect(url).toBe("/portal/studio-a?invite=accepted");
    expect(url).not.toContain("NEXT_REDIRECT");
    expect(h.accept).toHaveBeenCalledWith({ token: TOKEN, userId: "user-1", verifiedEmail: "parent@example.com" });
    expect(h.rpcCalls).toContain("my_verified_email");
  });

  it("an unverified session passes verifiedEmail null even when user.email matches", async () => {
    h.verifiedEmail = null;
    h.accept.mockRejectedValue(new Error("invite_verification_required"));

    const url = await redirectOf(() => acceptStudioInviteAction(form()));

    expect(h.accept).toHaveBeenCalledWith({ token: TOKEN, userId: "user-1", verifiedEmail: null });
    expect(url).toBe(`/studio-invites/${TOKEN}?error=invite_verification_required`);
  });

  it("falls back to /account when the studio has no slug", async () => {
    h.accept.mockResolvedValue(invitation({ studioSlug: null }));
    expect(await redirectOf(() => acceptStudioInviteAction(form()))).toBe("/account?success=studio_invite_accepted");
  });

  it("maps known lifecycle failures to their code", async () => {
    h.accept.mockRejectedValue(new Error("invite_email_mismatch"));
    expect(await redirectOf(() => acceptStudioInviteAction(form()))).toBe(
      `/studio-invites/${TOKEN}?error=invite_email_mismatch`,
    );
  });

  it("never puts raw error text in the URL", async () => {
    h.accept.mockRejectedValue(new Error('Account relationship save failed: duplicate key value violates unique constraint "x"'));
    expect(await redirectOf(() => acceptStudioInviteAction(form()))).toBe(
      `/studio-invites/${TOKEN}?error=invite_failed`,
    );
  });

  it("a signed-out caller is sent to sign in and nothing is attempted", async () => {
    h.user = null;
    const url = await redirectOf(() => acceptStudioInviteAction(form()));
    expect(url).toBe(`/login?intent=public&next=${encodeURIComponent(`/studio-invites/${TOKEN}`)}`);
    expect(h.accept).not.toHaveBeenCalled();
  });
});

describe("rejectStudioInviteAction", () => {
  it("passes the verified email and redirects once", async () => {
    h.reject.mockResolvedValue(invitation());
    expect(await redirectOf(() => rejectStudioInviteAction(form()))).toBe("/account?success=studio_invite_rejected");
    expect(h.reject).toHaveBeenCalledWith({ token: TOKEN, userId: "user-1", verifiedEmail: "parent@example.com" });
  });

  it("a mismatch returns to the invite page with a code", async () => {
    h.reject.mockRejectedValue(new Error("invite_email_mismatch"));
    expect(await redirectOf(() => rejectStudioInviteAction(form()))).toBe(
      `/studio-invites/${TOKEN}?error=invite_email_mismatch`,
    );
  });
});

describe("StudioInvitePage render privacy", () => {
  it.each(["linked", "rejected", "conflict", "disconnected", "former_client"])(
    "a %s invitation renders only a generic handled state (any viewer)",
    async (status) => {
      h.invitation = invitation({ status });
      for (const user of [null, { id: "user-1", email: "parent@example.com" }, { id: "x", email: "intruder@example.com" }]) {
        h.user = user;
        const out = await renderPage();
        expect(out).toContain("Invitation already handled");
        expect(out).not.toMatch(PRIVATE);
        expect(out).not.toContain("Studio A");
        expect(out).not.toMatch(/<form/);
      }
    },
  );

  it("a signed-in account with a different verified email sees no invitation detail", async () => {
    h.user = { id: "x", email: "intruder@example.com" };
    h.verifiedEmail = "intruder@example.com";
    const out = await renderPage();
    expect(out).toContain("This invitation is for a different account");
    expect(out).not.toMatch(PRIVATE);
    expect(out).not.toContain("Studio A");
    expect(out).not.toContain("Accept Studio Connection");
  });

  it("an unverified account whose user.email matches sees no detail and is sent to confirm its email", async () => {
    h.verifiedEmail = null;
    const out = await renderPage();
    expect(out).toContain("Confirm your email to continue");
    expect(out).toContain(`/account/verify-email?next=${encodeURIComponent(`/studio-invites/${TOKEN}`)}`);
    expect(out).not.toMatch(PRIVATE);
    expect(out).not.toContain("Accept Studio Connection");
  });

  it("a mismatched account on an expired invitation also sees nothing", async () => {
    h.invitation = invitation({ inviteExpiresAt: "2020-01-01T00:00:00Z" });
    h.verifiedEmail = "intruder@example.com";
    const out = await renderPage();
    expect(out).not.toMatch(PRIVATE);
  });

  it("the verified invitee sees the invitation and the accept/reject actions", async () => {
    const out = await renderPage();
    expect(out).toContain("Kiddo Secretname");
    expect(out).toContain("parent@example.com");
    expect(out).toContain("Accept Studio Connection");
    expect(out).toContain("Reject Invitation");
  });

  it("a signed-out mailbox recipient keeps the existing invitation view with a sign-in link", async () => {
    h.user = null;
    const out = await renderPage();
    expect(out).toContain("Studio A invited you");
    expect(out).toContain("Sign In to Continue");
    expect(out).not.toContain("Accept Studio Connection");
    expect(h.rpcCalls).not.toContain("my_verified_email");
  });

  it("an unknown error code renders generic copy, never the raw value", async () => {
    const out = await renderPage("NEXT_REDIRECT<script>");
    expect(out).toContain("This invitation could not be completed.");
    expect(out).not.toContain("NEXT_REDIRECT");
  });
});
