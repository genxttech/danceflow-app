import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7 follow-up: markEventRegistrationPaidAction used to wrap its intentional redirects in a bare catch, so EVERY outcome
 * (success included) was reported as error=mark_paid_failed. Now: success shows success, the intentional refusals show
 * their own messages, and only a genuine failure shows mark_paid_failed -- a failure never shows success.
 */

const STUDIO = "studio-1";
const EVENT = "event-1";
const REGISTRATION = "reg-1";
let role = "studio_owner";

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
  getCurrentStudioContext: async () => ({ studioId: STUDIO, studioRole: role, isPlatformAdmin: false }),
}));

const { markEventRegistrationPaidAction } = await import("@/app/app/events/[id]/registrations/actions");

function seed(overrides: { registration?: Row; omitRegistration?: boolean } = {}) {
  state.user = createTerminalFakeDb({
    events: [{ id: EVENT, event_type: "social", studio_id: STUDIO, organizer_id: null, studios: { stripe_connected_account_id: null } }],
    event_registrations: overrides.omitRegistration
      ? []
      : [
          {
            id: REGISTRATION, event_id: EVENT, studio_id: STUDIO, client_id: null, ticket_type_id: "t-1", quantity: 1,
            attendee_first_name: "Ada", attendee_last_name: "Lovelace", attendee_email: "ada@example.test", attendee_phone: null,
            status: "pending", payment_status: "pending", total_amount: 40, total_price: 40, currency: "USD", checked_in_at: null,
            stripe_payment_intent_id: null, order_id: null, ...(overrides.registration ?? {}),
          },
        ],
    event_payments: [],
  });
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: [],
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

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

beforeEach(() => {
  role = "studio_owner";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("markEventRegistrationPaidAction redirects", () => {
  it("a successful mark-paid shows success (and never the failure banner), with the writes persisted", async () => {
    seed();
    const url = await markPaid();
    expect(url).toContain("success=registration_paid");
    expect(url).not.toContain("mark_paid_failed");
    expect(state.user.tables.event_registrations[0]).toMatchObject({ status: "confirmed", payment_status: "paid" });
    expect(state.user.tables.event_payments).toHaveLength(1);
  });

  it("a registration that does not exist shows registration_not_found, with no writes", async () => {
    seed({ omitRegistration: true });
    expect(await markPaid()).toContain("error=registration_not_found");
    expect(state.user.inserts).toHaveLength(0);
  });

  it("an order-backed registration shows its own lock message, with no writes", async () => {
    seed({ registration: { order_id: "order-1" } });
    expect(await markPaid()).toContain("error=order_backed_registration_payment_locked");
    expect(state.user.tables.event_registrations[0]).toMatchObject({ status: "pending", payment_status: "pending" });
    expect(state.user.inserts).toHaveLength(0);
  });

  it("a role without registration-manage permission is redirected by the access check, not reported as a payment failure", async () => {
    seed();
    role = "instructor";
    const url = await markPaid();
    expect(url).not.toContain("success=registration_paid");
    expect(url).not.toContain("mark_paid_failed");
    expect(state.user.tables.event_registrations[0]).toMatchObject({ payment_status: "pending" });
    expect(state.user.inserts).toHaveLength(0);
  });

  it("a real failure (payment record cannot be written) shows mark_paid_failed and NEVER success", async () => {
    seed();
    const original = state.user.client.from;
    state.user.client.from = ((table: string) => {
      if (table === "event_payments") throw new Error("database unavailable");
      return original(table);
    }) as typeof original;
    const url = await markPaid();
    expect(url).toContain("error=mark_paid_failed");
    expect(url).not.toContain("success=");
  });

  it("a failure while updating the registration shows mark_paid_failed and NEVER success", async () => {
    seed();
    const original = state.user.client.from;
    state.user.client.from = ((table: string) => {
      const builder = original(table) as Record<string, unknown>;
      if (table === "event_registrations") {
        const update = () => {
          throw new Error("database unavailable");
        };
        return { ...builder, update };
      }
      return builder;
    }) as typeof original;
    const url = await markPaid();
    expect(url).toContain("error=mark_paid_failed");
    expect(url).not.toContain("success=");
    expect(state.user.inserts).toHaveLength(0);
  });
});
