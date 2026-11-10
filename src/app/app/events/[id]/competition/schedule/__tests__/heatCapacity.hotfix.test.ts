import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hotfix (live regression since PROD S3): the two-argument set_competition_round_heat_capacity now always refuses
 * (COMP_CAPACITY_REASON_REQUIRED, OD-14), so "Max entries per heat" must collect a reason and call the four-argument RPC
 * (round, capacity, reason, request id). Owner-approved behaviour (OD-3/OD-14): capacity edits carry a reason and an audit row.
 */

const EVENT = "11111111-1111-4111-8111-111111111111";
const ROUND = "22222222-2222-4222-8222-222222222222";
const OTHER_ROUND = "44444444-4444-4444-8444-444444444444";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const REASON = "Final floor fits six couples only";

const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let rpcError: { message: string; code?: string } | null = null;
const ownRounds = new Set([ROUND]);

const fakeSupabase = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { data: null, error: rpcError };
  },
  from: (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      maybeSingle: async () => ({
        data: table === "event_competition_rounds" && filters.event_id === EVENT && ownRounds.has(String(filters.id)) ? { id: filters.id } : null,
        error: null,
      }),
    };
    return chain;
  },
};

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/competition/workspaceServer", () => ({
  requireCompetitionManager: async () => ({ supabase: fakeSupabase }),
}));

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

async function redirected(fn: () => Promise<unknown>): Promise<URLSearchParams> {
  try {
    await fn();
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("NEXT_REDIRECT;")) return new URL(message.slice("NEXT_REDIRECT;".length), "http://x").searchParams;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  rpcCalls.length = 0;
  rpcError = null;
});

describe("setHeatCapacityAction (hotfix)", () => {
  it("calls the four-argument RPC with the round, capacity, reason and request id", async () => {
    const { setHeatCapacityAction } = await import("../actions");
    const params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: REASON, requestId: REQUEST, floorHeatId: "h1" })));
    expect(rpcCalls).toEqual([{ name: "set_competition_round_heat_capacity", args: { p_round_id: ROUND, p_capacity: 6, p_reason: REASON, p_request_id: REQUEST } }]);
    expect(params.get("notice")).toBe("Heat size saved. It applies the next time heats are generated.");
    expect(params.get("heat")).toBe("h1");
  });

  it("never calls the two-argument RPC", async () => {
    const { setHeatCapacityAction } = await import("../actions");
    await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: REASON, requestId: REQUEST })));
    for (const call of rpcCalls) expect(Object.keys(call.args).sort()).toEqual(["p_capacity", "p_reason", "p_request_id", "p_round_id"]);
  });

  it("refuses a missing reason before any RPC, with a plain message", async () => {
    const { setHeatCapacityAction } = await import("../actions");
    const params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", requestId: REQUEST, reason: "   " })));
    expect(rpcCalls).toEqual([]);
    expect(params.get("error")).toMatch(/reason/i);
  });

  it("refuses a missing or malformed request id (never invents one) and a round from another event", async () => {
    const { setHeatCapacityAction } = await import("../actions");
    let params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: REASON })));
    expect(params.get("error")).toBe("That change could not be saved. Refresh and try again.");
    params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: REASON, requestId: "not-a-uuid" })));
    expect(params.get("error")).toBe("That change could not be saved. Refresh and try again.");
    params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: OTHER_ROUND, capacity: "6", reason: REASON, requestId: REQUEST })));
    expect(params.get("error")).toBe("That round could not be found. Refresh and try again.");
    expect(rpcCalls).toEqual([]);
  });

  it("shows the database's plain-language refusal (for example a weak reason)", async () => {
    rpcError = { message: "COMP_CAPACITY_REASON_WEAK: the reason must be 20-500 characters, at least 4 words, not a placeholder.", code: "P0001" };
    const { setHeatCapacityAction } = await import("../actions");
    const params = await redirected(() => setHeatCapacityAction(form({ eventId: EVENT, roundId: ROUND, capacity: "6", reason: REASON, requestId: REQUEST })));
    expect(params.get("error")).toBe("The reason must be 20-500 characters, at least 4 words, not a placeholder.");
  });
});

describe("Max entries per heat form (hotfix)", () => {
  it("always sends a reason and a fresh request id with the capacity", () => {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, "../page.tsx"), "utf8");
    const formStart = page.indexOf("<form action={setHeatCapacityAction}");
    expect(formStart).toBeGreaterThan(-1);
    const formSource = page.slice(formStart, page.indexOf("</form>", formStart));
    expect(formSource).toContain('name="capacity"');
    expect(formSource).toMatch(/name="reason"[^>]*required[^>]*minLength=\{20\}[^>]*maxLength=\{500\}/);
    expect(formSource).toContain('<input type="hidden" name="requestId" value={randomUUID()} />');
  });
});
