/**
 * R-09 (owner ratified 2026-11-23): an unsuccessful PRELIMINARY callback is displayed as "Not called back" with no placement.
 * DISPLAY LAYER ONLY. The engine constant NOT_CALLED_BACK_LABEL ("Semi-final") and the persisted engine output are part of what
 * PV-1 recomputes and compares (COMP_RESULT_RECOMPUTE_MISMATCH), so neither the engine, the SQL nor any stored result changes:
 * the stored value is mapped when it is shown.
 */
export const STORED_NOT_CALLED_BACK_LABEL = "Semi-final";
export const NOT_CALLED_BACK_DISPLAY = "Not called back";

/** A stored result label as shown to people. Unknown labels pass through unchanged. */
export function displayResultLabel(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  return stored === STORED_NOT_CALLED_BACK_LABEL ? NOT_CALLED_BACK_DISPLAY : stored;
}

/**
 * The wording for a row that did not advance. In a callback preliminary (any non-final round scored by callback tally) that
 * means "Not called back"; elsewhere the neutral "Not advanced" stays. Preliminary callback scores do not carry into the Final.
 */
export function notAdvancedWording(input: { scoringMethod?: string | null; roundType?: string | null }): string {
  const callbackRound = input.scoringMethod === "callback_tally" && input.roundType !== "final";
  return callbackRound ? NOT_CALLED_BACK_DISPLAY : "Not advanced";
}
