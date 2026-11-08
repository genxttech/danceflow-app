import { describe, expect, it, vi } from "vitest";
import {
  buildDayOfFloorHeats,
  canCancelRound,
  canOfferHeatAction,
  floorHeatState,
  floorPosition,
  friendlyDayOfError,
  nextHeatAction,
  nextRoundAction,
  scratchHref,
  startCompetitionRound,
} from "@/lib/competition/dayOf";
import { activeNavKey, competitionNav } from "@/lib/competition/workspaceNav";

const heat = (id: string, floorHeatId: string, roundId: string, status: string, lockState = "open") => ({ id, floorHeatId, roundId, status, lockState });

describe("floorHeatState", () => {
  it("is the shared status or mixed", () => {
    expect(floorHeatState(["active", "active"])).toBe("active");
    expect(floorHeatState(["active", "staging"])).toBe("mixed");
    expect(floorHeatState(["draft"])).toBe("mixed");
  });
});

describe("running order", () => {
  const floors = [{ id: "f2", heat_number: 2 }, { id: "f1", heat_number: 1 }, { id: "f3", heat_number: 3 }];
  const heats = [heat("a", "f1", "r1", "complete"), heat("b", "f2", "r1", "active"), heat("c", "f3", "r2", "scheduled")];
  const built = buildDayOfFloorHeats(floors, heats);

  it("sorts by heat number and derives state", () => {
    expect(built.map((item) => [item.number, item.state])).toEqual([[1, "complete"], [2, "active"], [3, "scheduled"]]);
  });
  it("picks current and next", () => {
    const { current, next } = floorPosition(built);
    expect(current?.number).toBe(2);
    expect(next?.number).toBe(3);
  });
  it("with nothing on the floor, next is the first waiting heat", () => {
    const { current, next } = floorPosition(buildDayOfFloorHeats(floors, [heat("a", "f1", "r1", "complete"), heat("c", "f3", "r2", "scheduled")]));
    expect(current).toBeNull();
    expect(next?.number).toBe(3);
  });
  it("a staging heat counts as current", () => {
    const { current } = floorPosition(buildDayOfFloorHeats(floors, [heat("a", "f1", "r1", "staging")]));
    expect(current?.number).toBe(1);
  });
  it("a floor heat with no scoring heats is flagged", () => {
    expect(buildDayOfFloorHeats([{ id: "x", heat_number: 1 }], [])[0].state).toBe("mixed");
  });
});

describe("heat actions", () => {
  it("follows scheduled -> staging -> active -> complete", () => {
    expect(nextHeatAction("scheduled")?.to).toBe("staging");
    expect(nextHeatAction("staging")?.to).toBe("active");
    expect(nextHeatAction("active")?.to).toBe("complete");
    expect(nextHeatAction("complete")).toBeNull();
    expect(nextHeatAction("mixed")).toBeNull();
  });
  it("is only offered when every round is running and nothing is locked", () => {
    const [h] = buildDayOfFloorHeats([{ id: "f", heat_number: 1 }], [heat("a", "f", "r1", "scheduled")]);
    expect(canOfferHeatAction(h, new Map([["r1", "active"]])).allowed).toBe(true);
    expect(canOfferHeatAction(h, new Map([["r1", "scheduled"]])).allowed).toBe(false);
    const [locked] = buildDayOfFloorHeats([{ id: "f", heat_number: 1 }], [heat("a", "f", "r1", "scheduled", "locked")]);
    expect(canOfferHeatAction(locked, new Map([["r1", "active"]])).allowed).toBe(false);
  });
});

describe("round actions", () => {
  it("schedule then start", () => {
    expect(nextRoundAction("draft")?.kind).toBe("schedule");
    expect(nextRoundAction("scheduled")?.kind).toBe("start");
    expect(nextRoundAction("active")).toBeNull();
  });
  it("cancel is offered only for non-terminal, unpublished rounds", () => {
    expect(canCancelRound("draft")).toBe(true);
    expect(canCancelRound("active")).toBe(true);
    expect(canCancelRound("published")).toBe(false);
    expect(canCancelRound("complete")).toBe(false);
    expect(canCancelRound("cancelled")).toBe(false);
  });
});

describe("messages and links", () => {
  it("shows the database reason without the code or context", () => {
    expect(friendlyDayOfError({ message: "COMPO1_PANEL_NOT_READY: assign the officials panel before starting the round." })).toBe(
      "assign the officials panel before starting the round.",
    );
  });
  it("never leaks a raw error", () => {
    expect(friendlyDayOfError({ message: "duplicate key value violates unique constraint foo" })).toBe("That change could not be saved. Refresh and try again.");
  });
  it("links to SC1 and does not own scratching", () => {
    expect(scratchHref("e1", "n1")).toBe("/app/events/e1/competition/registrations/scratch/n1");
  });
});

describe("workspace nav", () => {
  it("adds one Day-of entry", () => {
    const items = competitionNav("e1");
    expect(items.filter((item) => item.key === "day_of")).toEqual([{ key: "day_of", label: "Day-of", href: "/app/events/e1/competition/day-of", available: true }]);
    expect(activeNavKey("e1", "/app/events/e1/competition/day-of")).toBe("day_of");
  });
});

describe("CF1 B2: Final start retry and messages", () => {
  const ok = { data: null, error: null };
  const err = (code: string | null, message: string) => ({ data: null, error: { code, message } });

  it.each(["40P01", "55P03", "57014"])("retries once on %s with the same arguments and request id", async (code) => {
    const rpc = vi.fn().mockResolvedValueOnce(err(code, "x")).mockResolvedValueOnce(ok);
    const result = await startCompetitionRound(rpc, "round-1", "req-1");
    expect(result).toBe(ok);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(["start_competition_round", { p_round_id: "round-1", p_request_id: "req-1" }]);
    expect(rpc.mock.calls[1]).toEqual(rpc.mock.calls[0]);
  });
  it("retries only once when the second answer is also retryable", async () => {
    const rpc = vi.fn().mockResolvedValue(err("40P01", "deadlock detected"));
    const result = await startCompetitionRound(rpc, "r", "q");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(friendlyDayOfError(result.error)).toMatch(/Nothing was saved/);
  });
  it("does not retry permanent errors", async () => {
    for (const e of [err("P0001", "COMP_ADVANCEMENT_NOT_APPLIED"), err("P0001", "COMPO1_PANEL_NOT_READY: assign the panel."), err("23505", "duplicate key")]) {
      const rpc = vi.fn().mockResolvedValue(e);
      await startCompetitionRound(rpc, "r", "q");
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  });
  it("does not retry a success", async () => {
    const rpc = vi.fn().mockResolvedValue(ok);
    await startCompetitionRound(rpc, "r", "q");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it("maps CF1 codes to friendly copy", () => {
    expect(friendlyDayOfError({ message: "COMP_ADVANCEMENT_NOT_APPLIED" })).toBe("Advance the callback couples to this Final before starting it.");
    expect(friendlyDayOfError({ code: "P0001", message: "COMP_ADVANCEMENT_ROSTER_STALE: detail" })).toMatch(/no longer eligible/);
    expect(friendlyDayOfError({ message: "COMP_ADVANCEMENT_ROSTER_INCOMPLETE" })).toMatch(/withdrawal/);
    expect(friendlyDayOfError({ message: "COMP_ROSTER_ENTRY_UNAVAILABLE" })).toMatch(/no longer eligible/);
    expect(friendlyDayOfError({ message: "COMP_ROSTER_BELOW_MINIMUM" })).toMatch(/at least two/);
    expect(friendlyDayOfError({ message: "COMP_CALLBACK_TARGET_BELOW_MINIMUM" })).toMatch(/2 or more/);
    expect(friendlyDayOfError({ code: "40P01", message: "deadlock detected" })).toMatch(/Nothing was saved/);
  });
  it("keeps COMPO1_ and unknown behaviour unchanged", () => {
    expect(friendlyDayOfError({ message: "COMPO1_RUN_IN_PROGRESS: heats started." })).toBe("heats started.");
    expect(friendlyDayOfError({ message: "COMP10D_SCHEDULE_PUBLISHED" })).toBe("The running order cannot change once heats have started.");
    expect(friendlyDayOfError({ message: "COMP_UNKNOWN_THING" })).toBe("That change could not be saved. Refresh and try again.");
    expect(friendlyDayOfError(null)).toBe("That change could not be saved. Refresh and try again.");
  });
});
