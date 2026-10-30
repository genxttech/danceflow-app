/** Human copy for the E2 database error codes. The RPC is the authority; the UI only explains its refusals. */

const MESSAGES: Record<string, string> = {
  COMP_FORBIDDEN: "You do not have access to do that.",
  COMP_JUDGE_NOT_ASSIGNED: "You are not on this round's judging panel.",
  COMP_REQUEST_ID_REQUIRED: "Something went wrong with this form. Reload the page and try again.",
  COMP_REQUEST_REUSED: "This form was already used. Reload the page and try again.",
  COMP_BALLOT_ROUND_NOT_ACTIVE: "This round is not accepting ballots right now. Ballots are locked or the round is not running.",
  COMP_BALLOT_HEAT_INVALID: "That heat is not part of this round's ballot.",
  COMP_BALLOT_JUDGE_ABSENT: "This judge is recorded absent for the round. Record them present first.",
  COMP_BALLOT_CORRECTION_REASON_REQUIRED: "A ballot already exists for this heat. Say why you are correcting it (up to 500 characters).",
  COMP_BALLOT_CONFLICT: "Another ballot was just recorded for this judge and heat. Reload and try again.",
  COMP_CALLBACK_TARGET_UNSET: "The organizer has not set how many couples to call back yet.",
  COMP_CALLBACK_NOT_DANCED: "Everyone advances; this callback round is not danced, so there is no ballot to take. Advancement is applied in results.",
  COMP_CALLBACK_COUNT: "Select exactly the number of couples to call back, across all heats.",
  COMP_BALLOT_FORMAT_NOT_APPROVED: "Ballots in this format are not available yet: the owner has not approved it.",
  COMP_BALLOTS_STALE: "Some current ballots no longer match the round (an entry was scratched or the callback target changed). Correct them first.",
  COMP_ROUND_CONFIG_FROZEN: "The scoring method and callback target cannot change once the round has started.",
  COMP_BALLOT_FORMAT_MISMATCH: "This ballot format does not match the round. Reload the page.",
  COMP_PANEL_SIZE: "The present panel is too small for this kind of round (ordinal and callback rounds need at least 3 judges and an odd number).",
  COMP_BALLOT_SCORING_METHOD_UNSUPPORTED: "This round's scoring method has no ballot yet.",
  COMP_BALLOT_NO_ENTRIES: "This heat has no entries to mark.",
  COMP_BALLOT_UNKNOWN_ENTRY: "A mark refers to an entry that is not on this heat.",
  COMP_BALLOT_DUPLICATE_MARK: "An entry was marked more than once.",
  COMP_BALLOT_INCOMPLETE: "Every entry on the heat needs a mark.",
  COMP_BALLOT_ROLE_NOT_ALLOWED: "Marks are per entry, not per leader or follower.",
  COMP_BALLOT_MARK_OUT_OF_RANGE: "Rank each entry with a whole number from 1 to the number of entries.",
  COMP_BALLOT_JUDGE_TIE: "Two entries share the same rank. Give each entry a different rank.",
  COMP_BALLOT_MARK_NOT_IN_SCALE: "Choose Gold, Silver or Bronze for every entry.",
  COMP_ATTENDANCE_INVALID: "Choose absent or present, and give a reason for an absence.",
  COMP_ABSENCE_HAS_BALLOTS: "This judge already has ballots in the round, so they cannot be recorded absent.",
  COMP_BALLOTS_BAD_STATE: "The round is not in the right state for that.",
  COMP_BALLOTS_INCOMPLETE: "Not every judge has a ballot for every heat. Record the missing ballots or an absence first.",
  COMP_HL1_HEAT_NOT_DANCED: "Every heat of the round must be danced before its ballots can be locked. A heat locked early still has to be run on the floor.",
  COMP_BALLOTS_HEATS_NOT_LOCKED: "Lock every heat of the round before locking its ballots.",
  COMP_RESULT_REASON_REQUIRED: "Give a reason (up to 500 characters).",
  COMP_REOPEN_RESULT_APPROVED: "A result for this round is already approved, so the ballots cannot be reopened here.",
};

export function ballotErrorMessage(raw: string | null | undefined): string {
  const text = raw ?? "";
  const code = Object.keys(MESSAGES).find((candidate) => text.includes(candidate));
  return code ? MESSAGES[code] : "That could not be saved. Reload the page and try again.";
}

/** Only same-site app paths may be used as a post-action redirect target. */
export function safeReturnPath(value: string | null | undefined, fallback: string): string {
  const path = (value ?? "").trim();
  return /^\/app\/[A-Za-z0-9/_\-.]*$/.test(path) && !path.includes("..") ? path : fallback;
}
