import { beforeEach, describe, expect, it, vi } from "vitest";

/** GC-S1C-4: consolidated notification fan-out (recipient dedupe, failure isolation). */

const queueMock = vi.fn();
vi.mock("@/lib/notifications/outbound", () => ({ queueOutboundDelivery: (...a: unknown[]) => queueMock(...a) }));
const pushMock = vi.fn();
vi.mock("@/lib/notifications/schedulePush", () => ({
  sendGroupClassSeriesCancellationPush: (...a: unknown[]) => pushMock(...a),
}));

let tables: Record<string, unknown> = {};
let adminThrows = false;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    if (adminThrows) throw new Error("no admin");
    return {
      from(table: string) {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.in = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: tables[table] ?? null, error: null });
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: tables[table] ?? [], error: null });
        return chain;
      },
    };
  },
}));

const { notifySeriesCancellation } = await import("@/lib/notifications/groupClassSeriesCancellation");

const base = {
  seriesId: "ser-1",
  studioId: "studio-1",
  cancelledClassCount: 2,
  enrollmentsCancelled: 3,
  alreadyCancelledCount: 0,
  historicalCount: 0,
  terminalAttendanceCount: 0,
  seriesStatus: "cancelled",
  seriesCancelledByThisCall: true,
};

beforeEach(() => {
  queueMock.mockReset().mockResolvedValue({ queued: true, skipped: false });
  pushMock.mockReset().mockResolvedValue(undefined);
  adminThrows = false;
  tables = {
    clients: [
      { id: "c1", first_name: "Ava", email: "Parent@Example.com" },
      { id: "c2", first_name: "Ben", email: "parent@example.com " },
      { id: "c3", first_name: "Cy", email: null },
      { id: "c4", first_name: "Di", email: "di@example.com" },
    ],
    studios: { name: "Legal", public_name: "Bright", public_logo_url: null, slug: "bright" },
    studio_settings: { timezone: "America/New_York" },
    appointments: { title: "Salsa" },
  };
});

describe("notifySeriesCancellation", () => {
  const recipients = [
    { clientId: "c1", classStarts: ["2026-11-03T23:30:00Z", "2026-11-10T23:30:00Z"] },
    { clientId: "c2", classStarts: ["2026-11-10T23:30:00Z", "2026-11-17T23:30:00Z"] },
    { clientId: "c3", classStarts: ["2026-11-03T23:30:00Z"] },
    { clientId: "c4", classStarts: ["2026-11-03T23:30:00Z"] },
  ];

  it("sends one email per distinct address (merged classes), skips no-email clients, one push call", async () => {
    const queued = await notifySeriesCancellation({
      supabase: {} as never,
      anchorAppointmentId: "a1",
      result: { ...base, recipients },
    });
    expect(queued).toBe(2);
    expect(queueMock).toHaveBeenCalledTimes(2);
    const parent = queueMock.mock.calls.map((c) => c[0]).find((c) => c.recipientEmail === "parent@example.com");
    expect(parent.templateKey).toBe("group_class_series_cancelled");
    expect(parent.bodyText).toContain("cancelled 3 upcoming sessions");
    expect(parent.dedupeKey).toContain("ser-1");
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock.mock.calls[0][0].recipients).toHaveLength(4);
  });

  it("no recipients means no email and no push", async () => {
    const queued = await notifySeriesCancellation({
      supabase: {} as never,
      anchorAppointmentId: "a1",
      result: { ...base, recipients: [] },
    });
    expect(queued).toBe(0);
    expect(queueMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });

  it("an email queue failure for one address does not stop the others or the push, and never throws", async () => {
    queueMock.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ queued: true, skipped: false });
    const queued = await notifySeriesCancellation({
      supabase: {} as never,
      anchorAppointmentId: "a1",
      result: { ...base, recipients },
    });
    expect(queued).toBe(1);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("a total email-path failure and a push failure are both swallowed", async () => {
    adminThrows = true;
    pushMock.mockRejectedValue(new Error("expo down"));
    await expect(
      notifySeriesCancellation({ supabase: {} as never, anchorAppointmentId: "a1", result: { ...base, recipients } }),
    ).resolves.toBe(0);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});
