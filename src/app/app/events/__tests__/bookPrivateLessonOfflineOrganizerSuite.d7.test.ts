import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7 pre-expiry: booking a private-lesson slot OFFLINE (staff books it for a buyer) is a new sale. For an organizer event, or
 * a slot that carries an organizer, it needs a current Organizer Suite entitlement like the online checkout. Ordinary studio
 * private lessons (no organizer on the event or the slot) are unaffected. Refused before the slot is touched.
 */

const STUDIO = "studio-1";
const EVENT = "event-1";
const SLOT = "slot-1";

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

const { bookPrivateLessonSlotOfflineAction } = await import("@/app/app/events/actions");

type Setup = { eventOrganizer?: string | null; slotOrganizer?: string | null; entitlements?: Row[]; slotStatus?: string };

function seed(setup: Setup = {}) {
  state.user = createTerminalFakeDb({
    events: [{ id: EVENT, studio_id: STUDIO, organizer_id: setup.eventOrganizer ?? null }],
    event_private_lesson_slots: [
      {
        id: SLOT,
        event_id: EVENT,
        studio_id: STUDIO,
        organizer_id: setup.slotOrganizer ?? null,
        status: setup.slotStatus ?? "available",
        payment_status: "pending",
        starts_at: "2027-02-01T15:00:00Z",
        ends_at: "2027-02-01T16:00:00Z",
      },
    ],
  });
  state.admin = createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: "pro" } }],
    usage_addon_entitlements: (setup.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  });
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

async function book(paymentStatus = "paid") {
  const formData = new FormData();
  formData.set("eventId", EVENT);
  formData.set("slotId", SLOT);
  formData.set("buyerName", "Ada Lovelace");
  formData.set("paymentStatus", paymentStatus);
  try {
    await bookPrivateLessonSlotOfflineAction(formData);
  } catch (error) {
    const digest = (error as { digest?: string }).digest ?? "";
    return digest.split(";")[2] ?? `THROWN:${(error as Error).message}`;
  }
  return "NO_REDIRECT";
}

const slot = () => state.user.tables.event_private_lesson_slots[0];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("bookPrivateLessonSlotOfflineAction: organizer slots need a current Organizer Suite", () => {
  it.each([
    { name: "an organizer event with no entitlement", setup: { eventOrganizer: "org-1", entitlements: [] as Row[] } },
    { name: "an organizer event with a lapsed grant", setup: { eventOrganizer: "org-1", entitlements: [grant({ period_end: "2026-12-01" })] } },
    { name: "a slot that carries the organizer (event has none) and no entitlement", setup: { slotOrganizer: "org-1", entitlements: [] as Row[] } },
  ])("refuses $name before touching the slot", async ({ setup }) => {
    seed(setup);
    const before = { ...slot() };
    expect(await book()).toContain("private_lesson_error=organizer_suite_required");
    expect(slot()).toEqual(before);
  });

  it.each(["paid", "unpaid", "partial", "waived"])("every offline payment status is gated (%s)", async (paymentStatus) => {
    seed({ eventOrganizer: "org-1", entitlements: [] });
    expect(await book(paymentStatus)).toContain("organizer_suite_required");
    expect(slot()).toMatchObject({ status: "available" });
  });

  it("books with a current grant", async () => {
    seed({ eventOrganizer: "org-1", entitlements: [grant()] });
    expect(await book()).toContain("private_lesson_booked=1");
    expect(slot()).toMatchObject({ status: "booked", payment_status: "paid", buyer_name: "Ada Lovelace" });
  });

  it("DanceAbel boundary: allowed at 03:59:59Z, refused at 04:00:00Z on 2027-07-09", async () => {
    seed({ eventOrganizer: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expect(await book()).toContain("private_lesson_booked=1");
    seed({ eventOrganizer: "org-1", entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect(await book()).toContain("organizer_suite_required");
    expect(slot()).toMatchObject({ status: "available" });
  });

  it("an ordinary studio private lesson (no organizer on the event or the slot) is never gated", async () => {
    seed({ entitlements: [] });
    expect(await book()).toContain("private_lesson_booked=1");
    expect(slot()).toMatchObject({ status: "booked" });
  });

  it("another studio's grant does not satisfy the gate", async () => {
    seed({ eventOrganizer: "org-1", entitlements: [] });
    state.admin.tables.usage_addon_entitlements.push({ studio_id: "another-studio", feature_key: "organizer_suite", source: "manual_grant", status: "active", period_start: null, period_end: null });
    expect(await book()).toContain("organizer_suite_required");
  });

  it("a slot that is no longer available keeps the existing behaviour (nothing booked)", async () => {
    seed({ slotStatus: "booked" });
    const result = await book();
    expect(result).toContain("private_lesson_booked=1");
    expect(slot().status).toBe("booked");
    expect(slot().buyer_name).toBeUndefined();
  });
});
