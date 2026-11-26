/*
  OD-03 (owner decision 2026-11-23, Option C, subject to OD-02 compatibility).

  Initial activation uses ORGANIZER VERIFICATION of age-division eligibility. DanceFlow does NOT yet calculate or
  automatically verify governing-body age divisions (NDCA / UCWDC / WSDC differ in reference dates, windows and
  couple rules); automated per-body calculation is a later, separately reviewed phase. Nothing here may be described
  in product copy as checking or enforcing age classes.

  Two independent layers, evaluated for every entry before it is confirmed-for-operations (heat planning, floor plan,
  readiness counts):

  1. OD-02 adult-only (absolute, DanceFlow launch policy): every participant must have a stored, valid date of birth
     showing 18 or older. No eligibility status, waiver or organizer determination can lift this.
  2. Eligibility clearance (R-15): the database must report the entry as cleared, which requires an audited organizer
     determination recorded through set_competition_entry_eligibility (see eligibilityRpc.ts) that still matches the
     entry. "waived" never clears an age-restricted entry: a waiver must not bypass a body's mandatory age requirement.

  Whose age decides in Pro-Am and Couples is UNRESOLVED (AE-16, NOT SPECIFIED IN PROVIDED SOURCE for these sources);
  the software therefore never infers it. The organizer's determination covers it, and the copy says so.

  Privacy: nothing here returns or stores a birthdate or an age.
*/

import type { ClearanceState } from "@/lib/competition/eligibilityRpc";
import { classifyDateOfBirth } from "@/lib/competition/minorsGate";

export const ELIGIBILITY_STATUSES = ["unverified", "eligible", "needs_review", "ineligible", "waived"] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

/** Exactly the reason codes the database accepts. */
export const WAIVER_REASON_CODES = ["waiver_event_policy_documents", "waiver_event_policy_fee", "waiver_event_policy_scheduling"] as const;
export const NEGATIVE_REASON_CODES = [
  "age_division_not_met",
  "age_not_established",
  "status_not_established",
  "level_not_met",
  "whose_age_rule_unresolved",
  "documents_pending",
  "other_organizer_review",
] as const;
export const ELIGIBILITY_REASON_CODES = ["criteria_verified_by_organizer", ...WAIVER_REASON_CODES, ...NEGATIVE_REASON_CODES] as const;
export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

export const AGE_VERIFICATION_DISCLOSURE =
  "DanceFlow does not yet automatically verify governing-body age divisions. The organizer verifies each entry's age-division eligibility and records the decision here.";

const OPEN_AGE_LABELS = new Set(["", "open", "all", "all ages", "any", "any age", "none", "n/a", "na"]);

/** A division is age-restricted unless its age label is blank or explicitly open. Unknown labels fail closed (restricted). */
export function isAgeRestrictedDivision(ageLabel: string | null | undefined): boolean {
  return !OPEN_AGE_LABELS.has(String(ageLabel ?? "").trim().toLowerCase());
}

export type EntryGateReason =
  | "not_confirmed"
  | "ineligible"
  | "adult_not_verified"
  | "eligibility_not_decided"
  | "clearance_not_recorded"
  | "clearance_unavailable";

export type EntryGateInput = {
  status: string;
  eligibilityStatus: string;
  /** The database's own answer for this entry (competition_entry_clearance_state). */
  clearance: ClearanceState;
  /** Stored dates of birth of every participant (null = none stored). An entry with no participants fails closed. */
  participantDobs: Array<string | null>;
};

/** OD-02 layer: every participant has a stored DOB that shows 18 or older. Independent of status and waivers. */
export function participantsAdultVerified(participantDobs: Array<string | null>, now: Date = new Date()): boolean {
  return participantDobs.length > 0 && participantDobs.every((dob) => classifyDateOfBirth(dob, now) === "adult");
}

export function evaluateEntryOperationalGate(input: EntryGateInput, now: Date = new Date()): { ready: boolean; reasons: EntryGateReason[] } {
  const reasons: EntryGateReason[] = [];
  if (input.status !== "confirmed") reasons.push("not_confirmed");
  if (input.eligibilityStatus === "ineligible") reasons.push("ineligible");
  if (!participantsAdultVerified(input.participantDobs, now)) reasons.push("adult_not_verified");

  if (input.eligibilityStatus !== "ineligible") {
    if (input.eligibilityStatus !== "eligible" && input.eligibilityStatus !== "waived") reasons.push("eligibility_not_decided");
    else if (input.clearance === "unavailable") reasons.push("clearance_unavailable");
    else if (input.clearance !== "cleared") reasons.push("clearance_not_recorded");
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * Early, friendly validation of an organizer's decision. The database function enforces the same rules and is authoritative.
 * `participantsAdult` must come from stored data, never from the form.
 */
export function validateEligibilityDecision(input: {
  outcome: string;
  reasonCode: string;
  ageLabel: string | null | undefined;
  participantsAdult: boolean;
}): string | null {
  if (!(ELIGIBILITY_STATUSES as readonly string[]).includes(input.outcome)) return "A valid eligibility decision is required.";
  if (!(ELIGIBILITY_REASON_CODES as readonly string[]).includes(input.reasonCode)) return "Choose a reason for this eligibility decision.";
  const restricted = isAgeRestrictedDivision(input.ageLabel);
  const clears = input.outcome === "eligible" || input.outcome === "waived";
  if (clears && !input.participantsAdult) {
    return "This entry cannot be marked eligible or waived: every competitor must have a verified date of birth showing 18 or older. This cannot be waived.";
  }
  if (restricted && input.outcome === "waived") {
    return "A waiver cannot be used for an age-restricted division. Verify age eligibility, or mark the entry ineligible.";
  }
  if (input.outcome === "eligible" && input.reasonCode !== "criteria_verified_by_organizer") {
    return "Marking an entry eligible requires the reason \"criteria verified by organizer\".";
  }
  if (input.outcome === "waived" && !(WAIVER_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    return "A waiver is only for an event-policy matter: documents, fee or scheduling.";
  }
  if (!clears && !(NEGATIVE_REASON_CODES as readonly string[]).includes(input.reasonCode)) return "Choose a reason for this eligibility decision.";
  return null;
}
