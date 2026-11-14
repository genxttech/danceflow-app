import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import { createEntitlementFakeDb, type Row } from "@/lib/billing/__tests__/entitlementFakeDb";

/**
 * D7: guest-coach private-lesson checkout vs the Organizer Suite entitlement.
 *
 * Product rule: a slot that belongs to an Organizer Suite event (the event or the slot is tied to an organizer) needs a
 * CURRENT Organizer Suite entitlement for a NEW purchase, like the cart and student checkouts (a fee of 0 means "Suite
 * required"). Events with no organizer are ordinary studio listings and are unaffected. Nothing here touches bookings
 * that are already paid or in flight.
 */

const STUDIO = "studio-1";
const SLOT = "slot-1";
const AMOUNT = 100;

let db: ReturnType<typeof createEntitlementFakeDb>;
let stripeCreate: Mock<(...args: unknown[]) => unknown>;
let ipCounter = 0;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => db.client,
}));
vi.mock("@/lib/payments/stripe", () => ({
  getStripe: () => ({ checkout: { sessions: { create: (...args: unknown[]) => stripeCreate(...args) } } }),
}));

const { POST } = await import("@/app/api/events/private-lessons/checkout/route");

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://fake.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "fake-service-role-key";

type Setup = {
  eventOrganizerId?: string | null;
  slotOrganizerId?: string | null;
  planCode?: string;
  entitlements?: Row[];
  timezone?: string;
};

function seed(setup: Setup = {}) {
  const slot: Row = {
    id: SLOT,
    event_id: "event-1",
    coach_id: "coach-1",
    studio_id: STUDIO,
    organizer_id: setup.slotOrganizerId ?? null,
    starts_at: "2027-03-01T15:00:00Z",
    ends_at: "2027-03-01T16:00:00Z",
    price: AMOUNT,
    location_label: "Studio A",
    status: "available",
    payment_status: "unpaid",
    events: {
      id: "event-1",
      name: "Winter Weekend",
      slug: "winter-weekend",
      status: "published",
      visibility: "public",
      public_directory_enabled: true,
      studio_id: STUDIO,
      organizer_id: setup.eventOrganizerId ?? null,
      studios: {
        id: STUDIO,
        name: "Test Studio",
        subscription_status: "active",
        stripe_connected_account_id: "acct_test",
        stripe_connect_charges_enabled: true,
        stripe_connect_payouts_enabled: true,
        stripe_connect_onboarding_complete: true,
      },
    },
    event_guest_coaches: { id: "coach-1", name: "Guest Coach" },
  };
  db = createEntitlementFakeDb({
    event_private_lesson_slots: [slot],
    studio_subscriptions: [
      { id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: setup.planCode ?? "pro", name: "Plan" } },
    ],
    studios: [{ id: STUDIO, timezone: setup.timezone ?? "America/New_York" }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
  });
}

function grant(overrides: Row = {}): Row {
  return {
    id: "grant-1",
    source: "manual_grant",
    status: "active",
    period_start: null,
    period_end: null,
    ...overrides,
  };
}

function stripeItem(overrides: Row = {}): Row {
  return {
    id: "item-1",
    source: "stripe_subscription_item",
    status: "active",
    period_start: null,
    period_end: null,
    stripe_subscription_item_id: "si_1",
    ...overrides,
  };
}

function request() {
  ipCounter += 1;
  const form = new FormData();
  form.set("slotId", SLOT);
  form.set("eventSlug", "winter-weekend");
  form.set("buyerName", "Pat Buyer");
  form.set("buyerEmail", "pat@example.com");
  return new NextRequest("https://app.example.com/api/events/private-lessons/checkout", {
    method: "POST",
    body: form,
    headers: { "x-forwarded-for": `10.9.0.${ipCounter}` },
  });
}

function slotRow() {
  return db.rows("event_private_lesson_slots")[0];
}

function expectRefused(response: Response) {
  expect(response.headers.get("location")).toContain("error=organizer_suite_required");
  expect(stripeCreate).not.toHaveBeenCalled();
  expect(slotRow().status).toBe("available");
  expect(slotRow().payment_status).toBe("unpaid");
  expect(db.writes.filter((write) => write.table === "event_private_lesson_slots")).toHaveLength(0);
}

function expectAllowed(response: Response, feeCents: number | null) {
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("https://checkout.stripe.test/session");
  expect(stripeCreate).toHaveBeenCalledTimes(1);
  expect(slotRow().status).toBe("held");
  const [params] = stripeCreate.mock.calls[0] as [{ payment_intent_data: { application_fee_amount?: number } }];
  expect(params.payment_intent_data.application_fee_amount ?? null).toBe(feeCents);
}

beforeEach(() => {
  stripeCreate = vi.fn().mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.test/session" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ordinary studio listings are unaffected", () => {
  it("an event with no organizer proceeds with no DanceFlow fee, with or without any entitlement", async () => {
    seed({ eventOrganizerId: null, slotOrganizerId: null, entitlements: [] });
    expectAllowed(await POST(request()), null);
  });
});

describe("Organizer Suite events need a current entitlement for a new purchase", () => {
  it("a current open-ended manual grant proceeds with the Pro add-on fee (3%)", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: [grant()] });
    expectAllowed(await POST(request()), 300);
  });

  it("a lapsed manual grant alone is refused and the slot is never held", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] });
    expectRefused(await POST(request()));
  });

  it("no entitlement at all is refused", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: [] });
    expectRefused(await POST(request()));
  });

  it("a lapsed grant plus an active paid add-on proceeds (access continues through the paid row)", async () => {
    seed({
      eventOrganizerId: "org-1",
      slotOrganizerId: "org-1",
      entitlements: [grant({ period_end: "2026-12-01" }), stripeItem()],
    });
    expectAllowed(await POST(request()), 300);
  });

  it("the event being tied to an organizer is enough even if the slot row has no organizer", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: null, entitlements: [grant({ period_end: "2026-12-01" })] });
    expectRefused(await POST(request()));
  });

  it("the slot being tied to an organizer is enough even if the event row has none", async () => {
    seed({ eventOrganizerId: null, slotOrganizerId: "org-1", entitlements: [] });
    expectRefused(await POST(request()));
  });

  it("a studio on the Organizer plan keeps the standard organizer fee (3.5%) without any add-on", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", planCode: "organizer", entitlements: [] });
    expectAllowed(await POST(request()), 350);
  });

  it("a Growth studio with a current grant pays the 3.25% add-on fee", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", planCode: "growth", entitlements: [grant()] });
    expectAllowed(await POST(request()), 325);
  });
});

describe("DanceAbel boundary: complimentary access through July 8, 2027 (grant period_end 2027-07-09, America/New_York)", () => {
  const entitlements = () => [grant({ period_end: "2027-07-09" })];

  it("is allowed one second before local midnight on July 9 (2027-07-09T03:59:59Z)", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: entitlements() });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expectAllowed(await POST(request()), 300);
  });

  it("is refused from local midnight on July 9 (2027-07-09T04:00:00Z)", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: entitlements() });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expectRefused(await POST(request()));
  });

  it("is allowed throughout July 8, 2027 (afternoon in New York)", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: entitlements() });
    vi.setSystemTime(new Date("2027-07-08T20:00:00Z"));
    expectAllowed(await POST(request()), 300);
  });
});

describe("existing bookings are not re-evaluated here", () => {
  it("a slot that is already booked or held gets the existing 'already booked' answer, whatever the entitlement", async () => {
    seed({ eventOrganizerId: "org-1", slotOrganizerId: "org-1", entitlements: [] });
    slotRow().status = "booked";
    slotRow().payment_status = "paid";
    const response = await POST(request());
    expect(response.headers.get("location")).toContain("error=private_lesson_already_booked");
    expect(stripeCreate).not.toHaveBeenCalled();
    expect(slotRow().status).toBe("booked");
    expect(slotRow().payment_status).toBe("paid");
  });
});
