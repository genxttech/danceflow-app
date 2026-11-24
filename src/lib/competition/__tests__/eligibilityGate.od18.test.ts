import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_CRITERIA,
  PERMITTED_WAIVER_CATEGORIES,
  PROHIBITED_OVERRIDE_SUBJECTS,
  STUDIO_ELIGIBILITY_DISCLOSURE,
  buildEligibilityDetermination,
  evaluateEntryOperationalGate,
  requiredCriteria,
  validateEligibilityDecision,
  type EligibilityCriterion,
} from "../eligibilityGate";

const NOW = new Date("2026-11-23T12:00:00Z");
const ADULT = "1990-01-01";
const MINOR = "2012-01-01";

function determination(outcome: "eligible" | "waived", reasonCode: string, criteria: EligibilityCriterion[]) {
  return { eligibility_determination: buildEligibilityDetermination({ by: "u1", role: "organizer_admin", outcome, reasonCode: reasonCode as never, criteria, now: NOW }) };
}
const open = { ageLabel: null, skillLabel: null, participantRoles: ["dancer", "dancer"] };
const entry = (over: Partial<Parameters<typeof evaluateEntryOperationalGate>[0]> = {}) => ({
  status: "confirmed", eligibilityStatus: "eligible", ...open, metadata: {}, participantDobs: [ADULT, ADULT], ...over,
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

describe("OD-18 organizer determination must cover every applicable criterion", () => {
  const classified = { skillLabel: "Novice", participantRoles: ["professional", "student"], ageLabel: "Senior I" };
  it("clears only when the determination lists age_division, status and level", () => {
    const all = determination("eligible", "criteria_verified_by_organizer", ["age_division", "status", "level"]);
    expect(evaluateEntryOperationalGate(entry({ ...classified, metadata: all }), NOW).ready).toBe(true);
    const missingLevel = determination("eligible", "criteria_verified_by_organizer", ["age_division", "status"]);
    expect(evaluateEntryOperationalGate(entry({ ...classified, metadata: missingLevel }), NOW).reasons).toContain("criteria_determination_missing");
    expect(evaluateEntryOperationalGate(entry({ ...classified, metadata: {} }), NOW).reasons).toContain("criteria_determination_missing");
  });
  it("the body-permitted-exception category still needs every criterion confirmed", () => {
    expect(evaluateEntryOperationalGate(entry({ skillLabel: "Novice", metadata: determination("eligible", "body_permitted_exception_applied", ["level"]) }), NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate(entry({ skillLabel: "Novice", metadata: determination("eligible", "body_permitted_exception_applied", []) }), NOW).ready).toBe(false);
  });
  it("records actor, role, time, criteria and outcome without sensitive detail", () => {
    const record = buildEligibilityDetermination({ by: "u1", role: "organizer_admin", outcome: "eligible", reasonCode: "criteria_verified_by_organizer", criteria: ["level", "age_division"], now: NOW });
    expect(record).toEqual({ by: "u1", role: "organizer_admin", at: "2026-11-23T12:00:00.000Z", outcome: "eligible", reasonCode: "criteria_verified_by_organizer", criteria: ["age_division", "level"] });
    expect(JSON.stringify(record)).not.toMatch(/birth|dob|membership|points|registration number/i);
  });
});

describe("OD-18 gate matrix: independent dimensions with no conflicting gates", () => {
  const level = { skillLabel: "Novice" };
  const eligibleLevel = determination("eligible", "criteria_verified_by_organizer", ["level"]);

  it("under-18 + eligible status + full criteria stays blocked (OD-02 absolute)", () => {
    const result = evaluateEntryOperationalGate(entry({ ...level, metadata: eligibleLevel, participantDobs: [ADULT, MINOR] }), NOW);
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["adult_not_verified"]);
  });
  it("under-18 + waived status stays blocked, and the waiver does not clear an age block", () => {
    const waived = determination("waived", "waiver_event_policy_fee", []);
    const result = evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived", metadata: waived, participantDobs: [MINOR, MINOR] }), NOW);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("adult_not_verified");
  });
  it("a waived status does not clear a level, status or age requirement", () => {
    const waived = determination("waived", "waiver_event_policy_fee", []);
    for (const over of [{ skillLabel: "Novice" }, { ageLabel: "Masters" }, { participantRoles: ["professional", "student"] }]) {
      const result = evaluateEntryOperationalGate(entry({ ...over, eligibilityStatus: "waived", metadata: waived }), NOW);
      expect(result.ready).toBe(false);
      expect(result.reasons).toContain("waiver_not_allowed_for_classified_division");
    }
  });
  it("missing criteria fail closed: unknown-label divisions and entries with no determination are not ready", () => {
    expect(evaluateEntryOperationalGate(entry({ skillLabel: "???" }), NOW).ready).toBe(false);
    expect(evaluateEntryOperationalGate(entry({ ageLabel: "???" }), NOW).ready).toBe(false);
  });
  it("an adult open-division entry with a categorised event-policy waiver is ready; an uncategorised waiver is not", () => {
    expect(evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived", metadata: determination("waived", "waiver_event_policy_documents", []) }), NOW).ready).toBe(true);
    expect(evaluateEntryOperationalGate(entry({ eligibilityStatus: "waived", metadata: {} }), NOW).reasons).toContain("waiver_category_missing");
  });
  it("combination sweep: ready only when ALL of adult, applicable criteria and a permitted decision hold", () => {
    const dims = { adult: [true, false], level: [true, false], covered: [true, false] };
    for (const adult of dims.adult) for (const hasLevel of dims.level) for (const covered of dims.covered) {
      const metadata = covered ? eligibleLevel : determination("eligible", "criteria_verified_by_organizer", []);
      const result = evaluateEntryOperationalGate(entry({ skillLabel: hasLevel ? "Novice" : null, metadata, participantDobs: adult ? [ADULT] : [MINOR] }), NOW);
      expect(result.ready).toBe(adult && (!hasLevel || covered));
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
    for (const reason of ["age_division_not_met", "status_not_established", "level_not_met", "criteria_verified_by_organizer", "body_permitted_exception_applied", "other_organizer_review"]) {
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
    // body membership/registration: not modelled, never verified; a waiver reason cannot stand in for it and no reason code claims it.
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
