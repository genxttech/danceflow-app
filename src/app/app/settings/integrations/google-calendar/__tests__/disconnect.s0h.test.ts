import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
class Redirect extends Error { constructor(public to: string) { super("redirect"); } }
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Redirect(to); },
  unstable_rethrow: (error: unknown) => { if (error instanceof Redirect) throw error; },
}));

const state = vi.hoisted(() => ({ status: "connected", statusAfter: "connected", credentials: true, cleanup: vi.fn(), revoke: vi.fn(), remove: vi.fn(), updates: [] as unknown[] }));

function builder(row: () => Record<string, unknown>) {
  const b = {
    select: () => b,
    eq: () => b,
    is: () => b,
    update: (patch: unknown) => { state.updates.push(patch); return b; },
    maybeSingle: async () => ({ data: row(), error: null }),
    then: (resolve: (value: unknown) => void) => resolve({ data: null, error: null }),
  };
  return b;
}
vi.mock("@/lib/integrations/google-calendar/access", () => ({
  parseGoogleCalendarScope: () => "studio",
  googleCalendarReturnPath: () => "/g",
  getGoogleCalendarAccess: async () => ({ context: { studioId: "s1", userId: "u1" }, supabase: { from: () => builder(() => ({ id: "c1", studio_id: "s1", status: state.status })) } }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: () => builder(() => ({ status: state.statusAfter })) }) }));
vi.mock("@/lib/integrations/google-calendar/sync", () => ({ cleanupGoogleCalendarConnectionEvents: state.cleanup, syncGoogleCalendarConnection: vi.fn() }));
vi.mock("@/lib/integrations/google-calendar/client", () => ({ revokeGoogleCalendarGrant: state.revoke, getValidGoogleCalendarAccessToken: vi.fn(), listGoogleCalendars: vi.fn() }));
vi.mock("@/lib/integrations/google-calendar/credentials", () => ({ loadGoogleCredentials: async () => (state.credentials ? { encrypted_access_token: "x" } : null), deleteGoogleCredentials: state.remove }));

import { disconnectGoogleCalendarAction } from "../actions";

async function run() {
  try { await disconnectGoogleCalendarAction(new FormData()); } catch (error) { if (error instanceof Redirect) return error.to; throw error; }
  return "";
}

beforeEach(() => {
  Object.assign(state, { status: "connected", statusAfter: "connected", credentials: true, updates: [] });
  state.cleanup.mockReset().mockResolvedValue({ failed: 0 });
  state.revoke.mockReset().mockResolvedValue("revoked");
  state.remove.mockReset();
});

describe("Google Calendar disconnect (S0-h)", () => {
  it("cleans up, revokes and removes credentials", async () => {
    expect(await run()).toContain("disconnected=1&cleanup_skipped=0");
    expect(state.remove).toHaveBeenCalled();
    expect(state.updates).toEqual([{ status: "disconnected", last_sync_error: null }]);
  });

  it.each([
    ["a transient failure on a healthy connection", () => state.cleanup.mockRejectedValue(new Error("Google is temporarily unavailable"))],
    ["partial delete failures", () => state.cleanup.mockResolvedValue({ failed: 2 })],
  ])("keeps the connection after %s", async (_name, arrange) => {
    arrange();
    expect(await run()).toContain("error=disconnect_cleanup_failed");
    expect(state.revoke).not.toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it.each([
    ["the connection already needs reauthorization", () => { state.status = "needs_reauth"; }],
    ["the failed attempt parked it for reauthorization", () => { state.statusAfter = "needs_reauth"; }],
    ["no credentials remain", () => { state.credentials = false; }],
  ])("disconnects without cleanup when %s", async (_name, arrange) => {
    arrange();
    state.cleanup.mockRejectedValue(new Error("authorization expired"));
    expect(await run()).toContain("cleanup_skipped=1");
    expect(state.remove).toHaveBeenCalled();
  });
});
