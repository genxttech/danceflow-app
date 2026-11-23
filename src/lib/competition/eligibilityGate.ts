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
  2. Age-restricted division (the division has an age label): the entry needs an auditable organizer determination
     (who, when, outcome, reason code) with outcome "eligible". "waived" never clears an age-restricted entry: a waiver
     must not bypass a body's mandatory age requirement.

  Whose age decides in Pro-Am and Couples is UNRESOLVED (AE-16, NOT SPECIFIED IN PROVIDED SOURCE for these sources);
  the software therefore never infers it. The organizer's determination covers it, and the copy says so.

  Privacy: nothing here returns or stores a birthdate or an age. Determinations hold a user id, a timestamp, an
  outcome and a reason code.
*/

import { classifyDateOfBirth } from "@/lib/competition/minorsGate";

export const ELIGIBILITY_STATUSES = ["unverified", "eligible", "needs_review", "ineligible", "waived"] as const;
export type EligibilityStatus = (typeof ELIGIBILITY_STATUSES)[number];

export const ELIGIBILITY_REASON_CODES = [
  "age_division_verified_by_organizer",
  "age_division_not_met",
  "age_not_established",
  "whose_age_rule_unresolved",
  "documents_pending",
  "other_organizer_review",
  "waiver_non_age_matter",
] as const;
export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

export type EligibilityDetermination = {
  by: string;
  at: string;
  outcome: EligibilityStatus;
  reasonCode: EligibilityReasonCode;
};

export const AGE_VERIFICATION_DISCLOSURE =
  "DanceFlow does not yet automatically verify governing-body age divisions. The organizer verifies each entry's age-division eligibility and records the decision here.";

const OPEN_AGE_LABELS = new Set(["", "open", "all", "all ages", "any", "any age", "none", "n/a", "na"]);

/** A division is age-restricted unless its age label is blank or explicitly open. Unknown labels fail closed (restricted). */
export function isAgeRestrictedDivision(ageLabel: string | null | undefined): boolean {
  return !OPEN_AGE_LABELS.has(String(ageLabel ?? "").trim().toLowerCase());
}

export function parseEligibilityDetermination(metadata: unknown): EligibilityDetermination | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).eligibility_determination;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const by = typeof value.by === "string" ? value.by : "";
  const at = typeof value.at === "string" && !Number.isNaN(Date.parse(value.at)) ? value.at : "";
  const outcome = value.outcome as EligibilityStatus;
  const reasonCode = value.reasonCode as EligibilityReasonCode;
  if (!by || !at) return null;
  if (!(ELIGIBILITY_STATUSES as readonly string[]).includes(outcome)) return null;
  if (!(ELIGIBILITY_REASON_CODES as readonly string[]).includes(reasonCode)) return null;
  return { by, at, outcome, reasonCode };
}

export type EntryGateReason =
  | "not_confirmed"
  | "ineligible"
  | "adult_not_verified"
  | "eligibility_not_decided"
  | "age_determination_missing"
  | "waiver_not_allowed_for_age_division";

export type EntryGateInput = {
  status: string;
  eligibilityStatus: string;
  ageLabel: string | null | undefined;
  metadata: unknown;
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

  if (isAgeRestrictedDivision(input.ageLabel)) {
    if (input.eligibilityStatus === "waived") reasons.push("waiver_not_allowed_for_age_division");
    else if (input.eligibilityStatus !== "eligible" && input.eligibilityStatus !== "ineligible") reasons.push("eligibility_not_decided");
    else if (input.eligibilityStatus === "eligible") {
      const determination = parseEligibilityDetermination(input.metadata);
      if (!determination || determination.outcome !== "eligible" || determination.reasonCode !== "age_division_verified_by_organizer") {
        reasons.push("age_determination_missing");
      }
    }
  } else if (!["eligible", "waived"].includes(input.eligibilityStatus) && input.eligibilityStatus !== "ineligible") {
    reasons.push("eligibility_not_decided");
  }
  return { ready: reasons.length === 0, reasons };
}

/**
 * Validate an organizer's eligibility decision before it is written. Returns an error message (no ages or dates) or null.
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
  if (restricted && input.outcome === "eligible" && input.reasonCode !== "age_division_verified_by_organizer") {
    return "Marking an age-restricted entry eligible requires the reason \"age division verified by organizer\".";
  }
  if (input.outcome === "waived" && input.reasonCode !== "waiver_non_age_matter") {
    return "A waiver is only for matters other than age; choose \"waiver for a non-age matter\".";
  }
  return null;
}

export function buildEligibilityDetermination(input: { by: string; outcome: EligibilityStatus; reasonCode: EligibilityReasonCode; now?: Date }): EligibilityDetermination {
  return { by: input.by, at: (input.now ?? new Date()).toISOString(), outcome: input.outcome, reasonCode: input.reasonCode };
}
