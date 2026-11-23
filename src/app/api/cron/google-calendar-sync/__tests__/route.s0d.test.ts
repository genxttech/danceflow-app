/* eslint-disable @typescript-eslint/no-explicit-any -- loose PostgREST fake */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/security/cron", () => ({ getCronAuthFailure: () => null }));

type Row = Record<string, any>;
const db: Record<string, Row[]> = {};
const synced: string[] = [];
let syncDelayMs = 0;
let now = 1_000_000;

vi.mock("@/lib/integrations/google-calendar/sync", () => ({
  syncGoogleCalendarConnection: async (c: Row) => {
    synced.push(c.id);
    now += syncDelayMs;
    return { connectionId: c.id, studioId: c.studio_id, scope: c.connection_scope, status: "success", synced: 1, deleted: 0, failed: 0 };
  },
}));

function table(name: string) {
  const filters: Array<(r: Row) => boolean> = [];
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return builder; },
    in: (c: string, v: any[]) => { filters.push((r) => v.includes(r[c])); return builder; },
    not: (c: string, op: string, v: any) => {
      if (op === "is") filters.push((r) => r[c] !== null && r[c] !== undefined);
      if (op === "in") { const ids = String(v).replace(/[()]/g, "").split(","); filters.push((r) => !ids.includes(r[c])); }
      return builder;
    },
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    then: (resolve: any) => resolve({ data: (db[name] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
  };
  return builder;
}
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: (n: string) => table(n) }) }));

import { GET, GOOGLE_CALENDAR_CRON_BUDGET_MS, maxDuration } from "../route";

const conn = (id: string, over: Row = {}) => ({ id, studio_id: "s1", connection_scope: "studio", instructor_id: null, status: "connected", calendar_id: "cal", ...over });

beforeEach(() => {
  for (const k of Object.keys(db)) delete db[k];
  synced.length = 0; syncDelayMs = 0; now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(() => vi.restoreAllMocks());

describe("S0-d google calendar cron", () => {
  it("exports maxDuration with a budget that leaves headroom", () => {
    expect(maxDuration).toBe(60);
    expect(GOOGLE_CALENDAR_CRON_BUDGET_MS).toBeLessThan(maxDuration * 1000 - 10_000);
  });

  it("stops starting connections once the budget is spent and reports the rest as deferred", async () => {
    db.studio_google_calendar_connections = [conn("a"), conn("b"), conn("c"), conn("d")];
    syncDelayMs = 15_000;
    const body = await (await GET({} as any)).json();
    expect(synced).toEqual(["a", "b", "c"]);
    expect(body).toMatchObject({ ok: true, processed: 3, deferred: 1 });
  });

  it("syncs everything when the budget is not reached", async () => {
    db.studio_google_calendar_connections = [conn("a"), conn("b")];
    const body = await (await GET({} as any)).json();
    expect(synced).toEqual(["a", "b"]);
    expect(body.deferred).toBe(0);
  });

  it("skips personal connections of deactivated instructors but keeps active ones and studio connections", async () => {
    db.instructors = [{ id: "i-off", active: false }, { id: "i-on", active: true }];
    db.studio_google_calendar_connections = [
      conn("studio"), conn("p-off", { connection_scope: "instructor", instructor_id: "i-off" }), conn("p-on", { connection_scope: "instructor", instructor_id: "i-on" }),
    ];
    await GET({} as any);
    expect(synced.sort()).toEqual(["p-on", "studio"]);
  });
});
