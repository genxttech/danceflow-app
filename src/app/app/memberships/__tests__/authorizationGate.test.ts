import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction (independent-review blocking finding #3):
 * assignMembershipToClientAction, startMembershipPaymentMethodSetupAction,
 * sellMembershipAction, startTerminalMembershipEnrollmentAction, and
 * collectReplacementPaymentMethodAction read client id/name/email with no
 * permission check at all (confirmed: this file imported no
 * @/lib/auth/permissions function before this correction). Mapped per
 * actual business capability -- administrative assignment/management uses
 * canManageMemberships; initiating a new sale (incl. terminal) uses
 * canSellMemberships -- both already exclude instructor/
 * independent_instructor, so no new role array was introduced. This suite
 * proves the gate fires before any client/membership query, using the
 * same throwing-fake-Supabase technique already established in this
 * codebase; this file's own catch blocks correctly re-throw via
 * isRedirectError, so exception-type detection is reliable here (unlike
 * marketing/campaigns/actions.ts).
 *
 * FC-1B5D Phase A P0 correction: cancelMembershipAtPeriodEndAction and
 * reactivateMembershipAutoRenewAction (each capable of mutating a live
 * Stripe subscription) and retryDelinquentMembershipBillingAction (which
 * triggers a real Stripe invoice payment attempt) had no permission check
 * at all. All three are administrative management of an existing
 * membership record, so all three use canManageMemberships -- the same
 * permission already used for assignMembershipToClientAction and
 * collectReplacementPaymentMethodAction above, not a new role array.
 * stripeCalls proves denial happens before any Stripe API call, not just
 * before a Supabase query.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

const stripeCalls: string[] = [];

vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({
    subscriptions: {
      update: (...args: unknown[]) => {
        stripeCalls.push("subscriptions.update");
        return Promise.resolve({ status: "active", items: { data: [] }, args });
      },
    },
    invoices: {
      list: (...args: unknown[]) => {
        stripeCalls.push("invoices.list");
        return Promise.resolve({ data: [], args });
      },
      pay: (...args: unknown[]) => {
        stripeCalls.push("invoices.pay");
        return Promise.resolve({ args });
      },
    },
  }),
}));

class UnexpectedQueryError extends Error {
  constructor(table: string) {
    super(`UNEXPECTED_QUERY:${table}`);
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const err = new UnexpectedQueryError(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      chain.select = self;
      chain.eq = self;
      chain.single = () => Promise.reject(err);
      chain.maybeSingle = () => Promise.reject(err);
      chain.then = (
        onFulfilled: (v: unknown) => unknown,
        onRejected?: (r: unknown) => unknown,
      ) => Promise.reject(err).then(onFulfilled, onRejected);
      return chain;
    },
  }),
}));

const getCurrentStudioContextMock = vi.fn();
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: (...args: unknown[]) => getCurrentStudioContextMock(...args),
}));

const {
  assignMembershipToClientAction,
  startMembershipPaymentMethodSetupAction,
  sellMembershipAction,
  startTerminalMembershipEnrollmentAction,
  collectReplacementPaymentMethodAction,
  cancelMembershipAtPeriodEndAction,
  reactivateMembershipAutoRenewAction,
  retryDelinquentMembershipBillingAction,
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

const validFormData = () =>
  formDataFor({
    clientId: "11111111-1111-1111-8111-111111111111",
    membershipPlanId: "22222222-2222-2222-8222-222222222222",
    startsOn: "2026-01-01",
  });

const validMembershipFormData = () =>
  formDataFor({
    clientId: "11111111-1111-1111-8111-111111111111",
    clientMembershipId: "33333333-3333-3333-8333-333333333333",
  });

const DENIED_ROLES = ["instructor", "independent_instructor"];
const ALLOWED_ROLES = ["studio_owner", "studio_admin", "front_desk", "platform_admin"];

function expectUnauthorizedRedirect(error: unknown) {
  expect(error).not.toBeInstanceOf(UnexpectedQueryError);
  const digest = (error as { digest?: string })?.digest ?? "";
  // Proves rejection came specifically from the new authorization gate,
  // not incidentally from unrelated form validation (e.g. a malformed
  // UUID would also redirect, but with a different error code).
  expect(digest).toContain("membership_unauthorized");
}

describe("membership action authorization -- FC-1B5D correction", () => {
  beforeEach(() => {
    stripeCalls.length = 0;
  });

  describe.each(DENIED_ROLES)("denied role: %s", (role) => {
    it("assignMembershipToClientAction (canManageMemberships) is rejected before any client query", async () => {
      mockSession(role);
      const error = await run(assignMembershipToClientAction(validFormData()));
      expectUnauthorizedRedirect(error);
    });

    it("startMembershipPaymentMethodSetupAction (canSellMemberships) is rejected before any client query", async () => {
      mockSession(role);
      const error = await run(startMembershipPaymentMethodSetupAction(validFormData()));
      expectUnauthorizedRedirect(error);
    });

    it("sellMembershipAction (canSellMemberships) is rejected before any client query", async () => {
      mockSession(role);
      const error = await run(sellMembershipAction(validFormData()));
      expectUnauthorizedRedirect(error);
    });

    it("startTerminalMembershipEnrollmentAction (canSellMemberships) is rejected before any client query", async () => {
      mockSession(role);
      const error = await run(
        startTerminalMembershipEnrollmentAction(
          formDataFor({
            clientId: "11111111-1111-1111-8111-111111111111",
            membershipPlanId: "22222222-2222-2222-8222-222222222222",
            startsOn: "2026-01-01",
            recurringConsent: "on",
          }),
        ),
      );
      expectUnauthorizedRedirect(error);
    });

    it("collectReplacementPaymentMethodAction (canManageMemberships) is rejected before any client query", async () => {
      mockSession(role);
      const error = await run(
        collectReplacementPaymentMethodAction(
          formDataFor({ clientId: "11111111-1111-1111-8111-111111111111" }),
        ),
      );
      expectUnauthorizedRedirect(error);
    });

    it("cancelMembershipAtPeriodEndAction (canManageMemberships) is rejected before any membership query or Stripe call", async () => {
      mockSession(role);
      const error = await run(
        cancelMembershipAtPeriodEndAction(validMembershipFormData()),
      );
      expectUnauthorizedRedirect(error);
      expect(stripeCalls).toEqual([]);
    });

    it("reactivateMembershipAutoRenewAction (canManageMemberships) is rejected before any membership query or Stripe call", async () => {
      mockSession(role);
      const error = await run(
        reactivateMembershipAutoRenewAction(validMembershipFormData()),
      );
      expectUnauthorizedRedirect(error);
      expect(stripeCalls).toEqual([]);
    });

    it("retryDelinquentMembershipBillingAction (canManageMemberships) is rejected before any membership query or Stripe call", async () => {
      mockSession(role);
      const error = await run(
        retryDelinquentMembershipBillingAction(validMembershipFormData()),
      );
      expectUnauthorizedRedirect(error);
      expect(stripeCalls).toEqual([]);
    });
  });

  // This file's own catch blocks re-throw redirect errors intact
  // (isRedirectError check) but swallow OTHER thrown errors -- like the
  // probe's UnexpectedQueryError -- into a generic redirect. So an
  // authorized call is proven by the ABSENCE of the specific
  // "membership_unauthorized" code (which only the new gate emits), not by
  // the raw exception type surviving.
  describe.each(ALLOWED_ROLES)("allowed role: %s", (role) => {
    it("assignMembershipToClientAction is not blocked by the authorization gate", async () => {
      mockSession(role);
      const error = await run(assignMembershipToClientAction(validFormData()));
      const digest = (error as { digest?: string })?.digest ?? "";
      expect(digest).not.toContain("membership_unauthorized");
    });

    it("sellMembershipAction is not blocked by the authorization gate", async () => {
      mockSession(role);
      const error = await run(sellMembershipAction(validFormData()));
      const digest = (error as { digest?: string })?.digest ?? "";
      expect(digest).not.toContain("membership_unauthorized");
    });

    it("cancelMembershipAtPeriodEndAction is not blocked by the authorization gate", async () => {
      mockSession(role);
      const error = await run(
        cancelMembershipAtPeriodEndAction(validMembershipFormData()),
      );
      const digest = (error as { digest?: string })?.digest ?? "";
      expect(digest).not.toContain("membership_unauthorized");
    });

    it("reactivateMembershipAutoRenewAction is not blocked by the authorization gate", async () => {
      mockSession(role);
      const error = await run(
        reactivateMembershipAutoRenewAction(validMembershipFormData()),
      );
      const digest = (error as { digest?: string })?.digest ?? "";
      expect(digest).not.toContain("membership_unauthorized");
    });

    it("retryDelinquentMembershipBillingAction is not blocked by the authorization gate", async () => {
      mockSession(role);
      const error = await run(
        retryDelinquentMembershipBillingAction(validMembershipFormData()),
      );
      const digest = (error as { digest?: string })?.digest ?? "";
      expect(digest).not.toContain("membership_unauthorized");
    });
  });
});
