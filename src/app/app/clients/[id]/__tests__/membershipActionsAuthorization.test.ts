import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: assignClientMembershipAction and
 * cancelClientMembershipAction had no permission check at all -- any
 * active studio role, including instructor, could reach them. Both are
 * the client-detail-page counterparts of memberships/actions.ts's own
 * assign/cancel flows, so they reuse the exact same existing capability
 * (no new role array): canManageMemberships.
 *
 * This file's own catch blocks are bare `catch {}` -- they swallow ANY
 * thrown error (including a redirect()'s throw) into a generic redirect,
 * the same pre-existing pattern already found in
 * marketing/campaigns/actions.ts. So this suite proves the gate via
 * supabase.from() call tracking, not exception type.
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
  chain.limit = self;
  chain.single = () => Promise.resolve({ data: null, error: new Error("not found") });
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user-1" } } }),
    },
    from(table: string) {
      if (table === "user_studio_roles") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                limit: () => ({
                  single: async () => ({
                    data: { studio_id: "studio-1", role: currentRole },
                    error: null,
                  }),
                }),
              }),
            }),
          }),
        };
      }
      fromCalls.push(table);
      return benignChain();
    },
  }),
}));

let currentRole = "instructor";

const { assignClientMembershipAction, cancelClientMembershipAction } = await import(
  "../membership-actions"
);

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

const DENIED_ROLES = ["instructor", "independent_instructor"];
const ALLOWED_ROLES = ["studio_owner", "studio_admin", "front_desk", "platform_admin"];

describe("client membership-actions authorization -- FC-1B5D correction", () => {
  describe.each(DENIED_ROLES)("denied role: %s", (role) => {
    it("assignClientMembershipAction never queries clients/membership_plans", async () => {
      currentRole = role;
      await run(
        assignClientMembershipAction(
          formDataFor({
            clientId: "client-1",
            membershipPlanId: "plan-1",
            startsOn: "2026-01-01",
          }),
        ),
      );
      expect(fromCalls).toEqual([]);
    });

    it("cancelClientMembershipAction never queries client_memberships", async () => {
      currentRole = role;
      await run(
        cancelClientMembershipAction(
          formDataFor({ clientId: "client-1", clientMembershipId: "membership-1" }),
        ),
      );
      expect(fromCalls).toEqual([]);
    });
  });

  describe.each(ALLOWED_ROLES)("allowed role: %s", (role) => {
    it("assignClientMembershipAction proceeds past the gate to a real query", async () => {
      currentRole = role;
      await run(
        assignClientMembershipAction(
          formDataFor({
            clientId: "client-1",
            membershipPlanId: "plan-1",
            startsOn: "2026-01-01",
          }),
        ),
      );
      expect(fromCalls).toContain("clients");
    });

    it("cancelClientMembershipAction proceeds past the gate to a real query", async () => {
      currentRole = role;
      await run(
        cancelClientMembershipAction(
          formDataFor({ clientId: "client-1", clientMembershipId: "membership-1" }),
        ),
      );
      expect(fromCalls).toContain("client_memberships");
    });
  });
});
