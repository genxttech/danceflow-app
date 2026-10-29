/**
 * HL1: manager "Lock heat" on the ballot desk. The UI offers the action only for a danced, open, non-cancelled heat of an
 * active round. The database does not check that the heat was danced (set_competition_heat_lock_state only checks the
 * role and the certified guard), so this rule is the only guard against locking a heat before the floor has run it.
 */

export type HeatFloorInfo = { status: string; lock_state: string };

export function canLockHeat(input: { viewerRole: string; roundStatus: string; heatStatus: string | null | undefined; lockState: string }): boolean {
  return input.viewerRole === "manager" && input.roundStatus === "active" && input.lockState === "open" && input.heatStatus === "complete";
}

/** Why a heat has no Lock heat action, in words, for the grid. null when the action is offered. */
export function lockHeatHint(input: { roundStatus: string; heatStatus: string | null | undefined; lockState: string }): string | null {
  if (input.lockState === "locked" || input.lockState === "certified") return null;
  if (input.heatStatus === "cancelled") return "Cancelled";
  if (input.roundStatus !== "active") return null;
  if (input.heatStatus !== "complete") return "Not danced yet";
  return null;
}

export function lockHeatConfirm(heatNumber: number): string {
  return `Lock heat ${heatNumber}? Floor changes to this heat will be refused once locked.`;
}

/** The 10A RPC raises plain-text errors (no codes); O1/E2 add coded ones. */
export function heatLockErrorMessage(raw: string | null | undefined): string {
  const text = raw ?? "";
  if (text.includes("cannot be managed")) return "Heat was not found, or you are not allowed to manage this competition.";
  if (text.includes("Certified heats")) return "This heat is certified and cannot be changed here.";
  if (text.includes("COMPO1_HEAT_LOCKED")) return "The floor refused the change because the heat is locked.";
  if (text.includes("A reason is required")) return "A reason is required to reopen a locked heat.";
  if (text.includes("Locked or certified")) return "This heat is already locked or certified.";
  if (text.includes("Invalid heat lock state")) return "That lock state is not valid.";
  const code = text.match(/\b(COMPO1_[A-Z_]+|COMP_[A-Z_]+)\b/);
  return code ? `The heat could not be locked (${code[1]}). Reload the page and try again.` : `The heat could not be locked: ${text || "unknown error"}`;
}
