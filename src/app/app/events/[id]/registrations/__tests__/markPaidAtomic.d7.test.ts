import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7 owner decision (P2-3, reviewer finding): staff "mark registration paid" completes an in-person sale, so for an
 * organizer event it needs a current Organizer Suite entitlement once the sale is unpaid. It is refused before any
 * write. Already-paid registrations, ordinary studio events and order-backed registrations keep their existing behavior.
 */

const STUDIO = "studio-1";
const EVENT = "event-1";
const REGISTRATION = "reg-1";

const state = vi.hoisted(() => ({
  user: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
  admin: null as unknown as ReturnType<typeof import("@/lib/events/__tests__/terminalFake").createTerminalFakeDb>,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => state.user.client.from(table),
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.admin.client }));
vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: "studio_owner", isPlatformAdmin: false }),
}));

const { markEventRegistrationPaidAction } = await import("@/app/app/events/[id]/registrations/actions");

type Setup = { organizerId?: string | null; entitlements?: Row[]; paymentStatus?: string; orderId?: string | null; registrationStatus?: string };

function seed(setup: Setup = {}) {
  state.user = createTerminalFakeDb({
    events: [{ id: EVENT, event_type: "social", studio_id: STUDIO, organizer_id: setup.organizerId ?? null, studios: { stripe_connected_account_id: null } }],
    event_registrations: [
      {
        id: REGISTRATION,
        event_id: EVENT,
        studio_id: STUDIO,
        client_id: null,
        ticket_type_id: "t-1",
        quantity: 1,
        attendee_first_name: "Ada",
        attendee_last_name: "Lovelace",
        attendee_email: "ada@example.test",
        attendee_phone: null,
        status: setup.registrationStatus ?? "pending",
        payment_status: setup.paymentStatus ?? "pending",
        total_amount: 40,
        total_price: 40,
        currency: "USD",
        checked_in_at: null,
        stripe_payment_intent_id: null,
        order_id: setup.orderId ?? null,
      },
    ],
    event_payments: [],
  });
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function markPaid() {
  const formData = new FormData();
  formData.set("eventId", EVENT);
  formData.set("registrationId", REGISTRATION);
  try {
    await markEventRegistrationPaidAction(formData);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? `THROWN:${(error as Error).message}`;
  }
  return "NO_REDIRECT";
}

const registration = () => state.user.tables.event_registrations[0];
const paymentRows = () => state.user.inserts.filter((insert) => insert.table === "event_payments");

/**
 * D7 release hardening (payment integrity): mark-paid claims the unpaid -> paid transition atomically, so a double submit or
 * two staff clicking together records exactly one payment; a cancelled or refunded registration is never re-marked paid;
 * and a failed payment insert never leaves a paid registration without its payment row.
 */
describe("markEventRegistrationPaidAction: atomic and status-guarded", () => {
  it("a double submit (two concurrent requests) records exactly one payment row", async () => {
    seed({});
    const [first, second] = await Promise.all([markPaid(), markPaid()]);
    expect(first).toContain("success=registration_paid");
    expect(second).toContain("success=registration_paid");
    expect(paymentRows()).toHaveLength(1);
    expect(paymentRows()[0].values).toMatchObject({ amount: 40, source: "manual_admin_mark_paid", status: "paid" });
    expect(registration()).toMatchObject({ status: "confirmed", payment_status: "paid" });
  });

  it("many concurrent submits still record exactly one payment", async () => {
    seed({});
    const results = await Promise.all(Array.from({ length: 6 }, () => markPaid()));
    expect(results.every((r) => r.includes("success=registration_paid"))).toBe(true);
    expect(paymentRows()).toHaveLength(1);
  });

  it("re-marking an already paid registration is a no-op: no second payment row", async () => {
    seed({ paymentStatus: "paid" });
    expect(await markPaid()).toContain("success=registration_paid");
    expect(paymentRows()).toHaveLength(0);
  });

  it("marking twice in sequence records one payment", async () => {
    seed({});
    await markPaid();
    await markPaid();
    expect(paymentRows()).toHaveLength(1);
  });

  it.each([
    ["a refunded payment", { paymentStatus: "refunded" }],
    ["a cancelled registration", { registrationStatus: "cancelled" }],
    ["a refunded registration", { registrationStatus: "refunded" }],
  ])("refuses %s before any write", async (_name, setup) => {
    seed(setup);
    const before = { ...registration() };
    expect(await markPaid()).toContain("error=registration_not_markable");
    expect(registration()).toEqual(before);
    expect(paymentRows()).toHaveLength(0);
  });

  it.each(["unpaid", "pending", "failed", "waived", "partial"])("a %s registration can still be marked paid", async (paymentStatus) => {
    seed({ paymentStatus });
    expect(await markPaid()).toContain("success=registration_paid");
    expect(registration()).toMatchObject({ payment_status: "paid" });
    expect(paymentRows()).toHaveLength(1);
  });

  it("a null payment_status counts as unpaid", async () => {
    seed({});
    state.user.tables.event_registrations[0].payment_status = null;
    expect(await markPaid()).toContain("success=registration_paid");
    expect(paymentRows()).toHaveLength(1);
  });

  it("if recording the payment fails, the claim is rolled back and the failure is reported", async () => {
    seed({});
    const realFrom = state.user.client.from;
    state.user.client.from = ((table: string) =>
      table === "event_payments"
        ? { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: "boom" } }) }) }) }
        : realFrom(table)) as typeof state.user.client.from;
    expect(await markPaid()).toContain("error=mark_paid_failed");
    expect(registration()).toMatchObject({ status: "pending", payment_status: "pending" });
  });

  it("the Organizer Suite gate still runs before the claim", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    expect(await markPaid()).toContain("error=organizer_suite_required");
    expect(registration()).toMatchObject({ status: "pending", payment_status: "pending" });
    expect(paymentRows()).toHaveLength(0);
  });
});
