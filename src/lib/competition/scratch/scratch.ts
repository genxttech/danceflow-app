/**
 * SC1 (live-line port): rules shared by the scratch page and its server action.
 *
 * The database stays the authority. A scratch is ONE call to the audited `change_competition_entry_lifecycle`
 * RPC as the signed-in manager: it updates the parent entry first (the audit trigger writes the
 * `event_competition_entry_changes` row with the reason), then scratches the entry's scheduled / checked-in heat
 * entries. The U18-S heat-entry guard only accepts that sequence. Nothing here moves money: a scratch records no fee
 * decision (fee handling `not_applicable`) and never requests, issues or changes a refund, credit or fee. Refunds are
 * the separate R2 workflow.
 *
 * Vocabulary (OD-20): Scratch, No-show, Excluded (organizer decision, the two-person CF1 A5 action with its own
 * records) and a stored `disqualified` status are four different things. No DanceFlow action writes `disqualified`,
 * so it is never presented as an organizer exclusion or as a supported action.
 * A scratch is the organizer or studio withdrawing an entry before it competes; it is never a disqualification and
 * never a placing. Scoring treatment (R-08) is unchanged: scratched entries are excluded from calculation and are
 * never placed last.
 */

/** The lifecycle RPC parameters this workflow sends. Fixed: the app never chooses a fee handling. */
export const SCRATCH_RPC = "change_competition_entry_lifecycle";
export const SCRATCH_STATUS = "scratched";
export const SCRATCH_FEE_HANDLING = "not_applicable";
export const SCRATCH_REASON_MAX = 500;

/** Entry statuses a scratch may start from. Anything else is refused before the RPC is called. */
const SCRATCHABLE = ["pending", "confirmed", "waitlisted"] as const;
const ALREADY_OUT = ["scratched", "withdrawn"] as const;

export function isScratchable(status: string): boolean {
  return (SCRATCHABLE as readonly string[]).includes(status);
}

/** Already out of the competition: a repeat request is a no-op (replay / double submit). */
export function isAlreadyScratched(status: string): boolean {
  return (ALREADY_OUT as readonly string[]).includes(status);
}

/** The stored status has no DanceFlow writer (OD-20): name it as a stored status, not as anyone's decision. */
export const DISQUALIFIED_STATUS_LABEL = "Disqualified status (not a DanceFlow decision)";

/** Competition-facing entry status wording. Each stored status keeps its own words. */
export function entryStatusLabel(status: string): string {
  switch (status) {
    case "scratched":
      return "Scratched";
    case "withdrawn":
      return "Withdrawn";
    case "disqualified":
      return DISQUALIFIED_STATUS_LABEL;
    default:
      return status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
}

export function heatEntryStatusLabel(status: string): string {
  switch (status) {
    case "scratched":
      return "Scratched";
    case "disqualified":
      return DISQUALIFIED_STATUS_LABEL;
    case "danced":
      return "Danced";
    case "checked_in":
      return "Checked in";
    default:
      return "Scheduled";
  }
}

export type PlacementState = { heatLockState: string; placementStatus: string; heatStatus?: string | null };

/** Most protective state across an entry's heat entries (the R2 / SC1 rule: nothing marks placements `danced` yet). */
export type PlacementClass = "certified" | "disqualified" | "danced" | "locked" | "open" | "unplaced";

export function classifyPlacements(placements: PlacementState[]): PlacementClass {
  const live = placements.filter((p) => p.placementStatus !== "scratched");
  if (live.some((p) => p.heatLockState === "certified")) return "certified";
  if (placements.some((p) => p.placementStatus === "disqualified")) return "disqualified";
  if (
    placements.some((p) => p.placementStatus === "danced") ||
    live.some((p) => p.heatStatus === "active" || p.heatStatus === "complete")
  ) {
    return "danced";
  }
  if (placements.some((p) => p.heatLockState === "locked" || p.heatLockState === "certified")) return "locked";
  return placements.length > 0 ? "open" : "unplaced";
}

export type ScratchRefusal =
  | "COMP_SC1_NOT_FOUND"
  | "COMP_SC1_NOT_SCRATCHABLE"
  | "COMP_SC1_LOCKED"
  | "COMP_SC1_CERTIFIED"
  | "COMP_SC1_DANCED"
  | "COMP_SC1_DISQUALIFIED_PLACEMENT"
  | "COMP_SC1_REASON_REQUIRED"
  | "COMP_SC1_STRANDED"
  | "COMP_SC1_INCONSISTENT";

export type ScratchPreflight = { allowed: true } | { allowed: false; code: ScratchRefusal };

/** Pure preflight. The RPC re-checks locked / certified and authority; "danced in an unlocked heat" is app-enforced only. */
export function scratchPreflight(input: { entryStatus: string; placementClass: PlacementClass }): ScratchPreflight {
  if (!isScratchable(input.entryStatus)) return { allowed: false, code: "COMP_SC1_NOT_SCRATCHABLE" };
  if (input.placementClass === "certified") return { allowed: false, code: "COMP_SC1_CERTIFIED" };
  if (input.placementClass === "disqualified") return { allowed: false, code: "COMP_SC1_DISQUALIFIED_PLACEMENT" };
  if (input.placementClass === "danced") return { allowed: false, code: "COMP_SC1_DANCED" };
  if (input.placementClass === "locked") return { allowed: false, code: "COMP_SC1_LOCKED" };
  return { allowed: true };
}

/** History time in the event's time zone, always labelled; an unknown zone falls back to UTC. */
export function formatChangeTime(iso: string, timeZone: string | null | undefined): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone, timeZoneName: "short" }).format(new Date(iso));
  try {
    return format(timeZone || "UTC");
  } catch {
    return format("UTC");
  }
}

export function normalizeReason(value: string | null | undefined): string | null {
  // Browsers submit textarea line breaks as CRLF while maxLength counts them as one character.
  const reason = (value ?? "").replace(/\r\n/g, "\n").trim();
  return reason.length >= 1 && reason.length <= SCRATCH_REASON_MAX ? reason : null;
}

/**
 * After the RPC: the parent entry is scratched and no heat entry of it is still scheduled / checked in. Danced and
 * disqualified heat entries are never rewritten by a scratch (and the preflight refuses to start from them).
 */
export function scratchConsistent(entryStatus: string | null | undefined, heatEntryStatuses: string[]): boolean {
  return entryStatus === "scratched" && !hasOpenPlacement(heatEntryStatuses);
}

/** A heat entry that is still scheduled or checked in. */
export function hasOpenPlacement(heatEntryStatuses: string[]): boolean {
  return heatEntryStatuses.some((s) => s === "scheduled" || s === "checked_in");
}

const ERROR_MESSAGES: Record<string, string> = {
  COMP_SC1_NOT_FOUND: "This entry was not found, or you cannot manage it.",
  COMP_SC1_NOT_SCRATCHABLE: "This entry can no longer be scratched.",
  COMP_SC1_LOCKED: "This entry is in a locked heat. Changes go through the correction workflow.",
  COMP_SC1_CERTIFIED: "This entry is in a certified heat. Changes go through the results correction workflow.",
  COMP_SC1_DANCED: "A heat of this entry has started or finished, or a danced or disqualified status is recorded. Changes go through the results correction workflow.",
  COMP_SC1_DISQUALIFIED_PLACEMENT: "A heat placement of this entry carries a disqualified status. Changes go through the results correction workflow.",
  COMP_SC1_REASON_REQUIRED: "Give a reason (up to 500 characters). It is recorded permanently.",
  COMP_SC1_INCONSISTENT: "The scratch could not be confirmed (the entry or its heat placements did not read back as scratched). Reload and check the entry before trying again.",
  COMP_SC1_STRANDED: "This entry is already out of the competition but still has open heat placements. Nothing was changed. Have the entry corrected before the heat runs.",
  COMP_SC1_UNAUDITED: "A heat entry can only be scratched through the audited scratch workflow.",
  COMP_SC1_UNKNOWN: "The entry could not be scratched. Try again.",
};

/** Maps a database refusal to a stable code (carried in a URL instead of free text). */
export function scratchErrorCode(raw: string | null | undefined): ScratchRefusal | "COMP_SC1_UNAUDITED" | "COMP_SC1_UNKNOWN" {
  const text = raw ?? "";
  if (/COMP_U18S_SCRATCH_UNAUDITED|COMP_U18S_UNSCRATCH_WRITER/.test(text)) return "COMP_SC1_UNAUDITED";
  if (/COMP_ENTRY_LIFECYCLE_PLACED/.test(text)) return "COMP_SC1_DANCED"; // S6 20270301140000 (draft, not applied)
  if (/COMP_ENTRY_LIFECYCLE_STATE/.test(text)) return "COMP_SC1_NOT_SCRATCHABLE";
  if (/locked or certified heat/i.test(text)) return "COMP_SC1_LOCKED";
  if (/not found or cannot be managed|row-level security/i.test(text)) return "COMP_SC1_NOT_FOUND";
  const known = Object.keys(ERROR_MESSAGES).find((key) => text.includes(key));
  return (known as ScratchRefusal | undefined) ?? "COMP_SC1_UNKNOWN";
}

export function scratchErrorMessage(code: string | null | undefined): string {
  // The code comes from the URL: only own keys, never prototype members.
  return code && Object.hasOwn(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : ERROR_MESSAGES.COMP_SC1_UNKNOWN;
}
