import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CF1 dark gate, live pages CF1 modified: with COMPETITION_FINALS_ENABLED unset the server actions behave exactly as the live
 * release (a965f477). With the flag on they take the CF1 path.
 */

const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const scoringLoads: string[] = [];
let rpcResult: { error: { message: string; code?: string } | null } = { error: null };

const fakeSupabase = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return rpcResult;
  },
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "r" }, error: null }) }) }) }) }),
};

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/competition/workspaceServer", () => ({
  requireCompetitionManager: async () => ({ supabase: fakeSupabase }),
  requireCompetitionWorkspace: async () => ({ supabase: fakeSupabase }),
}));
vi.mock("@/lib/competition/scoring/studioReadinessServer", () => ({
  loadStudioScoringReadiness: async (_supabase: unknown, eventId: string) => {
    scoringLoads.push(eventId);
    return { blockers: [{ programId: "p1", divisionId: "d1", divisionName: "Newcomer", detail: "No approved method", severity: "blocker", code: "x" }], notices: [], configuredRounds: 1 };
  },
  loadCallbackTargetMinimumFindings: async () => [],
}));
vi.mock("@/lib/competition/scoring/studioReadiness", () => ({
  publishScoringBlockers: (scoring: { blockers: unknown[] }) => scoring.blockers,
}));

const EVENT = "11111111-1111-4111-8111-111111111111";
const ROUND = "22222222-2222-4222-8222-222222222222";

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirected(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("NEXT_REDIRECT;")) return decodeURIComponent(message.slice("NEXT_REDIRECT;".length).replaceAll("+", " "));
    throw error;
  }
  throw new Error("expected a redirect");
}

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.COMPETITION_FINALS_ENABLED;
  delete process.env.COMPETITION_FINALS_ENABLED;
  rpcCalls.length = 0;
  scoringLoads.length = 0;
  rpcResult = { error: null };
});
afterEach(() => {
  if (saved === undefined) delete process.env.COMPETITION_FINALS_ENABLED;
  else process.env.COMPETITION_FINALS_ENABLED = saved;
});

describe("setHeatCapacityAction", () => {
  // Since hotfix ac902c28 (owner-approved, OD-3/OD-14) the live baseline is the reasoned four-argument call, flag or no flag.
  it("off: the hotfix baseline, one four-argument call", async () => {
    const { setHeatCapacityAction } = await import("@/app/app/events/[id]/competition/schedule/actions");
    const requestId = "33333333-3333-4333-8333-333333333333";
    const url = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", floorHeatId: "h1", reason: "Final floor fits six couples only", requestId })));
    expect(rpcCalls).toEqual([{ name: "set_competition_round_heat_capacity", args: { p_round_id: ROUND, p_capacity: 6, p_reason: "Final floor fits six couples only", p_request_id: requestId } }]);
    expect(url).toContain("notice=Heat size saved");
  });

  it("off: a deadlock is not retried (the hotfix makes one call) and a capacity refusal is shown as a plain sentence", async () => {
    const { setHeatCapacityAction } = await import("@/app/app/events/[id]/competition/schedule/actions");
    const requestId = "33333333-3333-4333-8333-333333333333";
    rpcResult = { error: { message: "deadlock detected", code: "40P01" } };
    await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: "Final floor fits six couples only", requestId })));
    expect(rpcCalls).toHaveLength(1);
    rpcResult = { error: { message: "COMP_CAPACITY_RANGE: choose between 1 and 100 entries per scoring heat.", code: "P0001" } };
    const url = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "600", reason: "Final floor fits six couples only", requestId })));
    expect(url).toContain("error=Choose between 1 and 100 entries per scoring heat.");
  });

  it("on: the reasoned four-argument call; a missing reason is refused before any RPC", async () => {
    process.env.COMPETITION_FINALS_ENABLED = "true";
    const { setHeatCapacityAction } = await import("@/app/app/events/[id]/competition/schedule/actions");
    await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6" })));
    expect(rpcCalls).toEqual([]);
    const requestId = "33333333-3333-4333-8333-333333333333";
    await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: "Final floor fits six couples only", requestId })));
    expect(rpcCalls).toEqual([{ name: "set_competition_round_heat_capacity", args: { p_round_id: ROUND, p_capacity: 6, p_reason: "Final floor fits six couples only", p_request_id: requestId } }]);
  });
});

describe("publishCompetitionAction", () => {
  it("off: publishes exactly as the live release, without the CF1 scoring readiness check", async () => {
    const { publishCompetitionAction } = await import("@/app/app/events/[id]/competition/simpleActions");
    rpcResult = { error: { message: "stop after the publish call", code: "P0001" } };
    const result = await publishCompetitionAction({ ok: false } as never, form({ eventId: EVENT, programId: "p1" }));
    expect(scoringLoads).toEqual([]);
    expect(rpcCalls.map((call) => call.name)).toEqual(["publish_competition_program"]);
    expect(result).toEqual({ ok: false, error: "stop after the publish call" });
  });

  it("on: an unapproved scoring setup blocks publishing before the publish RPC", async () => {
    process.env.COMPETITION_FINALS_ENABLED = "true";
    const { publishCompetitionAction } = await import("@/app/app/events/[id]/competition/simpleActions");
    const result = (await publishCompetitionAction({ ok: false } as never, form({ eventId: EVENT, programId: "p1" }))) as { ok: boolean; error?: string };
    expect(scoringLoads).toEqual([EVENT]);
    expect(rpcCalls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Fix the scoring setup before publishing");
  });
});
