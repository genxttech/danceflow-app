/**
 * HL1: manager "Lock heat" / "Reopen heat" on the ballot desk. set_competition_heat_lock_state only checks the role, the
 * certified guard and the reopen reason; it does not check floor status, round status or whether the heat was danced.
 * These rules (mirrored by the server actions) are the only guard.
 *
 * "Danced" follows SC1's database rule: the heat is on the floor or finished (status active/complete), or one of its
 * placements is marked danced/disqualified. A locked, not-yet-danced heat still allows an official scratch (SC1).
 */

export type HeatFloorInfo = { status: string; lock_state: string; has_danced_entry?: boolean };

export type HeatLockInput = {
  viewerRole: string;
  roundStatus: string;
  heatStatus: string | null | undefined;
  lockState: string;
  hasDancedEntry?: boolean;
};

export type LockKind = "danced" | "early";

/** Rounds in which an early (undanced) lock or a reopen makes sense. Ballots-locked and later rounds are protected. */
const EARLY_ROUND_STATUSES = ["scheduled", "active"];

/** SC1's rule: on the floor, finished, or a placement already danced. An unknown heat status is treated as danced. */
export function heatIsDanced(heatStatus: string | null | undefined, hasDancedEntry?: boolean): boolean {
  return hasDancedEntry === true || !(heatStatus === "scheduled" || heatStatus === "staging");
}

/** Which Lock heat the desk offers, or null. "danced": the original path. "early": locked before the floor ran it. */
export function lockHeatKind(input: HeatLockInput): LockKind | null {
  if (input.viewerRole !== "manager" || input.lockState !== "open" || input.heatStatus === "cancelled") return null;
  if (input.heatStatus === "complete" && input.roundStatus === "active") return "danced";
  if (EARLY_ROUND_STATUSES.includes(input.roundStatus) && !heatIsDanced(input.heatStatus, input.hasDancedEntry)) return "early";
  return null;
}

export function canLockHeat(input: HeatLockInput): boolean {
  return lockHeatKind(input) !== null;
}

/** Reopen: manager, a locked (never certified) heat that has not danced, in a round whose ballots are not locked. */
export function canReopenHeat(input: HeatLockInput): boolean {
  return (
    input.viewerRole === "manager" &&
    input.lockState === "locked" &&
    input.heatStatus !== "cancelled" &&
    EARLY_ROUND_STATUSES.includes(input.roundStatus) &&
    !heatIsDanced(input.heatStatus, input.hasDancedEntry)
  );
}

/** Why a heat has no action, in words, for the grid. null when an action is offered or nothing needs saying. */
export function lockHeatHint(input: HeatLockInput): string | null {
  if (lockHeatKind(input) || canReopenHeat(input)) return null;
  if (input.lockState === "certified") return "Certified";
  if (input.heatStatus === "cancelled") return "Cancelled";
  if (input.lockState === "locked") return null;
  if (input.viewerRole !== "manager") return null;
  if (input.heatStatus === "active") return "On the floor";
  return null;
}

export function lockHeatConfirm(heatNumber: number, kind: LockKind = "danced"): string {
  return kind === "early"
    ? `Lock heat ${heatNumber}? It has not been danced. The floor can't start or change it until it is reopened. Officials can still scratch entries with a reason.`
    : `Lock heat ${heatNumber}? Floor changes to this heat will be refused once locked.`;
}

export function reopenHeatConfirm(heatNumber: number): string {
  return `Reopen heat ${heatNumber}? The floor will be able to start or change it again. The reason is kept in the audit history.`;
}

/** The 10A RPC raises plain-text errors (no codes); O1/E2 add coded ones. `verb` shapes the fallback only. */
export function heatLockErrorMessage(raw: string | null | undefined, verb: "locked" | "reopened" = "locked"): string {
  const text = raw ?? "";
  if (text.includes("cannot be managed")) return "Heat was not found, or you are not allowed to manage this competition.";
  if (text.includes("Certified heats")) return "This heat is certified and cannot be changed here.";
  if (/deadlock|40P01/i.test(text)) return "Another change to this round was happening at the same moment. Nothing was changed; try again.";
  if (text.includes("COMP_HL1_LOCK_ACTIVE")) return "This heat is on the floor. Finish it before locking.";
  if (text.includes("COMP_HL1_ALREADY_LOCKED")) return "This heat is already locked.";
  if (text.includes("COMP_HL1_REOPEN_ROUND_LOCKED")) return "The round's ballots are locked, so this heat cannot be reopened.";
  if (text.includes("COMP_HL1_REOPEN_DANCED")) return "This heat has been danced and cannot be reopened here. Changes go through the results correction workflow.";
  if (text.includes("COMPO1_HEAT_LOCKED")) return "The floor refused the change because the heat is locked.";
  if (text.includes("A reason is required")) return "A reason is required to reopen a locked heat.";
  if (text.includes("Locked or certified")) return "This heat is already locked or certified.";
  if (text.includes("Invalid heat lock state")) return "That lock state is not valid.";
  const code = text.match(/\b(COMPO1_[A-Z_]+|COMP_[A-Z_]+)\b/);
  return code ? `The heat could not be ${verb} (${code[1]}). Reload the page and try again.` : `The heat could not be ${verb}: ${text || "unknown error"}`;
}
