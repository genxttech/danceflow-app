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
  COMP_CORRECTION_LATER_ROUND_BALLOTS: "A later round of this division already has ballots, so this round can no longer be corrected.",
  COMP_PUBLICATION_REQUIRES_APPROVAL: "Publication is not available yet, so this round cannot be completed.",
  COMP_ADVANCEMENT_NOT_APPROVED: "This result advances entries and advancement has not been applied yet, so the round cannot be completed.",
};

export function resultErrorMessage(raw: string | null | undefined): string {
  const text = raw ?? "";
  const code = /COMP_[A-Z0-9_]+/.exec(text)?.[0];
  if (code && MESSAGES[code]) return MESSAGES[code];
  return "That could not be done. Reload the page and try again.";
}
