/**
 * OD-01 (owner decision 2026-11-23, Option C = BLOCK): sanction declaration versus DanceFlow scoring.
 *
 * Governance: docs/competition/RULEBOOK_GOVERNANCE.md. Pure module (no I/O). The guard decides ONLY whether results may be
 * APPROVED or PUBLISHED. Registration, scheduling, payments, ballots, calculation, withdrawal and every other operation never
 * consult it.
 *
 * Rule: when an event declares UCWDC, NDCA or WSDC, results may be approved/published only through a scoring method whose
 * implementation has been implemented AND independently verified for THAT body. `VERIFIED_BODY_SCORING` is that list and it is
 * EMPTY today: no DanceFlow method is verified for any body, so every body-declared event is blocked. Organizer acknowledgement
 * is NOT an input to this function and can never override it.
 *
 * Not overridden, not claimed (unresolved, see the register entries cited below):
 *  - NDCA Skating System algorithm (the rulebook requires it but does not define it),
 *  - WSDC Relative Placement definition (the rules refer to the WSDC website),
 *  - UCWDC "authorized" scoring-system designation (no designation source supplied).
 *
 * WSDC non-WSDC-contest opt-out (Registry Event Rules 2026.1C, 3.4.9.f): a Registry Event may opt a NON-WSDC contest out of
 * Callback/Relative Placement only by publishing if and for which contests it does so. The opt-out never applies to a WSDC Jack
 * and Jill contest (3.4.9). DanceFlow has no contest-level identification and no published-disclosure record, and this slice adds
 * no SQL, so the opt-out is NOT implemented: `WSDC_NON_WSDC_CONTEST_OPT_OUT.implemented` is false and a WSDC declaration stays
 * blocked. Follow-up (needs SQL + owner gate): contest-level "non-WSDC contest" identification, a published opt-out disclosure
 * record per contest, and a hard refusal for any Jack and Jill contest type.
 */

export type GuardBody = "ucwdc" | "ndca" | "wsdc";

export type SanctionGuardReasonCode =
  | "SANCTION_NOT_DECLARED" // none / not set: Studio/Custom, unchanged
  | "SANCTION_OTHER_UNVERIFIED" // other: not blocked, declaration unverified
  | "SANCTION_BODY_SCORING_VERIFIED" // reserved: a method verified for the declared body (none exists today)
  | "SANCTION_BODY_SCORING_NOT_VERIFIED" // ucwdc / ndca / wsdc declared; no verified scoring implementation
  | "SANCTION_DECLARATION_UNRECOGNIZED" // unknown stored value: fail closed
  | "SANCTION_DECLARATION_UNAVAILABLE"; // could not be read: fail closed

export type SanctionScoringGuardResult = {
  allowed: boolean;
  code: SanctionGuardReasonCode;
  /** Plain-language reason for the organizer. Never claims compliance, never calls a declaration verified. */
  reason: string;
  body: GuardBody | null;
  /** Rule-register ids that justify the decision (docs/competition/governance/rule-register/rules). */
  citationKeys: readonly string[];
  /** WSDC only: the contest-level opt-out is documented, not implemented, and never applies to Jack and Jill. */
  wsdcOptOut: "not_implemented" | null;
};

/**
 * Methods verified (implemented, tested, independently verified) per body. Intentionally empty. A method is added here only in a
 * reviewed change that also moves its register entries to verified_compliant. Studio methods can never be listed (no body source).
 */
export const VERIFIED_BODY_SCORING: Readonly<Record<GuardBody, readonly string[]>> = Object.freeze({
  ucwdc: Object.freeze([]),
  ndca: Object.freeze([]),
  wsdc: Object.freeze([]),
});

export const WSDC_NON_WSDC_CONTEST_OPT_OUT = Object.freeze({
  implemented: false,
  appliesToJackAndJill: false,
  requires: "contest-level identification as a non-WSDC contest, plus a published disclosure naming the contest",
  citationKey: "OD01-WSDC-0002",
});

/** Register ids per body (docs/competition/governance/rule-register/rules/*.json). */
export const BODY_CITATION_KEYS: Readonly<Record<GuardBody, readonly string[]>> = Object.freeze({
  ucwdc: Object.freeze(["OD01-UCWDC-0001"]),
  ndca: Object.freeze(["OD01-NDCA-0001"]),
  wsdc: Object.freeze(["OD01-WSDC-0001", "OD01-WSDC-0002"]),
});

const BODY_LABEL: Readonly<Record<GuardBody, string>> = { ucwdc: "UCWDC", ndca: "NDCA", wsdc: "WSDC" };

/** Body-specific wording. Governing-body-specific: each body's requirement is stated for that body only. */
const BODY_REQUIREMENT: Readonly<Record<GuardBody, string>> = {
  ucwdc:
    "UCWDC requires its Majority Rules scoring format, run by a certified Contest Coordinator with a UCWDC-authorized scoring system.",
  ndca: "NDCA requires the Skating System in NDCA Sanctioned events.",
  wsdc:
    "WSDC requires the WSDC-approved Callback system (preliminaries) and Relative Placement (finals) for all WSDC Jack and Jill contests.",
};

export const SANCTION_BLOCK_FOOTER =
  "Registration, scheduling, payments and other non-scoring operations are not affected. An acknowledgement cannot override this.";

export function evaluateSanctionScoringGuard(input: {
  /** events.competition_sanctioning as read from storage; null/undefined/"" mean "none" (unchanged). */
  sanctioning: string | null | undefined;
  /** Registry key of the method that scored the round (e.g. studio_ordinal_majority), when known. */
  methodKey?: string | null;
}): SanctionScoringGuardResult {
  const raw = input.sanctioning;
  const base = { body: null, citationKeys: [] as readonly string[], wsdcOptOut: null } as const;
  if (raw === null || raw === undefined || raw === "" || raw === "none") {
    return { ...base, allowed: true, code: "SANCTION_NOT_DECLARED", reason: "No sanctioning organization is declared." };
  }
  if (raw === "other") {
    return {
      ...base,
      allowed: true,
      code: "SANCTION_OTHER_UNVERIFIED",
      reason:
        "The organizer declared another sanctioning organization. DanceFlow has not verified this declaration and does not imply sanctioning compliance.",
    };
  }
  if (raw === "ucwdc" || raw === "ndca" || raw === "wsdc") {
    const body: GuardBody = raw;
    const verified = input.methodKey ? VERIFIED_BODY_SCORING[body].includes(input.methodKey) : false;
    if (verified) {
      return {
        allowed: true,
        code: "SANCTION_BODY_SCORING_VERIFIED",
        reason: `The scoring method is verified for ${BODY_LABEL[body]}.`,
        body,
        citationKeys: BODY_CITATION_KEYS[body],
        wsdcOptOut: body === "wsdc" ? "not_implemented" : null,
      };
    }
    return {
      allowed: false,
      code: "SANCTION_BODY_SCORING_NOT_VERIFIED",
      reason: `This event declares ${BODY_LABEL[body]} sanctioning. ${BODY_REQUIREMENT[body]} DanceFlow has not implemented and verified that scoring, so results cannot be approved or published here. ${SANCTION_BLOCK_FOOTER}`,
      body,
      citationKeys: BODY_CITATION_KEYS[body],
      wsdcOptOut: body === "wsdc" ? "not_implemented" : null,
    };
  }
  return {
    ...base,
    allowed: false,
    code: "SANCTION_DECLARATION_UNRECOGNIZED",
    reason: `The event's sanctioning value is not recognized, so results cannot be approved or published until it is corrected. ${SANCTION_BLOCK_FOOTER}`,
  };
}

/** Result used when the declaration could not be read: fail closed. */
export function sanctionGuardUnavailable(): SanctionScoringGuardResult {
  return {
    allowed: false,
    code: "SANCTION_DECLARATION_UNAVAILABLE",
    reason: "The event's sanctioning declaration could not be checked, so results cannot be approved or published right now. Try again.",
    body: null,
    citationKeys: [],
    wsdcOptOut: null,
  };
}

type Reader = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }>;
      };
    };
  };
};

/**
 * Server-side enforcement point: loads the declaration for the event that owns the round (manager session, RLS applies) and evaluates
 * the guard. Any read problem fails closed. Called by approve and publish before the database transition is requested.
 */
export async function guardRoundResultsForSanction(supabase: unknown, roundId: string): Promise<SanctionScoringGuardResult> {
  const db = supabase as Reader;
  try {
    const round = await db.from("event_competition_rounds").select("event_id, scoring_override_key, division_id").eq("id", roundId).maybeSingle();
    const r = round.data as { event_id?: string; scoring_override_key?: string | null; division_id?: string } | null;
    if (round.error || !r?.event_id) return sanctionGuardUnavailable();
    const event = await db.from("events").select("competition_sanctioning").eq("id", r.event_id).maybeSingle();
    const e = event.data as { competition_sanctioning?: string | null } | null;
    if (event.error || !e) return sanctionGuardUnavailable();
    let methodKey = r.scoring_override_key ?? null;
    if (!methodKey && r.division_id) {
      const div = await db.from("event_competition_divisions").select("scoring_method_key").eq("id", r.division_id).maybeSingle();
      methodKey = (div.data as { scoring_method_key?: string | null } | null)?.scoring_method_key ?? null;
    }
    return evaluateSanctionScoringGuard({ sanctioning: e.competition_sanctioning ?? null, methodKey });
  } catch {
    return sanctionGuardUnavailable();
  }
}
