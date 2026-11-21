import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/usage/addons", () => ({
  getIncludedUsageAllowance: ({ planCode }: { planCode: string | null }) =>
    planCode === "growth" ? 200 : planCode === "pro" ? 500 : 0,
}));

import {
  getLumiUsageSnapshot,
  lumiDancerCaps,
  releaseLumiUsage,
  reserveLumiUsage,
  settleLumiUsage,
} from "../usage";
import type { LumiPortalAccess } from "../portal";

type Row = Record<string, unknown> & { id: string };

/** Minimal in-memory stand-in for the service-role client, with a yield between steps so parallel requests interleave. */
function makeAdmin(initialEntitlements: Array<{ quantity_included: number }> = [], opts: { failCounts?: boolean } = {}) {
  const events: Row[] = [];
  let seq = 0;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  function query(table: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let mode: "select" | "update" = "select";
    let patch: Record<string, unknown> = {};
    let head = false;
    const api: Record<string, unknown> = {
      select(_cols?: string, opts?: { head?: boolean }) {
        head = Boolean(opts?.head);
        return api;
      },
      eq(col: string, value: unknown) {
        filters.push((row) => row[col] === value);
        return api;
      },
      in(col: string, values: string[]) {
        filters.push((row) => {
          const state = col === "metadata->>state" ? (row.metadata as { state?: string }).state : row[col];
          return values.includes(state as string);
        });
        return api;
      },
      gte(col: string, value: string) {
        filters.push((row) => String(row[col]) >= value);
        return api;
      },
      update(value: Record<string, unknown>) {
        mode = "update";
        patch = value;
        return api;
      },
      then(resolve: (value: unknown) => void) {
        return (async () => {
          await tick();
          if (table === "usage_addon_entitlements") return { data: initialEntitlements, error: null };
          if (mode === "update") {
            events.filter((row) => filters.every((f) => f(row))).forEach((row) => Object.assign(row, patch));
            return { error: null };
          }
          if (head && opts.failCounts) return { count: null, error: { message: "boom" } };
          const matched = events.filter((row) => filters.every((f) => f(row)));
          return head ? { count: matched.length, error: null } : { data: matched, error: null };
        })().then(resolve);
      },
    };
    return api;
  }

  const admin = {
    from(table: string) {
      const base = query(table);
      return {
        ...base,
        insert(row: Record<string, unknown>) {
          return {
            select: () => ({
              single: async () => {
                await tick();
                const created = { ...row, id: `e${++seq}`, created_at: new Date().toISOString() } as Row;
                events.push(created);
                return { data: { id: created.id }, error: null };
              },
            }),
          };
        },
      };
    },
  };
  return { admin, events };
}

function accessFor(admin: unknown, overrides: Partial<{ plan: string | null; client: string; studio: string }> = {}) {
  return {
    admin,
    studio: { id: overrides.studio ?? "studio-1", name: "S", slug: "s" },
    client: { id: overrides.client ?? "client-1", first_name: null, last_name: null, is_independent_instructor: false },
    planCode: overrides.plan === undefined ? "growth" : overrides.plan,
    enabled: true,
    eligible: true,
    allowed: true,
    reason: "available",
  } as unknown as LumiPortalAccess;
}

const states = (events: Row[]) => events.map((row) => (row.metadata as { state: string }).state);

describe("LUMI usage accounting", () => {
  beforeEach(() => {
    delete process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY;
    delete process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_MONTH;
  });

  it("records under its own feature key and never touches the operational ai_action pool", async () => {
    const { admin, events } = makeAdmin();
    const access = accessFor(admin);
    const reservation = await reserveLumiUsage(access, "weekly_plan");
    expect(reservation.ok).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      feature_key: "lumi_action",
      source: "lumi_journey_assistant",
      studio_id: "studio-1",
      related_table: "clients",
      related_id: "client-1",
      workspace_type: "studio",
      organizer_id: null,
    });
    expect(events.some((row) => row.feature_key === "ai_action")).toBe(false);
  });

  it("does not use record_usage_event (which needs auth.uid and a studio role)", async () => {
    const { admin } = makeAdmin();
    (admin as unknown as { rpc: () => never }).rpc = () => {
      throw new Error("rpc must not be used");
    };
    await expect(reserveLumiUsage(accessFor(admin), "weekly_plan")).resolves.toMatchObject({ ok: true });
  });

  it("settles after a billable call and releases when the provider was not reached", async () => {
    const { admin, events } = makeAdmin();
    const access = accessFor(admin);
    const a = await reserveLumiUsage(access, "weekly_plan");
    const b = await reserveLumiUsage(access, "weekly_plan");
    if (!a.ok || !b.ok) throw new Error("reservations expected");
    await settleLumiUsage(access, a.id, "weekly_plan", { outcome: "ok" });
    await releaseLumiUsage(access, b.id, "weekly_plan");
    expect(states(events)).toEqual(["settled", "released"]);
    const snapshot = await getLumiUsageSnapshot(access);
    expect(snapshot).toMatchObject({ used: 1, dancerMonth: 1, dancerToday: 1, allowed: true });
  });

  it("parallel requests can never exceed the per-dancer daily cap (reserve-then-verify)", async () => {
    process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY = "3";
    const { admin, events } = makeAdmin();
    const access = accessFor(admin);
    const results = await Promise.all(Array.from({ length: 12 }, () => reserveLumiUsage(access, "weekly_plan")));
    const admitted = results.filter((r) => r.ok).length;
    expect(admitted).toBeLessThanOrEqual(3);
    expect(states(events).filter((s) => s === "reserved").length).toBe(admitted);
    expect(states(events).filter((s) => s === "released").length).toBe(12 - admitted);
  });

  it("parallel requests can never exceed the studio pool (growth = 200 in the real numbers; here forced small via add-on = 0 and cap)", async () => {
    // Pool = plan allowance only (200). Fire 260 parallel requests from 260 different dancers: at most 200 may be admitted.
    const { admin } = makeAdmin();
    const results = await Promise.all(
      Array.from({ length: 260 }, (_, i) => reserveLumiUsage(accessFor(admin, { client: `c${i}` }), "weekly_plan")),
    );
    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(200);
  });

  it("a studio with no AI allowance (starter / no plan) is refused", async () => {
    const { admin, events } = makeAdmin();
    const result = await reserveLumiUsage(accessFor(admin, { plan: "starter" }), "weekly_plan");
    expect(result).toEqual({ ok: false, reason: "pool_exhausted" });
    expect(states(events)).toEqual(["released"]);
  });

  it("add-on credit packs enlarge the LUMI pool without changing plan numbers", async () => {
    const { admin } = makeAdmin([{ quantity_included: 200 }]);
    const snapshot = await getLumiUsageSnapshot(accessFor(admin, { plan: "growth" }));
    expect(snapshot.total).toBe(400);
  });

  it("counts are per studio and per dancer: another studio or dancer does not consume this dancer's caps", async () => {
    process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY = "1";
    const { admin } = makeAdmin();
    expect((await reserveLumiUsage(accessFor(admin, { client: "a" }), "weekly_plan")).ok).toBe(true);
    expect((await reserveLumiUsage(accessFor(admin, { client: "a" }), "weekly_plan")).ok).toBe(false);
    expect((await reserveLumiUsage(accessFor(admin, { client: "b" }), "weekly_plan")).ok).toBe(true);
    expect((await reserveLumiUsage(accessFor(admin, { client: "a", studio: "studio-2" }), "weekly_plan")).ok).toBe(true);
  });

  it("an unreadable count fails closed (refuses and releases)", async () => {
    const { admin, events } = makeAdmin([], { failCounts: true });
    const result = await reserveLumiUsage(accessFor(admin), "weekly_plan");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(states(events)).toEqual(["released"]);
  });

  it("default dancer caps are the documented ones and are env-tunable", () => {
    expect(lumiDancerCaps()).toEqual({ perDay: 10, perMonth: 60 });
    process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY = "4";
    process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_MONTH = "12";
    expect(lumiDancerCaps()).toEqual({ perDay: 4, perMonth: 12 });
    process.env.LUMI_MAX_REQUESTS_PER_DANCER_PER_DAY = "not-a-number";
    expect(lumiDancerCaps().perDay).toBe(10);
  });
});
