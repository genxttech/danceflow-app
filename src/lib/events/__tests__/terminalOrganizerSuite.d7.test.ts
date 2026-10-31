import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { terminalSaleNeedsOrganizerSuite } from "@/lib/events/terminalOrganizerSuite";
import { createTerminalFakeDb, type Row } from "@/lib/events/__tests__/terminalFake";

/**
 * D7 owner decision P2-3: a NEW Terminal ticket sale for an organizer event needs a current Organizer Suite
 * entitlement (same access signal as the online event checkouts); ordinary studio events never do.
 */

const STUDIO = "studio-1";

function db(options: { plan?: string; entitlements?: Row[] } = {}) {
  return createTerminalFakeDb({
    studio_subscriptions: [{ id: "sub-1", studio_id: STUDIO, status: "active", subscription_plans: { code: options.plan ?? "pro" } }],
    usage_addon_entitlements: (options.entitlements ?? []).map((row) => ({ studio_id: STUDIO, feature_key: "organizer_suite", ...row })),
    studios: [{ id: STUDIO, timezone: "America/New_York" }],
  }).client as never;
}

const grant = (overrides: Row = {}): Row => ({ id: "g", source: "manual_grant", status: "active", period_start: null, period_end: null, ...overrides });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2027-01-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("terminalSaleNeedsOrganizerSuite", () => {
  it("never gates an ordinary studio event (no organizer), whatever the entitlement", async () => {
    expect(await terminalSaleNeedsOrganizerSuite(db(), { studioId: STUDIO, organizerId: null })).toBe(false);
    expect(await terminalSaleNeedsOrganizerSuite(db(), { studioId: STUDIO, organizerId: undefined })).toBe(false);
  });

  it.each([
    { name: "no entitlement", entitlements: [] as Row[], needs: true },
    { name: "a lapsed grant", entitlements: [grant({ period_end: "2026-12-01" })], needs: true },
    { name: "a revoked grant", entitlements: [grant({ status: "revoked" })], needs: true },
    { name: "a current grant", entitlements: [grant()], needs: false },
    { name: "DanceAbel-style grant (period_end 2027-07-09) before the boundary", entitlements: [grant({ period_end: "2027-07-09" })], needs: false },
  ])("organizer event with $name -> refuse=$needs", async ({ entitlements, needs }) => {
    expect(await terminalSaleNeedsOrganizerSuite(db({ entitlements }), { studioId: STUDIO, organizerId: "org-1" })).toBe(needs);
  });

  it("DanceAbel boundary: allowed at 03:59:59Z, refused at 04:00:00Z on 2027-07-09", async () => {
    const database = db({ entitlements: [grant({ period_end: "2027-07-09" })] });
    vi.setSystemTime(new Date("2027-07-09T03:59:59Z"));
    expect(await terminalSaleNeedsOrganizerSuite(database, { studioId: STUDIO, organizerId: "org-1" })).toBe(false);
    vi.setSystemTime(new Date("2027-07-09T04:00:00Z"));
    expect(await terminalSaleNeedsOrganizerSuite(database, { studioId: STUDIO, organizerId: "org-1" })).toBe(true);
  });

  it("the Organizer plan needs no add-on row; a lapsed grant plus an active Stripe add-on is allowed", async () => {
    expect(await terminalSaleNeedsOrganizerSuite(db({ plan: "organizer" }), { studioId: STUDIO, organizerId: "org-1" })).toBe(false);
    const withAddon = db({ entitlements: [grant({ period_end: "2026-12-01" }), { id: "i", source: "stripe_subscription_item", status: "active", period_start: null, period_end: null }] });
    expect(await terminalSaleNeedsOrganizerSuite(withAddon, { studioId: STUDIO, organizerId: "org-1" })).toBe(false);
  });
});
