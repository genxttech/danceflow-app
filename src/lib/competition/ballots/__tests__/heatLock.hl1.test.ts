import { beforeEach, describe, expect, it, vi } from "vitest";
import { canLockHeat, heatLockErrorMessage, lockHeatConfirm, lockHeatHint } from "../heatLock";

const HEAT = "11111111-1111-4111-8111-111111111111";
const ROUND = "22222222-2222-4222-8222-222222222222";
const rpc = vi.fn();
const boardState: { board: unknown; heat: unknown } = { board: null, heat: null };
function setup(over: { role?: string; roundStatus?: string; heatStatus?: string; lockState?: string; inRound?: boolean } = {}) {
  boardState.board = {
    viewer_role: over.role ?? "manager",
    round: { status: over.roundStatus ?? "active" },
    heats: over.inRound === false ? [] : [{ heat_id: HEAT, heat_number: 4 }],
  };
  boardState.heat = { status: over.heatStatus ?? "complete", lock_state: over.lockState ?? "open" };
}
const rpcAll = (name: string, args: unknown) => (name === "competition_round_ballot_status" ? Promise.resolve({ data: boardState.board, error: null }) : rpc(name, args));
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: rpcAll,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: boardState.heat }) }) }) }),
  }),
}));

const RETURN = "/app/events/e1/competition/ballots/r1";

describe("HL1 canLockHeat visibility", () => {
  const roles = ["manager", "chair", "scorer", "judge", ""];
  const roundStatuses = ["draft", "active", "ballots_locked", "calculated", "cancelled"];
  const heatStatuses = ["scheduled", "staging", "active", "complete", "cancelled", null, undefined];
  const lockStates = ["open", "locked", "certified"];

  it("is offered only to a manager, on an active round, for an open complete heat", () => {
    const offered: string[] = [];
    for (const viewerRole of roles)
      for (const roundStatus of roundStatuses)
        for (const heatStatus of heatStatuses)
          for (const lockState of lockStates)
            if (canLockHeat({ viewerRole, roundStatus, heatStatus, lockState })) offered.push([viewerRole, roundStatus, heatStatus, lockState].join("/"));
    expect(offered).toEqual(["manager/active/complete/open"]);
  });

  it("never offers a cancelled heat and says why", () => {
    expect(canLockHeat({ viewerRole: "manager", roundStatus: "active", heatStatus: "cancelled", lockState: "open" })).toBe(false);
    expect(lockHeatHint({ roundStatus: "active", heatStatus: "cancelled", lockState: "open" })).toBe("Cancelled");
  });

  it("explains an undanced heat and stays quiet when locked or action is offered", () => {
    expect(lockHeatHint({ roundStatus: "active", heatStatus: "active", lockState: "open" })).toBe("Not danced yet");
    expect(lockHeatHint({ roundStatus: "active", heatStatus: "complete", lockState: "open" })).toBeNull();
    expect(lockHeatHint({ roundStatus: "active", heatStatus: "complete", lockState: "locked" })).toBeNull();
  });

  it("uses the agreed confirm text", () => {
    expect(lockHeatConfirm(3)).toBe("Lock heat 3? Floor changes to this heat will be refused once locked.");
  });
});

describe("HL1 lockHeatAction", () => {
  beforeEach(() => {
    rpc.mockReset();
    redirect.mockClear();
    setup();
  });

  async function run(fields: Record<string, string>) {
    const { lockHeatAction } = await import("../../../../app/app/events/[id]/competition/ballots/actions");
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return lockHeatAction(form).then(
      () => "no redirect",
      (error: Error) => error.message,
    );
  }

  it("calls the 10A RPC with locked and the note", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await run({ roundId: ROUND, heatId: HEAT, heatNumber: "4", reason: " floor done ", returnTo: RETURN });
    expect(rpc).toHaveBeenCalledWith("set_competition_heat_lock_state", { selected_heat_id: HEAT, selected_state: "locked", selected_reason: "floor done" });
    expect(result).toContain("saved=Heat+4+locked.");
  });

  it("sends a null reason when no note is given", async () => {
    rpc.mockResolvedValue({ error: null });
    await run({ roundId: ROUND, heatId: HEAT, heatNumber: "1", returnTo: RETURN });
    expect(rpc.mock.calls[0][1].selected_reason).toBeNull();
  });

  it("shows RPC refusals and never reports success", async () => {
    rpc.mockResolvedValue({ error: { message: "Heat was not found or cannot be managed." } });
    const result = await run({ roundId: ROUND, heatId: HEAT, heatNumber: "2", returnTo: RETURN });
    expect(result).toContain("error=");
    expect(result).not.toContain("saved=");
    expect(decodeURIComponent(result.replace(/\+/g, " "))).toContain("not allowed to manage");
  });

  it.each([
    ["a chair", { role: "chair" }],
    ["a scorer", { role: "scorer" }],
    ["an undanced heat", { heatStatus: "active" }],
    ["a cancelled heat", { heatStatus: "cancelled" }],
    ["an already locked heat", { lockState: "locked" }],
    ["a locked round", { roundStatus: "ballots_locked" }],
    ["a heat from another round", { inRound: false }],
  ])("refuses %s server-side without calling the RPC", async (_name, over) => {
    setup(over);
    const result = await run({ roundId: ROUND, heatId: HEAT, returnTo: RETURN });
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toContain("error=");
  });

  it("refuses a malformed heat id without calling the RPC", async () => {
    const result = await run({ heatId: "nope", returnTo: RETURN });
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toContain("error=");
  });

  it("falls back to a safe return path", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await run({ roundId: ROUND, heatId: HEAT, returnTo: "https://evil.example/x" });
    expect(result).toContain("REDIRECT:/app/events?");
  });
});

describe("HL1 heatLockErrorMessage", () => {
  it("maps the known refusals", () => {
    expect(heatLockErrorMessage("Heat was not found or cannot be managed.")).toMatch(/not allowed/);
    expect(heatLockErrorMessage("Certified heats require a formal correction workflow")).toMatch(/certified/);
    expect(heatLockErrorMessage("COMPO1_HEAT_LOCKED: heat 3")).toMatch(/locked/);
  });
  it("never swallows an unknown error", () => {
    expect(heatLockErrorMessage("boom")).toContain("boom");
    expect(heatLockErrorMessage("COMPO1_SOMETHING: x")).toContain("COMPO1_SOMETHING");
  });
});
