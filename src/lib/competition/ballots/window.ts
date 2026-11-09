/*
  CX1: when ballot forms may be shown. Pure helpers (no I/O); the database stays the authority (E2 _compe2_guard_ballot_insert and
  _compe2_insert_ballot, as patched by F2) and refuses anything this lets through at the wrong moment.

  Ballots are accepted while the round is `active`, or while it is `ballots_locked` AND a results correction is open (F2 sets
  correction_open only when a manager opens a correction from calculated / approved / published). Everything else is closed.
  Not covered by a correction: no-shows (NS1 allows them only while `active`, so a correction cannot change who danced),
  judge attendance (E2 allows it only while scheduled / active) and saving a callback draft (active only). Submitting a final
  callback ballot goes through the same insert path as a heat ballot and is allowed.
*/

export type BallotWindowRound = { status: string; correction_open?: boolean | null };

/** True when a ballot (new or superseding version) can be submitted. */
export function ballotsAccepting(round: BallotWindowRound): boolean {
  return round.status === "active" || (round.status === "ballots_locked" && round.correction_open === true);
}

/** True only for a locked round with an open correction (the corrected ballot is still allowed). */
export function inCorrectionWindow(round: BallotWindowRound): boolean {
  return round.status === "ballots_locked" && round.correction_open === true;
}

/** Attendance, callback drafts and no-shows follow the plain `active` window; a correction never opens them. */
export function normalWindowOpen(round: BallotWindowRound): boolean {
  return round.status === "active";
}

export const CORRECTION_BANNER = "Correction open: submit a corrected ballot. The current result will need to be recalculated and re-approved.";
