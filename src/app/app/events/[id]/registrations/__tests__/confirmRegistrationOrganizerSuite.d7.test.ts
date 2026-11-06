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
  role: "studio_owner",
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
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: state.role, isPlatformAdmin: false }),
}));

const { confirmEventRegistrationAction } = await import("@/app/app/events/[id]/registrations/actions");

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


async function confirm() {
  const formData = new FormData();
  formData.set("eventId", EVENT);
  formData.set("registrationId", REGISTRATION);
  try {
    await confirmEventRegistrationAction(formData);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? `THROWN:${(error as Error).message}`;
  }
  return "NO_REDIRECT";
}

const registration = () => state.user.tables.event_registrations[0];

beforeEach(() => {
  state.role = "studio_owner";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

/**
 * D7 pre-expiry: staff "confirm registration" confirms a pending registration WITHOUT payment, so for an organizer event it is
 * a new sale and needs a current Organizer Suite entitlement (like mark-paid). It also gained the registration-manage role
 * check it never had, and no longer reports a successful confirm as a failure.
 */
describe("confirmEventRegistrationAction", () => {
  it.each([
    { name: "no entitlement", entitlements: [] as Row[] },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })] },
  ])("refuses to confirm a pending, unpaid organizer registration with $name, before any write", async ({ entitlements }) => {
    seed({ organizerId: "org-1", entitlements });
    expect(await confirm()).toContain("error=registration_confirm_organizer_suite_required");
    expect(registration()).toMatchObject({ status: "pending", payment_status: "pending" });
  });

  it("confirms with a current grant and reports success (the redirect is not swallowed)", async () => {
    seed({ organizerId: "org-1", entitlements: [grant()] });
    expect(await confirm()).toContain("success=registration_confirmed");
    expect(registration()).toMatchObject({ status: "confirmed" });
  });

  it("DanceAbel boundary: allowed at 03:59:59Z, refused at 04:00:00Z on 2027-07-09", async () => {
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expect(await confirm()).toContain("success=registration_confirmed");
    seed({ organizerId: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect(await confirm()).toContain("error=registration_confirm_organizer_suite_required");
    expect(registration()).toMatchObject({ status: "pending" });
  });

  it("a registration whose payment already settled (paid, still pending) is confirmed even after expiry: completed payments stay valid", async () => {
    seed({ organizerId: "org-1", entitlements: [], paymentStatus: "paid" });
    expect(await confirm()).toContain("success=registration_confirmed");
    expect(registration()).toMatchObject({ status: "confirmed" });
  });

  it("an already confirmed registration is not a new sale and is not gated", async () => {
    seed({ organizerId: "org-1", entitlements: [], registrationStatus: "confirmed" });
    expect(await confirm()).toContain("success=registration_confirmed");
  });

  it("an ordinary studio event (no organizer) is unaffected with no entitlement", async () => {
    seed({ organizerId: null, entitlements: [] });
    expect(await confirm()).toContain("success=registration_confirmed");
    expect(registration()).toMatchObject({ status: "confirmed" });
  });

  it("a studio member without registration-manage permission is redirected before any read or write", async () => {
    seed({ organizerId: null, entitlements: [] });
    state.role = "instructor";
    const result = await confirm();
    expect(result).not.toContain("success=registration_confirmed");
    expect(registration()).toMatchObject({ status: "pending" });
  });

  it("an unknown registration is reported as not found, not as a failure", async () => {
    seed({ organizerId: null, entitlements: [] });
    state.user.tables.event_registrations.length = 0;
    expect(await confirm()).toContain("error=registration_not_found");
  });

  it("the refusal is decided from the studio's own entitlement: another studio's grant does not help", async () => {
    seed({ organizerId: "org-1", entitlements: [] });
    state.admin.tables.usage_addon_entitlements.push({ studio_id: "another-studio", feature_key: "organizer_suite", source: "manual_grant", status: "active", period_start: null, period_end: null });
    expect(await confirm()).toContain("error=registration_confirm_organizer_suite_required");
  });
});
