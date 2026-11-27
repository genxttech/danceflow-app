import { beforeEach, describe, expect, it, vi } from "vitest";

const features = vi.hoisted(() => ({ list: new Set<string>(), signedIn: true }));
const allowance = vi.hoisted(() => ({ get: vi.fn(), record: vi.fn() }));
const rows = vi.hoisted(() => [] as Array<Record<string, unknown> & { id: string }>);
const db = vi.hoisted(() => ({ failCount: false }));

vi.mock("@/lib/billing/access", () => ({
  studioHasFeature: async (feature: string) => features.signedIn && features.list.has(feature),
  getCurrentStudioPlanForUser: async () => (features.signedIn ? { studioId: "studio-1" } : null),
}));
vi.mock("@/lib/usage/addons", () => ({
  getUsageAllowance: allowance.get,
  getUsageLimitMessage: () => "limit reached",
  recordUsageEvent: allowance.record,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        const created = { ...row, id: `e${rows.length + 1}` };
        rows.push(created);
        return {
          select: () => ({ single: async () => ({ data: { id: created.id }, error: null }) }),
          then: (resolve: (value: unknown) => void) => resolve({ error: null }),
        };
      },
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const api = {
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return api;
          },
          then(resolve: (value: unknown) => void) {
            rows.filter((row) => filters.every(([c, v]) => row[c] === v)).forEach((row) => Object.assign(row, patch));
            resolve({ error: null });
          },
        };
        return api;
      },
      select: () => {
        const filters: Array<[string, unknown]> = [];
        const api = {
          eq(column: string, value: unknown) {
            filters.push([column, value]);
            return api;
          },
          in: async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (db.failCount) return { count: null, error: { message: "boom" } };
            const counted = rows.filter(
              (row) =>
                filters.every(([c, v]) => row[c] === v) &&
                ["reserved", "settled"].includes((row.metadata as { state: string }).state),
            );
            return { count: counted.length, error: null };
          },
        };
        return api;
      },
    }),
  }),
}));

import { authorizeEventDescriptionAi, eventBasicMonthlyCap } from "../eventDescriptionAccess";

const states = () => rows.map((row) => (row.metadata as { state: string }).state);

describe("event description assistant access", () => {
  beforeEach(() => {
    rows.length = 0;
    features.signedIn = true;
    db.failCount = false;
    features.list = new Set(["public_events"]);
    allowance.get.mockReset().mockResolvedValue({ allowed: true });
    allowance.record.mockReset().mockResolvedValue({ ok: true });
    delete process.env.AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP;
  });

  it("refuses a signed-out caller and a studio that cannot publish events, writing nothing", async () => {
    features.signedIn = false;
    expect(await authorizeEventDescriptionAi("generate")).toMatchObject({ ok: false });
    features.signedIn = true;
    features.list = new Set();
    expect(await authorizeEventDescriptionAi("generate")).toMatchObject({ ok: false });
    expect(rows).toHaveLength(0);
  });

  it("keeps the helper for a Starter studio from its own pool, never the ai_action allowance", async () => {
    const grant = await authorizeEventDescriptionAi("generate");
    expect(grant.ok).toBe(true);
    expect(rows[0]).toMatchObject({ studio_id: "studio-1", feature_key: "ai_event_basic", source: "event_ai_assistant_basic" });
    if (grant.ok) await grant.finish("success");
    expect(states()).toEqual(["settled"]);
    expect(allowance.get).not.toHaveBeenCalled();
    expect(allowance.record).not.toHaveBeenCalled();
  });

  it("releases an unbilled call and keeps a possibly billed one counted", async () => {
    const first = await authorizeEventDescriptionAi("generate");
    if (first.ok) await first.finish("not_billed");
    const second = await authorizeEventDescriptionAi("generate");
    if (second.ok) await second.finish("maybe_billed");
    expect(states()).toEqual(["released", "settled"]);
  });

  it("parallel requests never exceed the basic monthly cap", async () => {
    expect(eventBasicMonthlyCap()).toBe(10);
    process.env.AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP = "3";
    const results = await Promise.all(Array.from({ length: 12 }, () => authorizeEventDescriptionAi("generate")));
    const admitted = results.filter((result) => result.ok).length;
    expect(admitted).toBeLessThanOrEqual(3);
    expect(states().filter((state) => state === "reserved")).toHaveLength(admitted);
  });

  it("counts only this studio's pool for this month, and refuses when the count cannot be read", async () => {
    process.env.AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP = "1";
    rows.push({ id: "other", studio_id: "studio-2", feature_key: "ai_event_basic", period_start: "x", metadata: { state: "settled" } });
    rows.push({ id: "ops", studio_id: "studio-1", feature_key: "ai_action", period_start: "x", metadata: { state: "settled" } });
    expect((await authorizeEventDescriptionAi("generate")).ok).toBe(true);
    rows.length = 0;
    db.failCount = true;
    expect(await authorizeEventDescriptionAi("generate")).toMatchObject({ ok: false });
    expect(states()).toEqual(["released"]);
  });

  it("records a successful paid call even when the session RPC refuses it", async () => {
    features.list = new Set(["ai_assistant", "public_events"]);
    allowance.record.mockResolvedValue({ ok: false });
    const grant = await authorizeEventDescriptionAi("generate");
    if (grant.ok) await grant.finish("success");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ studio_id: "studio-1", feature_key: "ai_action", source: "event_ai_assistant" });
  });

  it("a cap of 0 turns the basic pool off", async () => {
    process.env.AI_EVENT_DESCRIPTION_BASIC_MONTHLY_CAP = "0";
    expect(await authorizeEventDescriptionAi("generate")).toMatchObject({ ok: false });
    expect(rows).toHaveLength(0);
  });

  it("plans with the AI assistant use the ai_action allowance and record only a successful answer", async () => {
    features.list = new Set(["ai_assistant", "public_events"]);
    const grant = await authorizeEventDescriptionAi("generate");
    if (grant.ok) await grant.finish("maybe_billed");
    expect(allowance.record).not.toHaveBeenCalled();
    if (grant.ok) await grant.finish("success");
    expect(allowance.record).toHaveBeenCalledWith(expect.objectContaining({ featureKey: "ai_action", source: "event_ai_assistant" }));
    allowance.get.mockResolvedValue({ allowed: false });
    expect(await authorizeEventDescriptionAi("generate")).toEqual({ ok: false, error: "limit reached" });
    expect(rows).toHaveLength(0);
  });
});
