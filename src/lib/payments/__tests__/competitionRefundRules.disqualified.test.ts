import { describe, expect, it } from "vitest";
import { mayWithdrawAutomatically, participationClass, type Placement } from "@/lib/payments/competitionRefundRules";

// As _r2_entry_participation_class: a disqualified placement is locked even while its heat is open and not yet run.
describe("refund participation class: disqualified placement", () => {
  const placement: Placement = { heatId: "h", roundId: "r", lockState: "open", status: "disqualified", heatStatus: "scheduled" };
  it("is locked, so a refund neither withdraws the entry nor pre-selects a scratch", () => {
    expect(participationClass([placement])).toBe("locked");
    expect(mayWithdrawAutomatically([placement])).toBe(false);
    expect(participationClass([{ ...placement, status: "scheduled" }])).toBe("open");
  });
});
