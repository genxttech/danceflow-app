/** Plain copy for the restricted pilot refusals (migration 20270301180000). The database is the authority; the UI only explains. */
const MESSAGES: Record<string, string> = {
  COMP_P1_BUSY: "Another change was in progress, so nothing was saved. Wait a moment and try again.",
  COMP_P1_STRUCTURE_FROZEN: "The competition has started, so programs, divisions and rounds can no longer be added, moved, cancelled or removed.",
  COMP_P1_ORDER_FROZEN: "The competition has started, so the running order, its heats and their dances can no longer change.",
  COMP_P1_FINAL_ONLY: "This pilot runs one final per division. Other round types are not available.",
  COMP_P1_CALLBACKS_OFF: "Callback rounds are not available in this pilot.",
  COMP_P1_ADVANCEMENT_OFF: "Moving couples on to another round is not available in this pilot.",
  COMP_P1_CORRECTIONS_OFF: "Reopening locked ballots and correcting results are not available in this pilot.",
  COMP_P1_PAPER_BALLOTS_OFF: "Paper ballot entry is not available in this pilot. Each ballot must be sent from the official's own sign-in.",
  COMP_P1_HEAT_NOT_STARTED: "This heat has not started yet. Send the ballot after it starts.",
  COMP_P1_STARTED_HEAT: "This heat has started, so couples can no longer be added or removed.",
  COMP_P1_PUBLISHED_FROZEN: "These results are published, so this name or entry number can no longer change.",
  COMP_P1_SANCTION_BLOCKED: "This event lists a governing body, so its results cannot be approved or published in this pilot.",
  COMP_P1_SECOND_APPROVER_REQUIRED: "A second manager must approve this result. The person who calculated it cannot, even with a reason.",
  COMP_P1_MINIMUM_COUPLES: "A final needs at least two ranked couples before it can be approved.",
  compp1_one_round_per_division: "This division already has its one round. A cancelled round still counts.",
  compp1_one_heat_per_round: "This pilot allows one heat for each round in a running order.",
  compp1_one_dance_per_heat: "This pilot allows one dance for each heat.",
  compp1_one_published_order: "This event already has a published running order.",
};

/** The pilot copy for a database error text (a COMP_P1_* code or a compp1_* unique index name), or null when it is neither. */
export function pilotErrorMessage(raw: string | null | undefined): string | null {
  const key = /COMP_P1_[A-Z_]+|compp1_[a-z_]+/.exec(raw ?? "")?.[0];
  return key ? (MESSAGES[key] ?? null) : null;
}
