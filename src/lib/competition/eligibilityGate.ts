/*
  OD-03 (age division) + OD-18 (amateur/professional status and level) + OD-02 (adult-only), owner decisions 2026-11-23.

  Initial activation uses ORGANIZER VERIFICATION. DanceFlow does NOT calculate or automatically verify governing-body
  age divisions, amateur/professional status or proficiency level, and does NOT verify NDCA registration, UCWDC
  membership or WSDC Points Registry eligibility. Studio / Custom eligibility is determined by the organizer. Nothing
  here may be described in product copy as checking or enforcing those classes.

  GATE MATRIX (evaluated per entry before it counts as ready, heat-planned or floor-scheduled; "eligible" and "waived" count only while the database reports
  the entry cleared, R-15):

  | dimension                    | source of truth                         | clearable by waiver? | clearable by organizer determination? |
  |------------------------------|-----------------------------------------|----------------------|---------------------------------------|
  | OD-02 adult-only (18+)       | participants' STORED date of birth      | NEVER                | NEVER                                 |
  | age division (OD-03)         | division age label (restricted/open)    | NEVER                | yes: criteria "age_division"          |
  | amateur/professional status  | participant roles (professional/student)| NEVER                | yes: criteria "status"                |
  | level (proficiency, OD-18)   | division skill label (restricted/open)  | NEVER                | yes: criteria "level"                 |
  | event policy (documents, fee, scheduling) | organizer                  | yes (categorised)    | n/a                                   |

  Required criteria are per entry: a Studio / Custom division that uses no age label, no skill label and has no
  professional/student participant requires NO organizer criteria (per-division applicability). An unknown label
  fails closed (counts as a classification). Whose age counts in Pro-Am and Couples is UNRESOLVED (AE-16, NOT
  SPECIFIED IN PROVIDED SOURCE); the software never infers it and relies on the organizer.

  Privacy: nothing here returns or stores a birthdate, an age or credential detail. The decision itself is recorded by the database function (see eligibilityRpc.ts).
*/

import type { ClearanceState } from "@/lib/competition/eligibilityRpc";
import { classifyDateOfBirth } from "@/lib/competition/minorsGate";

export const ELIGIBILITY_STATUSES = ["unverified", "eligible", "needs_review", "ineligible", "waived"] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const ELIGIBILITY_CRITERIA = ["age_division", "status", "level"] as const;
export type EligibilityCriterion = (typeof ELIGIBILITY_CRITERIA)[number];

/** Reasons that accompany an "eligible" decision on an entry with required criteria. */
export const POSITIVE_REASON_CODES = ["criteria_verified_by_organizer"] as const;
/** Legitimate EVENT-POLICY exceptions: the only things a waiver may cover. */
export const PERMITTED_WAIVER_CATEGORIES = ["waiver_event_policy_documents", "waiver_event_policy_fee", "waiver_event_policy_scheduling"] as const;
/** Reasons for ineligible / needs-review / unverified decisions. */
export const NEGATIVE_REASON_CODES = [
  "age_division_not_met",
  "age_not_established",
  "status_not_established",
  "level_not_met",
  "whose_age_rule_unresolved",
  "documents_pending",
  "other_organizer_review",
] as const;

export const ELIGIBILITY_REASON_CODES = [...POSITIVE_REASON_CODES, ...PERMITTED_WAIVER_CATEGORIES, ...NEGATIVE_REASON_CODES] as const;
export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

/**
 * Things NO waiver or organizer override may bypass. Documented here and exercised by the tests: each subject is
 * refused by a specific gate (see the gate matrix).
 */
export const PROHIBITED_OVERRIDE_SUBJECTS = [
  "under_18_restriction",
  "body_mandatory_age_requirement",
  "body_amateur_professional_status_requirement",
  "body_proficiency_level_requirement",
  "body_membership_or_registration_requirement",
] as const;

export const AGE_VERIFICATION_DISCLOSURE =
  "DanceFlow does not yet automatically verify governing-body age divisions. The organizer verifies each entry's age-division eligibility and records the decision here.";
export const STUDIO_ELIGIBILITY_DISCLOSURE =
  "Studio / Custom eligibility (age division, amateur or professional status, and level) is determined by the organizer. DanceFlow does not verify NDCA registration, UCWDC membership or WSDC Points Registry eligibility.";

// "Open" is a legitimate AGE label meaning no age restriction, but as a LEVEL or ROLE label it names a proficiency/status
// category (for example Open Gold), so it is NOT treated as unclassified there: only blank/explicitly unrestricted labels are.
const OPEN_AGE_LABELS = new Set(["", "open", "all", "all ages", "any", "any age", "none", "n/a", "na"]);
const UNCLASSIFIED_LABELS = new Set(["", "all levels", "any level", "no level", "none", "n/a", "na"]);

function restrictedLabel(label: string | null | undefined, open: Set<string>): boolean {
  return !open.has(String(label ?? "").trim().toLowerCase());
}

/** A division is age-restricted unless its age label is blank or explicitly open. Unknown labels fail closed (restricted). */
export function isAgeRestrictedDivision(ageLabel: string | null | undefined): boolean {
  return restrictedLabel(ageLabel, OPEN_AGE_LABELS);
}
/** Same rule for the skill (level) label. */
export function isLevelRestrictedDivision(skillLabel: string | null | undefined): boolean {
  return restrictedLabel(skillLabel, UNCLASSIFIED_LABELS);
}
/** A division role label (for example "Amateur") names a status classification. Unknown labels fail closed. */
export function isStatusRestrictedDivision(roleLabel: string | null | undefined): boolean {
  return restrictedLabel(roleLabel, UNCLASSIFIED_LABELS);
}

/** Participant roles that make amateur/professional status relevant (a Pro-Am or Pro-Pro relationship). */
export const STATUS_RELEVANT_ROLES = ["professional", "student"] as const;

export function requiredCriteria(input: { ageLabel: string | null | undefined; skillLabel: string | null | undefined; roleLabel?: string | null; participantRoles: string[] }): EligibilityCriterion[] {
  const required: EligibilityCriterion[] = [];
  if (isAgeRestrictedDivision(input.ageLabel)) required.push("age_division");
  if (isStatusRestrictedDivision(input.roleLabel) || input.participantRoles.some((role) => (STATUS_RELEVANT_ROLES as readonly string[]).includes(role))) required.push("status");
  if (isLevelRestrictedDivision(input.skillLabel)) required.push("level");
  return required;
}

export type EntryGateReason =
  | "not_confirmed"
  | "ineligible"
  | "adult_not_verified"
  | "division_not_found"
  | "eligibility_not_decided"
  | "waiver_not_allowed_for_classified_division"
  | "clearance_not_recorded"
  | "clearance_unavailable";

export type EntryGateInput = {
  status: string;
  eligibilityStatus: string;
  ageLabel: string | null | undefined;
  skillLabel: string | null | undefined;
  roleLabel?: string | null;
  participantRoles: string[];
  /** false when the entry division row could not be read: fails closed. */
  divisionFound?: boolean;
  /** The database's own answer for this entry (competition_entry_clearance_state). */
  clearance: ClearanceState;
  /** Stored dates of birth of every participant (null = none stored). An entry with no participants fails closed. */
  participantDobs: Array<string | null>;
};

/** OD-02 layer: every participant has a stored DOB that shows 18 or older. Independent of status, waivers and determinations. */
export function participantsAdultVerified(participantDobs: Array<string | null>, now: Date = new Date()): boolean {
  return participantDobs.length > 0 && participantDobs.every((dob) => classifyDateOfBirth(dob, now) === "adult");
}

function includesAll(have: readonly string[], need: readonly string[]) {
  return need.every((item) => have.includes(item));
}

export function evaluateEntryOperationalGate(input: EntryGateInput, now: Date = new Date()): { ready: boolean; reasons: EntryGateReason[] } {
  const reasons: EntryGateReason[] = [];
  if (input.status !== "confirmed") reasons.push("not_confirmed");
  if (input.eligibilityStatus === "ineligible") reasons.push("ineligible");
  if (!participantsAdultVerified(input.participantDobs, now)) reasons.push("adult_not_verified");

  if (input.divisionFound === false) reasons.push("division_not_found");
  const required = requiredCriteria({ ageLabel: input.ageLabel, skillLabel: input.skillLabel, roleLabel: input.roleLabel, participantRoles: input.participantRoles });

  if (input.eligibilityStatus === "waived" && required.length > 0) reasons.push("waiver_not_allowed_for_classified_division");
  else if (input.eligibilityStatus === "waived" || input.eligibilityStatus === "eligible") {
    if (input.clearance === "unavailable") reasons.push("clearance_unavailable");
    else if (input.clearance !== "cleared") reasons.push("clearance_not_recorded");
  } else if (input.eligibilityStatus !== "ineligible") {
    reasons.push("eligibility_not_decided");
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * Validate an organizer's eligibility decision before it is written. Returns an error message (no ages, dates or
 * credential detail) or null. `participantsAdult` and `required` must come from stored data, never from the form.
 */
export function validateEligibilityDecision(input: {
  outcome: string;
  reasonCode: string;
  required: EligibilityCriterion[];
  verifiedCriteria: string[];
  participantsAdult: boolean;
}): string | null {
  if (!(ELIGIBILITY_STATUSES as readonly string[]).includes(input.outcome)) return "A valid eligibility decision is required.";
  if (!(ELIGIBILITY_REASON_CODES as readonly string[]).includes(input.reasonCode)) return "Choose a reason for this eligibility decision.";
  const clears = input.outcome === "eligible" || input.outcome === "waived";
  const reasonIsWaiver = (PERMITTED_WAIVER_CATEGORIES as readonly string[]).includes(input.reasonCode);
  const reasonIsPositive = (POSITIVE_REASON_CODES as readonly string[]).includes(input.reasonCode);

  if (clears && !input.participantsAdult) {
    return "This entry cannot be marked eligible or waived: every competitor must have a verified date of birth showing 18 or older. This cannot be waived.";
  }
  if (input.outcome === "waived") {
    if (input.required.length > 0) {
      return "A waiver cannot be used for an entry in a division with age, status or level requirements. Verify eligibility, or mark the entry ineligible.";
    }
    if (!reasonIsWaiver) return "A waiver only covers event-policy matters (documents, fee, scheduling); it cannot override an age, status, level, membership or registration requirement.";
    return null;
  }
  if (reasonIsWaiver) return "Waiver reasons can only be used with the Waived decision.";
  if (input.outcome === "eligible") {
    if (!reasonIsPositive && input.required.length > 0) return "Marking an entry eligible requires the reason \"criteria verified by organizer\".";
    if (!reasonIsPositive) return "Marking an entry eligible requires a verification reason.";
    if (!includesAll(input.verifiedCriteria, input.required)) return "Confirm every applicable criterion (age division, status, level) before marking this entry eligible.";
    return null;
  }
  if (reasonIsPositive) return "A verification reason can only be used with the Eligible decision.";
  return null;
}
