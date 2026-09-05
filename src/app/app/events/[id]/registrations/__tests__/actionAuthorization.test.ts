import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * FC-1B5D Phase A correction: resendEventTicketConfirmationAction,
 * updateEventRegistrationAttendeeAction, and upsertEventAttendanceAction
 * had no permission check of their own -- the page-level gate
 * (registrationAuthorization.test.ts) does not stop a direct call to
 * these actions. Proves the server-action-level gate agrees with the
 * page gate. This file's own catch blocks swallow any thrown error
 * (including a redirect()'s throw) into a generic redirect without
 * checking isRedirectError -- the same pre-existing pattern already
 * found elsewhere in this engagement -- so this suite uses
 * supabase.from() call tracking rather than exception type.
 *
 * FC-1B5D Phase A P0 correction: refundEventRegistrationAction (a real
 * Stripe refund) and markEventRegistrationPaidAction (a payment-ledger
 * mutation) had no permission check at all. Proves both now require
 * canManageEventRegistrations before any registration lookup, Stripe
 * call, or payment-ledger mutation -- denial is proven by asserting
 * neither supabase.from() nor stripe.refunds.create() was ever reached.
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
    refunds: {
      create: (...args: unknown[]) => {
        stripeCalls.push("refunds.create");
        return Promise.resolve({ id: "re_test", args });
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

const fromCalls: string[] = [];

function benignChain() {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = self;
  chain.eq = self;
  chain.in = self;
  chain.order = self;
  chain.limit = self;
  chain.update = self;
  chain.insert = () => Promise.resolve({ data: null, error: null });
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
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      fromCalls.push(table);
      return benignChain();
    },
  }),
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
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

const {
  resendEventTicketConfirmationAction,
  updateEventRegistrationAttendeeAction,
  upsertEventAttendanceAction,
  refundEventRegistrationAction,
  markEventRegistrationPaidAction,
} = await import("../actions");

function mockSession(studioRole: string) {
  getCurrentStudioContextMock.mockResolvedValue({
    studioId: "studio-1",
    studioRole,
    isPlatformAdmin: false,
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
  stripeCalls.length = 0;
});

describe("event registration action authorization -- FC-1B5D correction", () => {
  it("instructor cannot invoke resendEventTicketConfirmationAction directly (bypassing the page gate)", async () => {
    mockSession("instructor");
    await run(
      resendEventTicketConfirmationAction(
        formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
      ),
    );
    expect(fromCalls).toEqual([]);
  });

  it("instructor cannot invoke updateEventRegistrationAttendeeAction directly", async () => {
    mockSession("instructor");
    await run(
      updateEventRegistrationAttendeeAction(
        formDataFor({
          eventId: "event-1",
          registrationId: "reg-1",
          attendeeId: "att-1",
          firstName: "Jane",
          lastName: "Doe",
        }),
      ),
    );
    expect(fromCalls).toEqual([]);
  });

  it("instructor cannot invoke upsertEventAttendanceAction directly", async () => {
    mockSession("instructor");
    await run(
      upsertEventAttendanceAction(
        formDataFor({ eventId: "event-1", registrationId: "reg-1", status: "attended" }),
      ),
    );
    expect(fromCalls).toEqual([]);
  });

  it.each(["studio_owner", "studio_admin", "organizer_owner"])(
    "%s reaches the real query for upsertEventAttendanceAction",
    async (role) => {
      mockSession(role);
      await run(
        upsertEventAttendanceAction(
          formDataFor({ eventId: "event-1", registrationId: "reg-1", status: "attended" }),
        ),
      );
      expect(fromCalls.length).toBeGreaterThan(0);
    },
  );

  it("instructor cannot invoke refundEventRegistrationAction directly -- denied before any query or Stripe call", async () => {
    mockSession("instructor");
    await run(
      refundEventRegistrationAction(
        formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
      ),
    );
    expect(fromCalls).toEqual([]);
    expect(stripeCalls).toEqual([]);
  });

  it("instructor cannot invoke markEventRegistrationPaidAction directly -- denied before any query or payment mutation", async () => {
    mockSession("instructor");
    await run(
      markEventRegistrationPaidAction(
        formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
      ),
    );
    expect(fromCalls).toEqual([]);
    expect(stripeCalls).toEqual([]);
  });

  it.each(["studio_owner", "studio_admin", "organizer_owner"])(
    "%s reaches the real query for refundEventRegistrationAction",
    async (role) => {
      mockSession(role);
      await run(
        refundEventRegistrationAction(
          formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
        ),
      );
      expect(fromCalls.length).toBeGreaterThan(0);
    },
  );

  it.each(["studio_owner", "studio_admin", "organizer_owner"])(
    "%s reaches the real query for markEventRegistrationPaidAction",
    async (role) => {
      mockSession(role);
      await run(
        markEventRegistrationPaidAction(
          formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
        ),
      );
      expect(fromCalls.length).toBeGreaterThan(0);
    },
  );

  it("front_desk cannot invoke refundEventRegistrationAction directly -- canManageEventRegistrations does not include it", async () => {
    mockSession("front_desk");
    await run(
      refundEventRegistrationAction(
        formDataFor({ eventId: "event-1", registrationId: "reg-1" }),
      ),
    );
    expect(fromCalls).toEqual([]);
    expect(stripeCalls).toEqual([]);
  });
});
