import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GC-S1E-2 review: push idempotency must not depend on email. The helper checks the existing per-account push log
 * (mobile_notification_log) for a SENT push carrying the same notice key.
 */
const h = vi.hoisted(() => ({
  links: [] as Array<{ studio_id: string; client_id: string; user_id: string }>,
  logs: [] as Array<{ user_id: string; status: string; data: Record<string, unknown> }>,
  logLookupFails: false,
  push: vi.fn(),
}));

vi.mock("@/lib/notifications/expoPush", () => ({
  sendMobilePushToUser: async (p: { userId: string; data?: Record<string, unknown> }) => {
    h.push(p);
    h.logs.push({ user_id: p.userId, status: "sent", data: p.data ?? {} });
    return { ok: true };
  },
}));
vi.mock("@/lib/schedule/groupClassRoster", () => ({ resolveClassAttendeesForNotification: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const q = { users: [] as string[], status: "", key: "" };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.in = (_c: string, v: string[]) => ((q.users = v), chain);
      chain.eq = (c: string, v: string) => {
        if (c === "status") q.status = v;
        if (c === "data->>noticeKey") q.key = v;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) => {
        if (table !== "mobile_notification_log") return resolve({ data: [], error: null });
        if (h.logLookupFails) return resolve({ data: null, error: { message: "boom" } });
        return resolve({
          data: h.logs.filter((l) => q.users.includes(l.user_id) && l.status === q.status && l.data.noticeKey === q.key).map((l) => ({ user_id: l.user_id })),
          error: null,
        });
      };
      return chain;
    },
  }),
}));

const { sendGroupClassNoticePush } = await import("../schedulePush");

function supabaseWithLinks() {
  return {
    from: () => {
      const q = { client: "", studio: "" };
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (c: string, v: string) => {
        if (c === "client_id") q.client = v;
        if (c === "studio_id") q.studio = v;
        return chain;
      };
      chain.then = (resolve: (v: unknown) => void) =>
        resolve({ data: h.links.filter((l) => l.client_id === q.client && l.studio_id === q.studio).map((l) => ({ user_id: l.user_id })), error: null });
      return chain;
    },
  } as never;
}

const base = { studioId: "s1", appointmentId: "a1", kind: "enrolled" as const, title: "t", body: "b", noticeKey: "group_class_enrolled:s1:ann:att-1" };

beforeEach(() => {
  h.links = [{ studio_id: "s1", client_id: "ann", user_id: "u-ann" }];
  h.logs = [];
  h.logLookupFails = false;
  h.push.mockClear();
});

describe("S1E-2 push idempotency (no email involved)", () => {
  it("a push-only dancer is pushed once for an event, never twice on replay", async () => {
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base })).toBe(1);
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base })).toBe(0);
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.push.mock.calls[0][0].data.noticeKey).toBe(base.noticeKey);
  });

  it("a different event for the same dancer still pushes", async () => {
    await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base });
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base, noticeKey: "group_class_enrolled:s1:ann:att-2" })).toBe(1);
    expect(h.push).toHaveBeenCalledTimes(2);
  });

  it("a push that never reached a device (failed or skipped log) does not block a later send", async () => {
    h.logs.push({ user_id: "u-ann", status: "failed", data: { noticeKey: base.noticeKey } }, { user_id: "u-ann", status: "skipped", data: { noticeKey: base.noticeKey } });
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base })).toBe(1);
  });

  it("a guardian linked to two dancers is one account, and only accounts not yet pushed are pushed on replay", async () => {
    h.links = [
      { studio_id: "s1", client_id: "ann", user_id: "u-guardian" },
      { studio_id: "s1", client_id: "bo", user_id: "u-guardian" },
      { studio_id: "s1", client_id: "bo", user_id: "u-bo" },
    ];
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann", "bo"], ...base })).toBe(2);
    h.logs = h.logs.filter((l) => l.user_id !== "u-bo");
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann", "bo"], ...base })).toBe(1);
    expect(h.push.mock.calls.map((c) => c[0].userId).sort()).toEqual(["u-bo", "u-bo", "u-guardian"]);
  });

  it("an account linked in another studio is never reached", async () => {
    h.links = [{ studio_id: "s2", client_id: "ann", user_id: "u-other" }];
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base })).toBe(0);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("an unreadable push log favors delivery over suppression", async () => {
    h.logLookupFails = true;
    expect(await sendGroupClassNoticePush({ supabase: supabaseWithLinks(), clientIds: ["ann"], ...base })).toBe(1);
  });
});
