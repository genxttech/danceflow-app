import { beforeEach, describe, expect, it, vi } from "vitest";
import { ballotErrorMessage } from "../messages";
import { canLockHeat, canReopenHeat, heatIsDanced, heatLockErrorMessage, lockHeatConfirm, lockHeatHint, lockHeatKind, reopenHeatConfirm } from "../heatLock";

const HEAT = "11111111-1111-4111-8111-111111111111";
const ROUND = "22222222-2222-4222-8222-222222222222";
const rpc = vi.fn();
const state: { board: unknown; heat: unknown; danced: unknown[] } = { board: null, heat: null, danced: [] };
type Over = { role?: string; roundStatus?: string; heatStatus?: string; lockState?: string; inRound?: boolean; danced?: boolean };
function setup(over: Over = {}) {
  state.board = { viewer_role: over.role ?? "manager", round: { status: over.roundStatus ?? "active" }, heats: over.inRound === false ? [] : [{ heat_id: HEAT, heat_number: 4 }] };
  state.heat = { status: over.heatStatus ?? "complete", lock_state: over.lockState ?? "open" };
  state.danced = over.danced ? [{ id: "x" }] : [];
}
const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    rpc: (name: string, args: unknown) => (name === "competition_round_ballot_status" ? Promise.resolve({ data: state.board, error: null }) : rpc(name, args)),
    from: (table: string) =>
      table === "event_competition_heats"
        ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.heat }) }) }) }
        : { select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: state.danced }) }) }) }) },
  }),
}));

const RETURN = "/app/events/e1/competition/ballots/r1";
const roles = ["manager", "chair", "scorer", "judge", ""];
const roundStatuses = ["draft", "scheduled", "active", "ballots_locked", "calculated", "approved", "complete", "cancelled"];
const heatStatuses = ["scheduled", "staging", "active", "complete", "cancelled", null, undefined];
const lockStates = ["open", "locked", "certified"];

type Facts = { viewerRole: string; roundStatus: string; heatStatus: string | null | undefined; lockState: string; hasDancedEntry: boolean };
function matrix(fn: (i: Facts) => boolean) {
  const out: string[] = [];
  for (const viewerRole of roles)
    for (const roundStatus of roundStatuses)
      for (const heatStatus of heatStatuses)
        for (const lockState of lockStates)
          for (const hasDancedEntry of [false, true]) if (fn({ viewerRole, roundStatus, heatStatus, lockState, hasDancedEntry })) out.push([viewerRole, roundStatus, heatStatus, lockState, hasDancedEntry].join("/"));
  return out;
}

describe("HL1 visibility", () => {
  it("Lock heat: manager only, open heat, danced path or early path", () => {
    expect(matrix(canLockHeat).sort()).toEqual(
      [
        "manager/active/complete/open/false",
        "manager/active/complete/open/true",
        "manager/scheduled/scheduled/open/false",
        "manager/scheduled/staging/open/false",
        "manager/active/scheduled/open/false",
        "manager/active/staging/open/false",
      ].sort(),
    );
  });

  it("names the kind: danced path unchanged, early only when not danced", () => {
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "active", heatStatus: "complete", lockState: "open" })).toBe("danced");
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "scheduled", heatStatus: "scheduled", lockState: "open" })).toBe("early");
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "active", heatStatus: "staging", lockState: "open", hasDancedEntry: true })).toBeNull();
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "active", heatStatus: "active", lockState: "open" })).toBeNull();
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "active", heatStatus: "cancelled", lockState: "open" })).toBeNull();
    expect(lockHeatKind({ viewerRole: "manager", roundStatus: "active", heatStatus: undefined, lockState: "open" })).toBeNull();
  });

  it("Reopen heat: manager, locked, undanced, round scheduled or active only", () => {
    expect(matrix(canReopenHeat).sort()).toEqual(
      [
        "manager/scheduled/scheduled/locked/false",
        "manager/scheduled/staging/locked/false",
        "manager/active/scheduled/locked/false",
        "manager/active/staging/locked/false",
      ].sort(),
    );
  });

  it("never reopens once ballots are locked or later, certified, danced or cancelled", () => {
    const base = { viewerRole: "manager", heatStatus: "scheduled", lockState: "locked" };
    for (const roundStatus of ["ballots_locked", "calculated", "approved", "published", "complete", "cancelled"]) expect(canReopenHeat({ ...base, roundStatus })).toBe(false);
    expect(canReopenHeat({ ...base, roundStatus: "active", lockState: "certified" })).toBe(false);
    expect(canReopenHeat({ ...base, roundStatus: "active", heatStatus: "complete" })).toBe(false);
    expect(canReopenHeat({ ...base, roundStatus: "active", hasDancedEntry: true })).toBe(false);
  });

  it("uses the SC1 danced rule", () => {
    expect(heatIsDanced("scheduled")).toBe(false);
    expect(heatIsDanced("staging")).toBe(false);
    expect(heatIsDanced("active")).toBe(true);
    expect(heatIsDanced("complete")).toBe(true);
    expect(heatIsDanced("scheduled", true)).toBe(true);
    expect(heatIsDanced(null)).toBe(true);
  });

  it("hints", () => {
    const f = { viewerRole: "manager", roundStatus: "active" };
    expect(lockHeatHint({ ...f, heatStatus: "cancelled", lockState: "open" })).toBe("Cancelled");
    expect(lockHeatHint({ ...f, heatStatus: "active", lockState: "open" })).toBe("On the floor");
    expect(lockHeatHint({ ...f, heatStatus: "complete", lockState: "open" })).toBeNull();
    expect(lockHeatHint({ ...f, heatStatus: "complete", lockState: "locked" })).toBeNull();
    expect(lockHeatHint({ ...f, heatStatus: "complete", lockState: "certified" })).toBe("Certified");
  });

  it("confirm texts", () => {
    expect(lockHeatConfirm(3)).toBe("Lock heat 3? Floor changes to this heat will be refused once locked.");
    expect(lockHeatConfirm(3, "early")).toBe("Lock heat 3? It has not been danced. The floor can't start or change it until it is reopened. Officials can still scratch entries with a reason.");
    expect(reopenHeatConfirm(3)).toContain("Reopen heat 3?");
  });
});

describe("HL1 server actions", () => {
  beforeEach(() => {
    rpc.mockReset();
    redirect.mockClear();
    setup();
  });

  async function run(which: "lockHeatAction" | "reopenHeatAction", fields: Record<string, string>) {
    const actions = await import("../../../../app/app/events/[id]/competition/ballots/actions");
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return actions[which](form).then(
      () => "no redirect",
      (error: Error) => error.message,
    );
  }
  const base = { roundId: ROUND, heatId: HEAT, heatNumber: "4", returnTo: RETURN };
  const decoded = (value: string) => decodeURIComponent(value.replace(/\+/g, " "));

  it("lock: calls the RPC with locked and the note (danced heat)", async () => {
    rpc.mockResolvedValue({ error: null });
    const result = await run("lockHeatAction", { ...base, reason: " floor done " });
    expect(rpc).toHaveBeenCalledWith("set_competition_heat_lock_state", { selected_heat_id: HEAT, selected_state: "locked", selected_reason: "floor done" });
    expect(result).toContain("saved=Heat+4+locked.");
  });

  it("lock: early lock of an undanced heat in a scheduled round works, null reason without a note", async () => {
    setup({ roundStatus: "scheduled", heatStatus: "scheduled" });
    rpc.mockResolvedValue({ error: null });
    await run("lockHeatAction", base);
    expect(rpc).toHaveBeenCalledWith("set_competition_heat_lock_state", { selected_heat_id: HEAT, selected_state: "locked", selected_reason: null });
  });

  it.each<[string, Over]>([
    ["a chair", { role: "chair" }],
    ["a scorer", { role: "scorer" }],
    ["a heat on the floor", { heatStatus: "active" }],
    ["a cancelled heat", { heatStatus: "cancelled" }],
    ["an already locked heat", { lockState: "locked" }],
    ["a ballots-locked round", { roundStatus: "ballots_locked", heatStatus: "scheduled" }],
    ["an undanced heat with a danced entry", { heatStatus: "staging", danced: true }],
    ["a heat from another round", { inRound: false }],
  ])("lock refuses %s without calling the RPC", async (_n, over) => {
    setup(over);
    const result = await run("lockHeatAction", base);
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toContain("error=");
  });

  it("lock shows RPC refusals and never reports success", async () => {
    rpc.mockResolvedValue({ error: { message: "Heat was not found or cannot be managed." } });
    const result = await run("lockHeatAction", base);
    expect(result).not.toContain("saved=");
    expect(decoded(result)).toContain("not allowed to manage");
  });

  it("lock refuses a malformed heat id and an unsafe return path falls back", async () => {
    expect(await run("lockHeatAction", { ...base, heatId: "nope" })).toContain("error=");
    expect(rpc).not.toHaveBeenCalled();
    rpc.mockResolvedValue({ error: null });
    expect(await run("lockHeatAction", { ...base, returnTo: "https://evil.example/x" })).toContain("REDIRECT:/app/events?");
  });

  it("reopen: calls the RPC with open and the reason", async () => {
    setup({ roundStatus: "active", heatStatus: "scheduled", lockState: "locked" });
    rpc.mockResolvedValue({ error: null });
    const result = await run("reopenHeatAction", { ...base, reason: " locked by mistake " });
    expect(rpc).toHaveBeenCalledWith("set_competition_heat_lock_state", { selected_heat_id: HEAT, selected_state: "open", selected_reason: "locked by mistake" });
    expect(result).toContain("saved=Heat+4+reopened.");
  });

  it("reopen requires a reason and does not call the RPC without one", async () => {
    setup({ heatStatus: "scheduled", lockState: "locked" });
    const result = await run("reopenHeatAction", { ...base, reason: "   " });
    expect(rpc).not.toHaveBeenCalled();
    expect(decoded(result)).toContain("A reason is required");
  });

  it.each<[string, Over]>([
    ["a scorer", { role: "scorer", lockState: "locked", heatStatus: "scheduled" }],
    ["a chair", { role: "chair", lockState: "locked", heatStatus: "scheduled" }],
    ["a certified heat", { lockState: "certified", heatStatus: "complete" }],
    ["an open heat", { lockState: "open", heatStatus: "scheduled" }],
    ["a danced heat", { lockState: "locked", heatStatus: "complete" }],
    ["a ballots-locked round", { roundStatus: "ballots_locked", lockState: "locked", heatStatus: "scheduled" }],
    ["a calculated round", { roundStatus: "calculated", lockState: "locked", heatStatus: "scheduled" }],
    ["a heat from another round", { inRound: false, lockState: "locked", heatStatus: "scheduled" }],
  ])("reopen refuses %s without calling the RPC", async (_n, over) => {
    setup(over);
    const result = await run("reopenHeatAction", { ...base, reason: "because" });
    expect(rpc).not.toHaveBeenCalled();
    expect(result).toContain("error=");
  });

  it("reopen shows RPC refusals", async () => {
    setup({ heatStatus: "scheduled", lockState: "locked" });
    rpc.mockResolvedValue({ error: { message: "Certified heats require a formal correction workflow and cannot be reopened directly." } });
    const result = await run("reopenHeatAction", { ...base, reason: "x" });
    expect(result).not.toContain("saved=");
    expect(decoded(result)).toContain("certified");
  });
});

describe("HL1 heatLockErrorMessage", () => {
  it("maps the known refusals", () => {
    expect(heatLockErrorMessage("Heat was not found or cannot be managed.")).toMatch(/not allowed/);
    expect(heatLockErrorMessage("Certified heats require a formal correction workflow")).toMatch(/certified/);
    expect(heatLockErrorMessage("COMPO1_HEAT_LOCKED: heat 3")).toMatch(/locked/);
    expect(heatLockErrorMessage("A reason is required to reopen a locked heat.")).toMatch(/reason/);
  });
  it("maps the HL1 database guards", () => {
    expect(heatLockErrorMessage("COMP_HL1_LOCK_ACTIVE: x")).toMatch(/on the floor/);
    expect(heatLockErrorMessage("COMP_HL1_ALREADY_LOCKED: x")).toMatch(/already locked/);
    expect(heatLockErrorMessage("COMP_HL1_REOPEN_ROUND_LOCKED: x", "reopened")).toMatch(/ballots are locked/);
    expect(heatLockErrorMessage("COMP_HL1_REOPEN_DANCED: x", "reopened")).toMatch(/danced/);
    expect(ballotErrorMessage("COMP_HL1_HEAT_NOT_DANCED: x")).toMatch(/must be danced/);
  });
  it("never swallows an unknown error", () => {
    expect(heatLockErrorMessage("boom", "reopened")).toContain("reopened: boom");
    expect(heatLockErrorMessage("COMPO1_SOMETHING: x")).toContain("COMPO1_SOMETHING");
  });
});
