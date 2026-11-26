import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_CRITERIA,
  PERMITTED_WAIVER_CATEGORIES,
  PROHIBITED_OVERRIDE_SUBJECTS,
  STUDIO_ELIGIBILITY_DISCLOSURE,
  evaluateEntryOperationalGate,
  requiredCriteria,
  validateEligibilityDecision,
  type EligibilityCriterion,
} from "../eligibilityGate";

const NOW = new Date("2026-11-23T12:00:00Z");
const ADULT = "1990-01-01";
const MINOR = "2012-01-01";

const open = { ageLabel: null, skillLabel: null, participantRoles: ["dancer", "dancer"] };
const entry = (over: Partial<Parameters<typeof evaluateEntryOperationalGate>[0]> = {}) => ({
  status: "confirmed", eligibilityStatus: "eligible", ...open, clearance: "cleared" as const, participantDobs: [ADULT, ADULT], ...over,
});

describe("OD-18 per-division applicability (no checks for divisions that do not use the classification)", () => {
  it("requires nothing for a Studio/Custom division with no age label, no skill label and no pro/am participants", () => {
    expect(requiredCriteria({ ...open })).toEqual([]);
    expect(evaluateEntryOperationalGate(entry(), NOW).ready).toBe(true);
  });
  it("requires exactly the criteria the division and participants use", () => {
    expect(requiredCriteria({ ...open, skillLabel: "Novice" })).toEqual(["level"]);
    expect(requiredCriteria({ ...open, ageLabel: "Masters" })).toEqual(["age_division"]);
    expect(requiredCriteria({ ...open, participantRoles: ["professional", "student"] })).toEqual(["status"]);
    expect(requiredCriteria({ ageLabel: "Senior I", skillLabel: "Gold", participantRoles: ["professional", "student"] })).toEqual(["age_division", "status", "level"]);
    expect(requiredCriteria({ ...open, skillLabel: "All Levels" })).toEqual([]);
  });
  it("an unknown label fails closed (counts as a classification)", () => {
    expect(requiredCriteria({ ...open, skillLabel: "???" })).toEqual(["level"]);
  });
});

describe("OD-18 organizer determination: the database decides whether it still covers the entry", () => {
  const classified = { ageLabel: "Senior I", skillLabel: "Gold", participantRoles: ["professional", "student"] };
  it("a classified entry is ready only while the database reports it cleared (missing, outdated or insufficient determinations are not cleared there)", () => {
    expect(evaluateEntryOperationalGate(entry(classified), NOW).ready).toBe(true);
    for (const clearance of ["provisional", "blocked", "unavailable"] as const) {
      expect(evaluateEntryOperationalGate(entry({ ...classified, clearance }), NOW).ready).toBe(false);
    }
  });
  it("a missing division fails closed", () => {
    expect(evaluateEntryOperationalGate(entry({ divisionFound: false }), NOW).reasons).toContain("division_not_found");
  });
});

describe("OD-18 gate matrix: independent dimensions with no conflicting gates", () => {
  it("under-18 + eligible status + cleared answer stays blocked (OD-02 absolute)", () => {
    expect(evaluateEntryOperationalGate(entry({ participantDobs: [ADULT, MINOR] }), NOW).reasons).toEqual(["adult_not_verified"]);
  });
  it("under-18 + waived status stays blocked, and the waiver does not clear an age block", () => {
    expect(evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived", participantDobs: [MINOR] }), NOW).ready).toBe(false);
  });
  it("a waived status does not clear a level, status or age requirement", () => {
    for (const over of [{ skillLabel: "Novice" }, { participantRoles: ["professional", "student"] }, { ageLabel: "Masters" }]) {
      expect(evaluateEntryOperationalGate(entry({ ...over, eligibilityStatus: "waived" }), NOW).reasons).toContain("waiver_not_allowed_for_classified_division");
    }
  });
  it("an adult open-division entry with a waiver the database cleared is ready; an uncleared one is not", () => {
    expect(evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived" }), NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived", clearance: "provisional" }), NOW).reasons).toEqual(["clearance_not_recorded"]);
  });
  it("combination sweep: ready only when the participants are adults and the database reports the entry cleared", () => {
    for (const adult of [true, false]) for (const level of [null, "Novice"]) for (const clearance of ["cleared", "provisional"] as const) {
      const result = evaluateEntryOperationalGate(entry({ skillLabel: level, clearance, participantDobs: adult ? [ADULT] : [MINOR] }), NOW);
      expect(result.ready).toBe(adult && clearance === "cleared");
    }
  });
});

describe("OD-18 waiver vs override categories (legitimate event-policy exceptions vs prohibited eligibility overrides)", () => {
  const waive = (reasonCode: string, required: EligibilityCriterion[] = [], participantsAdult = true) =>
    validateEligibilityDecision({ outcome: "waived", reasonCode, required, verifiedCriteria: [], participantsAdult });

  it("permits waivers only for the three event-policy categories", () => {
    expect([...PERMITTED_WAIVER_CATEGORIES].sort()).toEqual(["waiver_event_policy_documents", "waiver_event_policy_fee", "waiver_event_policy_scheduling"]);
    for (const category of PERMITTED_WAIVER_CATEGORIES) expect(waive(category)).toBeNull();
  });
  it("refuses a waiver carrying any non-waiver reason (age, status, level, membership, exception, other)", () => {
    for (const reason of ["age_division_not_met", "status_not_established", "level_not_met", "criteria_verified_by_organizer", "other_organizer_review"]) {
      expect(waive(reason)).toMatch(/event-policy/);
    }
  });
  it("every prohibited override subject is refused by a gate", () => {
    expect([...PROHIBITED_OVERRIDE_SUBJECTS]).toEqual([
      "under_18_restriction",
      "body_mandatory_age_requirement",
      "body_amateur_professional_status_requirement",
      "body_proficiency_level_requirement",
      "body_membership_or_registration_requirement",
    ]);
    // under-18: any clearing decision with stored data that does not show 18+ is refused, even a permitted waiver.
    expect(waive("waiver_event_policy_fee", [], false)).toMatch(/18 or older/);
    // body age, status and level: a waiver is refused whenever the division uses that classification.
    for (const criterion of ELIGIBILITY_CRITERIA) expect(waive("waiver_event_policy_fee", [criterion])).toMatch(/requirements/);
    // body membership/registration: NOT MODELLED, so there is no gate for it (documented limitation, not a refusal): the organizer attests it
    // outside DanceFlow, and no reason code or copy claims DanceFlow verified it.
    expect(waive("waiver_event_policy_fee", [])).toBeNull();
  });
  it("waiver reasons cannot be used with other decisions, and verification reasons only with eligible", () => {
    expect(validateEligibilityDecision({ outcome: "eligible", reasonCode: "waiver_event_policy_fee", required: [], verifiedCriteria: [], participantsAdult: true })).toMatch(/only be used with the Waived/);
    expect(validateEligibilityDecision({ outcome: "ineligible", reasonCode: "criteria_verified_by_organizer", required: [], verifiedCriteria: [], participantsAdult: true })).toMatch(/only be used with the Eligible/);
  });
  it("eligible requires every applicable criterion to be confirmed", () => {
    const base = { outcome: "eligible", reasonCode: "criteria_verified_by_organizer", required: ["status", "level"] as EligibilityCriterion[], participantsAdult: true };
    expect(validateEligibilityDecision({ ...base, verifiedCriteria: ["level"] })).toMatch(/every applicable criterion/);
    expect(validateEligibilityDecision({ ...base, verifiedCriteria: ["status", "level"] })).toBeNull();
    expect(validateEligibilityDecision({ ...base, required: [], verifiedCriteria: [] })).toBeNull();
  });
});

describe("OD-18 copy", () => {
  it("says Studio/Custom eligibility is determined by the organizer and never claims body-credential verification", () => {
    expect(STUDIO_ELIGIBILITY_DISCLOSURE).toMatch(/determined by the organizer/);
    expect(STUDIO_ELIGIBILITY_DISCLOSURE).toMatch(/does not verify NDCA registration, UCWDC membership or WSDC Points Registry eligibility/);
    expect(STUDIO_ELIGIBILITY_DISCLOSURE).not.toMatch(/verified (your|the) (NDCA|UCWDC|WSDC)/i);
  });
});
