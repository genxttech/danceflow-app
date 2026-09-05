import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction (independent-review blocking finding #1):
 * createMarketingCampaignDraftAction, sendMarketingCampaignTestEmailAction,
 * generateMarketingCampaignRecipientsAction, and sendMarketingCampaignAction
 * read client names/emails (directly or via the marketing_campaign_recipients
 * rows they generate/send) but had no permission check of their own -- the
 * page-level canViewCommunications gate on marketing/campaigns/page.tsx did
 * not stop a direct call to the action itself. This suite proves the
 * server-action-level gate now agrees with the page gate.
 *
 * This file's own pre-existing top-level try/catch blocks swallow ANY
 * thrown error (including a redirect()'s throw) into a generic
 * campaign_error redirect -- they don't special-case isRedirectError. That
 * pre-existing behavior means a thrown-exception-type probe can't
 * distinguish "blocked by the new authorization gate" from "reached the
 * query but failed for an unrelated fixture reason" -- both surface as a
 * generic redirect. So this suite instead spies on supabase.from() call
 * counts: unauthorized roles must produce ZERO from("clients") /
 * from("marketing_campaigns") calls (the gate fires before any query);
 * authorized roles must produce at least one (the gate did not block
 * them; they proceeded to the real query, which then fails for the
 * unrelated fixture reason of a missing campaign row).
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.insert = () => Promise.resolve({ data: null, error: null });
  chain.update = self;
  chain.delete = self;
  chain.limit = self;
  chain.single = () => Promise.resolve({ data: null, error: new Error("not found") });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (
    onFulfilled: (v: unknown) => unknown,
    onRejected?: (r: unknown) => unknown,
  ) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected);
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1", email: "user@example.test" } } }),
    },
    from(table: string) {
      fromCalls.push(table);
      return benignChain();
    },
  }),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

vi.mock("@/lib/billing/access", () => ({
  requireStudioFeature: vi.fn().mockResolvedValue(undefined),
}));

const {
  createMarketingCampaignDraftAction,
  sendMarketingCampaignTestEmailAction,
  generateMarketingCampaignRecipientsAction,
  sendMarketingCampaignAction,
} = await import("../actions");

function mockSession(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
    userId: "user-1",
    email: "user@example.test",
  });
}

function formDataFor(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function run(promise: Promise<unknown>) {
  return promise.catch((e) => e);
}

beforeEach(() => {
  fromCalls.length = 0;
});

const UNAUTHORIZED_ROLES = ["instructor", "independent_instructor", "unknown_role"];
const AUTHORIZED_ROLES = ["studio_owner", "studio_admin", "front_desk", "platform_admin"];

describe("marketing campaign action authorization -- FC-1B5D correction", () => {
  describe.each(UNAUTHORIZED_ROLES)("unauthorized role: %s", (role) => {
    it("createMarketingCampaignDraftAction never queries/mutates", async () => {
      mockSession(role);
      await run(
        createMarketingCampaignDraftAction(
          formDataFor({ name: "Test", subject: "Hi", bodyText: "Body" }),
        ),
      );
      expect(fromCalls).toEqual([]);
    });

    it("sendMarketingCampaignTestEmailAction never queries/sends", async () => {
      mockSession(role);
      await run(sendMarketingCampaignTestEmailAction(formDataFor({ campaignId: "camp-1" })));
      expect(fromCalls).toEqual([]);
    });

    it("generateMarketingCampaignRecipientsAction never queries clients/campaigns", async () => {
      mockSession(role);
      await run(
        generateMarketingCampaignRecipientsAction(formDataFor({ campaignId: "camp-1" })),
      );
      expect(fromCalls).toEqual([]);
    });

    it("sendMarketingCampaignAction never queries/sends", async () => {
      mockSession(role);
      await run(
        sendMarketingCampaignAction(formDataFor({ campaignId: "camp-1", confirmSend: "yes" })),
      );
      expect(fromCalls).toEqual([]);
    });
  });

  describe.each(AUTHORIZED_ROLES)("authorized role: %s", (role) => {
    it("generateMarketingCampaignRecipientsAction proceeds past the gate to a real query", async () => {
      mockSession(role);
      await run(
        generateMarketingCampaignRecipientsAction(formDataFor({ campaignId: "camp-1" })),
      );
      // The gate did not block them -- they reached the real
      // marketing_campaigns lookup (which then fails for the unrelated
      // fixture reason of no matching row, redirecting with a different
      // error code than an authorization failure would).
      expect(fromCalls).toContain("marketing_campaigns");
    });
  });
});
