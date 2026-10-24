import { describe, expect, it } from "vitest";
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
