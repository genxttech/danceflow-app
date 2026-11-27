import { describe, expect, it } from "vitest";
import {
  exceptionScopes,
  mayWithdrawAutomatically,
  netRefundableCaps,
  participationClass,
  refundedCents,
  remainingRefundableCents,
  roundPublicationBlocked,
  splitByLargestRemainder,
  type Placement,
  type RefundableLine,
} from "@/lib/payments/competitionRefundRules";

const entry = (id: string, grossCents: number, sortOrder: number, scopeKeys: string[] = []): RefundableLine => ({
  id, kind: "entry", grossCents, sortOrder, scopeKeys,
});
const fee = (id: string, grossCents: number, sortOrder: number): RefundableLine => ({ id, kind: "fee", grossCents, sortOrder });
const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

describe("D1/D2 net refundable caps (PROVISIONAL)", () => {
  it("without discounts the cap is the gross line amount", () => {
    const caps = netRefundableCaps([entry("e1", 2500, 1), fee("f1", 500, 9)], []);
    expect(Object.fromEntries(caps)).toEqual({ e1: 2500, f1: 500 });
  });

  it("an unscoped discount is split across entries and fee lines; caps sum to the captured amount", () => {
    const lines = [entry("e1", 2500, 1), entry("e2", 2500, 2), entry("e3", 2500, 3), fee("f1", 1000, 9)];
    const caps = netRefundableCaps(lines, [{ id: "d1", amountCents: 1000 }]);
    expect(sum(caps)).toBe(8500 - 1000);
    expect(Object.fromEntries(caps)).toEqual({ e1: 2206, e2: 2206, e3: 2206, f1: 882 });
  });

  it("largest remainder ties go to the earlier sort order, then the smaller id", () => {
    const shares = splitByLargestRemainder(100, [entry("b", 1000, 1), entry("a", 1000, 1), entry("c", 1000, 2)]);
    expect(Object.fromEntries(shares)).toEqual({ a: 34, b: 33, c: 33 });
  });

  it("is deterministic regardless of input order", () => {
    const lines = [entry("e1", 1999, 1), entry("e2", 3001, 2), fee("f1", 700, 3)];
    const a = netRefundableCaps(lines, [{ id: "d1", amountCents: 777 }]);
    const b = netRefundableCaps([...lines].reverse(), [{ id: "d1", amountCents: 777 }]);
    expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    expect(sum(a)).toBe(1999 + 3001 + 700 - 777);
  });

  it("R2 SQL parity: four 25.00 entries + 10.00 fee, 10.00 unscoped discount (same numbers as the SQL suite)", () => {
    const lines = [entry("e1", 2500, 1), entry("e2", 2500, 2), entry("e3", 2500, 3), entry("e4", 2500, 4), fee("f1", 1000, 1000000)];
    const caps = netRefundableCaps(lines, [{ id: "d1", amountCents: 1000 }]);
    expect(Object.fromEntries(caps)).toEqual({ e1: 2272, e2: 2273, e3: 2273, e4: 2273, f1: 909 });
    expect(sum(caps)).toBe(10000);
  });

  it("a scoped discount must match every scope key (program AND division)", () => {
    const lines = [entry("e1", 1000, 1, ["prog", "div-a"]), entry("e2", 1000, 2, ["prog", "div-b"])];
    const caps = netRefundableCaps(lines, [{ id: "d1", amountCents: 100, scopeKeys: ["prog", "div-a"] }]);
    expect(Object.fromEntries(caps)).toEqual({ e1: 900, e2: 1000 });
  });

  it("a scoped discount reduces only the matching entries, never fee lines", () => {
    const lines = [entry("e1", 3000, 1, ["div-a"]), entry("e2", 3000, 2, ["div-b"]), fee("f1", 1000, 9)];
    const caps = netRefundableCaps(lines, [{ id: "d1", amountCents: 600, scopeKeys: ["div-a"] }]);
    expect(Object.fromEntries(caps)).toEqual({ e1: 2400, e2: 3000, f1: 1000 });
  });

  it("several discounts never drive a cap negative and still sum to the captured amount", () => {
    const lines = [entry("e1", 100, 1), entry("e2", 900, 2)];
    const caps = netRefundableCaps(lines, [{ id: "d1", amountCents: 500 }, { id: "d2", amountCents: 499 }]);
    expect(sum(caps)).toBe(1);
    for (const cap of caps.values()) expect(cap).toBeGreaterThanOrEqual(0);
  });

  it("refuses a discount larger than its lines and non-integer cents", () => {
    expect(() => netRefundableCaps([entry("e1", 100, 1)], [{ id: "d1", amountCents: 101 }])).toThrow();
    expect(() => netRefundableCaps([entry("e1", 10.5, 1)], [])).toThrow();
    expect(() => netRefundableCaps([entry("e1", 1, 1), entry("e1", 1, 2)], [])).toThrow(/Duplicate/);
  });
});

describe("cap holding vs money returned (REFUND-RECON-1)", () => {
  const allocations = [
    { amountCents: 500, refundStatus: "requested" },
    { amountCents: 300, refundStatus: "pending" },
    { amountCents: 200, refundStatus: "succeeded" },
    { amountCents: 900, refundStatus: "failed" },
    { amountCents: 900, refundStatus: "canceled" },
  ];

  it("in-flight and succeeded refunds hold the cap; failed and canceled release it", () => {
    expect(remainingRefundableCents(2000, allocations)).toBe(1000);
  });

  it("only succeeded refunds count as refunded money", () => {
    expect(refundedCents(allocations)).toBe(200);
  });

  it("the remaining cap never goes below zero", () => {
    expect(remainingRefundableCents(100, allocations)).toBe(0);
  });
});

const placement = (over: Partial<Placement>): Placement => ({
  heatId: "h1", roundId: "r1", lockState: "open", status: "scheduled", ...over,
});

describe("participation class (§4.1 P; Q1 decided)", () => {
  it("unplaced and open-heat entries may be withdrawn automatically", () => {
    expect(participationClass([])).toBe("unplaced");
    expect(mayWithdrawAutomatically([])).toBe(true);
    expect(mayWithdrawAutomatically([placement({ status: "checked_in" })])).toBe(true);
  });

  it("Q1: a danced placement in an unlocked heat counts as locked", () => {
    expect(participationClass([placement({ status: "danced" })])).toBe("locked");
    expect(mayWithdrawAutomatically([placement({ status: "danced" })])).toBe(false);
  });

  it("SC1 rule: an unscratched placement in a heat on the floor (active / complete) counts as danced", () => {
    expect(participationClass([placement({ heatStatus: "active" })])).toBe("locked");
    expect(participationClass([placement({ heatStatus: "complete", status: "checked_in" })])).toBe("locked");
    expect(participationClass([placement({ heatStatus: "active", status: "scratched" })])).toBe("open");
    expect(participationClass([placement({ heatStatus: "scheduled" })])).toBe("open");
    expect(mayWithdrawAutomatically([placement({ heatStatus: "active" })])).toBe(false);
  });

  it("the most restrictive placement wins (certified > locked > open)", () => {
    const mixed = [placement({ heatId: "h1" }), placement({ heatId: "h2", lockState: "locked" })];
    expect(participationClass(mixed)).toBe("locked");
    expect(participationClass([...mixed, placement({ heatId: "h3", lockState: "certified" })])).toBe("certified");
  });
});

describe("Q2 exception scopes and the K0 publish precondition", () => {
  const placements = [
    placement({ heatId: "h-open", roundId: "r-open" }),
    placement({ heatId: "h-locked", roundId: "r-locked", lockState: "locked" }),
    placement({ heatId: "h-danced", roundId: "r-danced", status: "danced" }),
  ];

  it("E-L scopes every locked or danced heat, never open ones, and is competitive", () => {
    const scopes = exceptionScopes("competition_refund_entry_locked_heat", "e1", placements);
    expect(scopes.map((s) => s.roundId).sort()).toEqual(["r-danced", "r-locked"]);
    expect(scopes.every((s) => s.competitiveEffect)).toBe(true);
  });

  it("E-C scopes only certified heats and refuses an uncertified entry", () => {
    const certified = [...placements, placement({ heatId: "h-cert", roundId: "r-cert", lockState: "certified" })];
    expect(exceptionScopes("competition_refund_entry_certified_heat", "e1", certified).map((s) => s.roundId)).toEqual(["r-cert"]);
    expect(() => exceptionScopes("competition_refund_entry_certified_heat", "e1", placements)).toThrow();
    expect(() => exceptionScopes("competition_refund_entry_locked_heat", "e1", [placement({})])).toThrow();
  });

  it("unattributed / reversed refunds are financial-only unless the entry is held in a locked or danced heat", () => {
    expect(exceptionScopes("competition_refund_unattributed", "e1", [placement({})])).toEqual([]);
    expect(exceptionScopes("competition_refund_reversed", "e1", [])).toEqual([]);
    expect(exceptionScopes("competition_refund_unattributed", "e1", placements).map((s) => s.roundId).sort()).toEqual(["r-danced", "r-locked"]);
  });

  it("an unresolved competitive scope blocks only its own round", () => {
    const scopes = exceptionScopes("competition_refund_entry_locked_heat", "e1", placements).map((s) => ({ ...s, resolvedAt: null }));
    expect(roundPublicationBlocked("r-locked", scopes)).toBe(true);
    expect(roundPublicationBlocked("r-open", scopes)).toBe(false);
    expect(roundPublicationBlocked("r-other", scopes)).toBe(false);
  });

  it("a resolved scope no longer blocks", () => {
    const scopes = exceptionScopes("competition_refund_entry_locked_heat", "e1", placements).map((s) => ({ ...s, resolvedAt: "2026-10-23T00:00:00Z" }));
    expect(roundPublicationBlocked("r-locked", scopes)).toBe(false);
  });
});
