import { describe, expect, it } from "vitest";
import {
  isMembershipFundingEligibleForEnrollment,
  type MembershipFundingDisplay,
} from "../groupClassMembershipFunding";

/**
 * PR #70 review correction (item 3): the Add Student eligibility list must
 * not treat an exhausted finite group-class membership as a usable funding
 * source -- offering it would let it be auto-preselected (or chosen from
 * the multi-source picker) only to be rejected by GC-2c at submission time.
 * Unlimited always remains eligible; unresolved (no applicable benefit at
 * all) never does.
 */
describe("isMembershipFundingEligibleForEnrollment", () => {
  it("treats unlimited as always eligible", () => {
    const funding: MembershipFundingDisplay = { kind: "unlimited", membershipName: "Unlimited Plan" };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(true);
  });

  it("treats a finite membership with remaining balance as eligible", () => {
    const funding: MembershipFundingDisplay = {
      kind: "finite",
      membershipName: "Finite Plan",
      quantity: 8,
      usedInPeriod: 3,
    };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(true);
  });

  it("treats a fully-exhausted finite membership (used == quantity) as NOT eligible", () => {
    const funding: MembershipFundingDisplay = {
      kind: "finite",
      membershipName: "Finite Plan",
      quantity: 8,
      usedInPeriod: 8,
    };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(false);
  });

  it("treats an over-consumed finite membership (used > quantity) as NOT eligible", () => {
    const funding: MembershipFundingDisplay = {
      kind: "finite",
      membershipName: "Finite Plan",
      quantity: 8,
      usedInPeriod: 9,
    };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(false);
  });

  it("treats a finite membership with a null quantity (data anomaly) as NOT eligible", () => {
    const funding: MembershipFundingDisplay = {
      kind: "finite",
      membershipName: "Finite Plan",
      quantity: null,
      usedInPeriod: 0,
    };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(false);
  });

  it("treats unresolved (no applicable benefit) as never eligible", () => {
    const funding: MembershipFundingDisplay = { kind: "unresolved", membershipName: "No Benefit Plan" };
    expect(isMembershipFundingEligibleForEnrollment(funding)).toBe(false);
  });
});
