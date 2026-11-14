/** Human copy for the F2 result lifecycle error codes. The RPCs are the authority; the UI only explains their refusals. */

const MESSAGES: Record<string, string> = {
  COMP_FORBIDDEN: "You do not have access to do that.",
  COMP_REQUEST_ID_REQUIRED: "Something went wrong with this form. Reload the page and try again.",
  COMP_REQUEST_REUSED: "This form was already used. Reload the page and try again.",
  COMP_RESULT_INVALID_TRANSITION: "The round is not in the right state for that.",
  COMP_RESULT_REASON_REQUIRED: "Give a reason (up to 500 characters).",
  COMP_RESULT_STALE: "The ballots changed after this result was calculated. Recalculate before approving.",
  COMP_SECOND_APPROVER_REQUIRED:
    "A different manager should approve this result. If you are the only manager, say why in the override reason and approve again.",
  COMP_BALLOTS_INCOMPLETE: "The round's ballots are not complete, so it cannot be calculated yet.",
  COMP_ENGINE_NOT_AVAILABLE: "No approved scoring engine is available for this round's scoring method yet, so results cannot be calculated.",
  COMP_ENGINE_UNSPECIFIED_CASE: "The scoring method does not define what to do in this case, so no result was produced.",
  COMP_ENGINE_INVALID_INPUT: "The calculation was refused because its input or output was not valid.",
  // PV-1: the database recomputes every result from the locked ballots before saving it.
  COMP_RESULT_RECOMPUTE_MISMATCH: "The result did not match the system's own check of the locked ballots, so nothing was saved. Recalculate the round; if it happens again, contact support.",
  COMP_RESULT_RECOMPUTE_UNSUPPORTED: "The system could not independently check this round's result, so nothing was saved. The round's setup or ballots need review before it can be calculated.",
  COMP_CORRECTION_LATER_ROUND_BALLOTS: "A later round of this division already has ballots, so this round can no longer be corrected.",
  COMP_BALLOT_ROUND_NOT_ACTIVE: "This round is not accepting ballots right now.",
  COMP_CORRECTION_EARLIER_ROUND_OPEN: "An earlier round of this division is being corrected, so this round cannot take ballots yet.",
  COMP_PUBLICATION_REQUIRES_APPROVAL: "This round has no current, approved publication, so it cannot be completed or published.",
  // F3 publication.
  COMP_PUBLICATION_VISIBILITY: "Choose who can see the published result: entrants only, or the public.",
  COMP_PUBLICATION_UNRESOLVED: "This result cannot be published yet: a callback tie is undecided, or the Final was advanced from a different result version.",
  COMP_PUBLICATION_BLOCKED_BY_EXCEPTION: "This result cannot be published: an unresolved refund exception affects this round. Resolve it first.",
  COMP_PUBLICATION_VERSION_USED: "This result version was already published, so it cannot be published again. Open a correction, recalculate and approve a new version.",
  COMP_PUBLICATION_NOT_CURRENT: "That publication is already withdrawn or replaced.",
  COMP_ADVANCEMENT_NOT_APPROVED: "This result advances entries and advancement has not been applied yet, so the round cannot be completed.",

  // CF1: callback-to-Final advancement (apply, preview, Final start guard, correction trigger, Final guards).
  COMP_ADVANCEMENT_SOURCE_STATE: "This round's result must be approved before its callback can advance couples to the Final.",
  COMP_ADVANCEMENT_ALREADY_APPLIED: "Advancement has already been applied for this round.",
  COMP_ADVANCEMENT_BLOCKED: "Advancement is unresolved: a tie at the callback cut-off would exceed the Final's capacity, or an entry has no advance decision. No couple has been advanced and DanceFlow does not break ties automatically. Approve and Advance stay unavailable until the tie is resolved; if a judge made an error, open a judge-entry correction.",
  COMP_ADVANCEMENT_TARGET_ROUND_STATE: "The Final is not in a state that can take couples (it must be scheduled and not started).",
  COMP_ADVANCEMENT_NO_LIVE_VERSION: "There is no running order yet. Generate heats before advancing couples to the Final.",
  COMP_ADVANCEMENT_FINAL_PLACEMENT_MODE: "The Final's placement mode does not support advancement from a callback.",
  COMP_ADVANCEMENT_FINAL_HEATS_PRESENT: "The Final already has heats. Remove or clear them before advancing couples.",
  COMP_ADVANCEMENT_MULTI_DANCE: "Advancement into a multi-dance Final is not supported yet.",
  COMP_ADVANCEMENT_FINAL_DANCE: "The Final must hold exactly one dance, the callback round's dance. Check the Final's dance setup.",
  COMP_ADVANCEMENT_REVOKED: "This request was already applied and has since been revoked by a correction. Advance again (a new request is made automatically when you reload the page).",
  COMP_ADVANCEMENT_REVOKE_ACTOR_REQUIRED: "This correction would revoke an advancement, which needs a signed-in actor. Sign in and try again; nothing was changed.",
  COMP_ADVANCEMENT_BELOW_MINIMUM: "A Final needs at least two couples. Fewer than two eligible couples would remain.",
  COMP_ADVANCEMENT_OVER_CAPACITY: "More couples advance than the Final's heat holds. Raise the Final's heat size, with a reason, and try again.",
  COMP_ADVANCEMENT_ENTRY_UNAVAILABLE: "An advancing couple is no longer eligible (for example a refund or a cancelled entry). Resolve it and try again.",
  COMP_ADVANCEMENT_FINAL_COMPETITOR_CONFLICT: "An advancing competitor is already in another heat of the same running order at a conflicting time.",
  COMP_ADVANCEMENT_FLOOR_HEAT_PROBLEM: "The running order could not take the Final's heat. Check the floor schedule and try again.",
  COMP_ADVANCEMENT_CONCURRENT_CHANGE: "Another change was happening at the same moment. Nothing was saved. Wait a moment and try again.",
  COMP_ADVANCEMENT_NOT_APPLIED: "Advance the callback couples to this Final before starting it.",
  COMP_ADVANCEMENT_ROSTER_STALE: "A couple on the Final's roster is no longer eligible, or is in the wrong division. Resolve it before starting the Final.",
  COMP_ADVANCEMENT_ROSTER_INCOMPLETE: "The Final's heat does not match the advanced couples (someone was scratched or removed without a withdrawal record). Record a withdrawal first.",
  COMP_ADVANCEMENT_FINAL_STARTED: "The Final has already started, so couples can no longer be changed this way.",
  COMP_ADVANCEMENT_FINAL_LOCKED: "A heat of the Final is locked. Reopen it before making this change.",
  COMP_ADVANCEMENT_FINAL_CANCELLED: "The Final was cancelled, so the callback round cannot be corrected.",
  COMP_ADVANCEMENT_PUBLISHED_NEEDS_F3: "This result has been published. Withdraw the publication before correcting a round that already advanced couples.",
  COMP_ADVANCEMENT_CORRECTION_UNRECOVERABLE: "A correction cannot be opened: an advanced couple is no longer eligible and the correction could not recover them.",
  COMP_ADVANCEMENT_FINAL_HEAT_WRITER: "The Final's heat can only be changed by advancement.",
  COMP_ADVANCEMENT_FINAL_HEAT_REVIVE: "A cancelled Final heat cannot be brought back.",
  COMP_ADVANCEMENT_FINAL_HEAT_CANCEL: "The Final's heat cannot be cancelled directly.",
  COMP_ADVANCEMENT_FINAL_HEAT_IDENTITY: "The Final's heat cannot be moved or re-pointed after advancement.",
  COMP_ADVANCEMENT_FINAL_ENTRY_WRITER: "Couples on the Final can only change through advancement or a recorded withdrawal.",
  COMP_ADVANCEMENT_FINAL_DANCE_WRITER: "The Final's dances cannot be changed after advancement.",
  COMP_ADVANCEMENT_FINAL_MULTIPLE_HEATS: "The Final must stay in a single heat.",
  COMP_ADVANCEMENT_PUBLISH_FINAL_HEAT: "The running order cannot be published: the Final's heat does not match advancement.",
  COMP_ADVANCEMENT_PUBLISH_FROZEN: "The running order cannot be published: it would change a Final that already has advanced couples.",
  COMP_ADVANCEMENT_PUBLISH_INCONSISTENT: "The running order cannot be published: the Final's heat and its advanced couples disagree.",
  COMP_ADVANCEMENT_REINSTATE_NO_HEAT_ENTRY: "This couple has no place left in the Final's heat to restore.",
  COMP_ADVANCEMENT_REINSTATE_PRIOR_SCRATCH: "This couple was scratched before the withdrawal, and that scratch is not undone by reinstating.",

  // CF1: roster eligibility at lock, calculate and approve. Per-couple payment reasons are deliberately not shown.
  COMP_ROSTER_ENTRY_UNAVAILABLE:
    "One or more couples in this round are no longer eligible (for example a refund or a cancelled entry). If the couple already danced, a manager can record an exclusion with a reason; otherwise correct the entry first.",
  COMP_ROSTER_BELOW_MINIMUM: "A Final needs at least two eligible couples. Fewer than two remain.",

  // CF1 OD-17 enforcement switch (per event, off by default; extra checks at round start, heat placement and forward round edges).
  COMP_OD17_ROSTER_ENTRY_UNAVAILABLE:
    "A couple is no longer eligible (for example a refund or a cancelled entry), so this couple cannot be placed in a heat or the round cannot start. Scratch or correct the entry first.",
  COMP_OD17_REFUND_GATE: "Refund checking is not available right now, so this step is blocked until a release owner restores it. Nothing was saved.",
  COMP_OD17_GATES_NOT_MET: "Eligibility enforcement cannot be turned on yet: at least one release check is not satisfied for this event.",
  COMP_OD17_REASON_REQUIRED: "Give a reason of 10 to 500 characters.",
  COMP_OD17_BAD_ARGUMENT: "Choose whether to turn eligibility enforcement on or off.",

  // CF1: exclusion action (request, co-sign, reversal).
  COMP_VERIFIED_EMAIL_REQUIRED: "Confirm your email address before doing that.",
  COMP_EXCLUSION_REASON_KIND: "Choose a reason: ineligible, refunded or other.",
  COMP_EXCLUSION_REASON_REQUIRED: "Give a reason (3 to 500 characters).",
  COMP_EXCLUSION_WINDOW: "A couple can only be excluded while the round is running or its ballots are locked, and not while a correction is open. For a calculated or approved round the result must be corrected and recalculated first; if a correction is already open and nothing has been filed under it, use the recovery option to cancel it and record the exclusion.",
  COMP_CORRECTION_EXCLUSION_DURING_CORRECTION: "A correction is open for this round, so an exclusion cannot be recorded now. If no replacement ballot, co-sign or current publication exists yet, use the recovery option to cancel the correction and record the exclusion; otherwise finish the correction first.",
  COMP_REOPEN_RECOVERY_PENDING: "Ballots cannot be reopened for this round: a correction was cancelled to record an exclusion and the round has not been recalculated yet. Co-sign the exclusion and recalculate first; open a new correction if any ballot needs changing.",
  COMP_EXCLUSION_PUBLICATION_EXISTS: "This round's result has been published, so couples cannot be excluded or restored until the publication is withdrawn.",
  COMP_EXCLUSION_ENTRY_NOT_IN_ROUND: "That couple is not in this round.",
  COMP_EXCLUSION_NOT_DANCED: "That couple did not dance. Use a scratch, withdrawal or no-show instead of an exclusion.",
  COMP_EXCLUSION_NOT_UNAVAILABLE: "That couple is still eligible, so they cannot be excluded.",
  COMP_EXCLUSION_ALREADY: "That couple is already excluded.",
  COMP_EXCLUSION_NOT_ACTIVE: "That couple is not currently excluded.",
  COMP_EXCLUSION_STILL_UNAVAILABLE: "That couple is still ineligible or refunded. Fix the cause first, then reverse the exclusion.",
  COMP_EXCLUSION_DECISION_KIND: "That request does not match this action.",
  COMP_EXCLUSION_DECISION_COMPLETED: "That request has already been co-signed.",
  COMP_EXCLUSION_REQUEST_STALE: "That request is out of date: a later decision for this couple is already in effect.",
  COMP_EXCLUSION_COSIGN_SAME_PERSON: "A different person than the requester must co-sign.",
  COMP_EXCLUSION_REASON_MISMATCH: "The reason you chose does not match why this couple is unavailable. Pick the matching reason (ineligible or refunded), or Other.",
  COMP_EXCLUSION_COSIGNER_FILED_BALLOT: "You filed a corrected ballot in this round, so you cannot co-sign an exclusion for it.",
  COMP_EXCLUSION_COSIGNER_CONFLICT: "You co-signed an exclusion in this round, so you cannot file a corrected ballot for it.",

  // CF1 A7: judge-entry correction co-sign.
  COMP_CORRECTION_COSIGN_REQUIRED: "A different manager or the chair must co-sign this correction before a replacement ballot is accepted.",
  COMP_CORRECTION_COSIGN_SAME_PERSON: "The manager who opened this correction cannot co-sign it. A different manager or the chair must.",
  COMP_CORRECTION_COSIGN_NOT_REQUIRED: "This correction does not need a co-sign.",
  COMP_CORRECTION_ALREADY_COSIGNED: "This correction has already been co-signed.",
  COMP_CORRECTION_NOT_OPEN: "This correction is no longer open.",
  COMP_CORRECTION_COSIGNER_FILED_BALLOT: "You filed a replacement ballot under this correction, so you cannot co-sign it.",
  COMP_CORRECTION_COSIGNER_CONFLICT: "You co-signed this correction, so you cannot file a replacement ballot under it.",

  // CF1: callback target (A4a).
  COMP_CALLBACK_TARGET_BELOW_MINIMUM: "The callback target must be a whole number of 2 or more: a Final needs at least two couples.",
  COMP_CALLBACK_TARGET_EXCEEDS_CAPACITY: "The callback target is more than the Final's heat holds. Lower the target or raise the Final's heat size.",

  // CF1: withdrawal and reinstatement from a Final (A6).
  COMP_WITHDRAWAL_NOT_CALLBACK_FINAL: "Withdrawals apply only to the Final of a callback round.",
  COMP_WITHDRAWAL_NOT_ON_ROSTER: "That couple is not on the Final's roster.",
  COMP_WITHDRAWAL_ALREADY: "That couple is already withdrawn from the Final.",
  COMP_WITHDRAWAL_NOT_ACTIVE: "That couple is not currently withdrawn.",
  COMP_WITHDRAWAL_BALLOTS: "The Final already has ballots, so couples can no longer be withdrawn.",
  COMP_WITHDRAWAL_PRIOR_STATUS: "That couple's place in the Final cannot be changed in its current state.",
  COMP_WITHDRAWAL_ENTRY_UNAVAILABLE: "That couple is not eligible to return to the Final.",
  COMP_WITHDRAWAL_REASON_WEAK: "Give a specific reason: at least 20 characters and a few different words.",
  COMP_WITHDRAWAL_REQUEST_NOT_FOUND: "That request was not found.",
  COMP_WITHDRAWAL_COSIGN_SAME_PERSON: "A different person than the requester must co-sign.",
  COMP_WITHDRAWAL_NO_APPROVED_RESULT: "Withdrawals and reinstatements are unavailable until the corrected callback result is approved.",
  COMP_WITHDRAWAL_REQUEST_CANCELLED: "That request was cancelled.",
  COMP_WITHDRAWAL_REQUEST_COMPLETED: "That request was already co-signed, so it cannot be cancelled. A completed withdrawal is undone by a reinstatement.",
  COMP_WITHDRAWAL_REQUESTER_INVALID: "The person who made this request is no longer a manager with a verified email, so it cannot be co-signed. Cancel it and make a new request.",
  COMP_WITHDRAWAL_REQUEST_STALE: "This request is out of date: the Final's advancement changed after it was made. Cancel it and make a new request if still needed.",
  COMP_WITHDRAWAL_REQUEST_PENDING: "There is already an open request for this couple. Co-sign or cancel it first.",
  COMP_WITHDRAWAL_TOO_MANY_PENDING: "Too many requests are open for this Final. Co-sign or cancel some first.",
  COMP_WITHDRAWAL_GUARD:"The Final's roster can only change through a recorded withdrawal or reinstatement.",

  // CF1: heat capacity (schedule screen).
  COMP_CAPACITY_REASON_REQUIRED: "Give a reason for changing the heat size.",
  COMP_CAPACITY_REASON_WEAK: "Give a specific reason: at least 20 characters and a few different words.",
  COMP_CAPACITY_FORBIDDEN: "You do not have access to change the heat size.",
  COMP_CAPACITY_RANGE: "That heat size is out of range.",
  COMP_CAPACITY_ROUND_STATE: "The heat size cannot change in this round's current state.",
  COMP_CAPACITY_HEAT_STATE: "The heat size cannot change once heats have started.",
  COMP_CAPACITY_BALLOTS: "The heat size cannot change once the round has ballots.",
  COMP_CAPACITY_ADVANCED: "The heat size cannot change after couples advanced into this Final.",
  COMP_CAPACITY_CALLBACK_FROZEN: "The heat size cannot change while the callback round is under way or approved.",
  COMP_CAPACITY_F1_NOT_EXACT_T: "That heat size is not the number of couples the callback advanced.",
  COMP_CAPACITY_F1_CALLBACK_STATE: "The callback round is not in a state that allows this heat size.",
  COMP_CAPACITY_F1_BLOCKED_TIE: "The callback has a tie at its cut-off that this heat size would not resolve.",
  COMP_CAPACITY_DIRECT_WRITE: "The heat size can only be changed from the schedule screen, with a reason.",
};

/** A deadlock (40P01), a refused lock wait (55P03) or a statement timeout (57014): nothing was saved, and the same request may be repeated. */
export function isRetryableText(text: string): boolean {
  return /\b(40P01|55P03|57014)\b|deadlock detected|could not obtain lock|canceling statement due to (lock|statement) timeout/i.test(text);
}

export const RETRYABLE_MESSAGE = "Another change was happening at the same moment, or the database was busy. Nothing was saved. Wait a moment and try again.";

/** True when the text names a CF1 code this module explains (used to choose this map over another module's for a shared action). */
export function hasResultMessage(raw: string | null | undefined): boolean {
  const code = /COMP_[A-Z0-9_]+/.exec(raw ?? "")?.[0];
  return !!code && code in MESSAGES;
}

export function resultErrorMessage(raw: string | null | undefined): string {
  const text = raw ?? "";
  const first = /COMP_[A-Z0-9_]+/.exec(text)?.[0];
  if ((!first || first === "COMP_ADVANCEMENT_CONCURRENT_CHANGE") && isRetryableText(text)) return RETRYABLE_MESSAGE;
  const code = /COMP_[A-Z0-9_]+/.exec(text)?.[0];
  if (code && MESSAGES[code]) return MESSAGES[code];
  return "That could not be done. Reload the page and try again.";
}
