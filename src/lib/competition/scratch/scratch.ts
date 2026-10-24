/**
 * SC1: competition scratch rules shared by the scratch page and its server action. The database
 * (scratch_competition_entry) is the authority; these helpers only decide what the page offers and how
 * refusals read. A scratch never moves money: Refund and Competition credit are separate workflows.
 */

export type ScratchResolution = "no_refund" | "credit" | "refund";

export const SCRATCH_RESOLUTIONS: Array<{ key: ScratchResolution; label: string; description: string; available: boolean }> = [
  { key: "no_refund", label: "No refund", description: "Scratch the entry. The original payment is not changed.", available: true },
  {
    key: "credit",
    label: "Future competition credit",
    description: "Issue a credit for a future competition. Not available yet.",
    available: false,
  },
  {
    key: "refund",
    label: "Refund",
    description: "Scratch now and mark the entry for the separate refund workflow. Scratching itself moves no money.",
    available: true,
  },
];

export function resolutionLabel(value: string | null | undefined): string {
  return SCRATCH_RESOLUTIONS.find((r) => r.key === value)?.label ?? "No refund";
}

/** S-D1: both stored statuses read as "Scratched" in competition-facing UI. */
export function entryStatusLabel(status: string): string {
  if (status === "scratched" || status === "withdrawn") return "Scratched";
  return status.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function isScratchable(status: string): boolean {
  return status === "pending" || status === "confirmed" || status === "waitlisted";
}

export type PlacementState = { heatLockState: string; placementStatus: string };

/** The most protective state across an entry's placements (mirrors the SQL order of checks). */
export type PlacementClass = "certified" | "danced" | "locked" | "open" | "unplaced";

export function classifyPlacements(placements: PlacementState[]): PlacementClass {
  if (placements.some((p) => p.heatLockState === "certified")) return "certified";
  if (placements.some((p) => p.placementStatus === "danced" || p.placementStatus === "disqualified")) return "danced";
  if (placements.some((p) => p.heatLockState === "locked" && (p.placementStatus === "scheduled" || p.placementStatus === "checked_in"))) {
    return "locked";
  }
  return placements.length > 0 ? "open" : "unplaced";
}

export type ScratchDecision =
  | { allowed: false; reason: string }
  | { allowed: true; needsOfficial: boolean; needsReason: boolean; isException: boolean; lockedHeat: boolean };

export function scratchDecision(input: {
  placementClass: PlacementClass;
  policy: ScratchResolution;
  resolution: ScratchResolution;
  isOfficial: boolean;
}): ScratchDecision {
  if (input.placementClass === "certified") {
    return { allowed: false, reason: "This entry is in a certified heat. Changes go through the results correction workflow." };
  }
  if (input.placementClass === "danced") {
    return { allowed: false, reason: "This entry has already danced. Changes go through the results correction workflow." };
  }
  if (input.resolution === "credit") {
    return { allowed: false, reason: "Competition credit is not available yet." };
  }
  const lockedHeat = input.placementClass === "locked";
  const isException = input.resolution !== input.policy;
  const needsOfficial = lockedHeat || isException;
  if (needsOfficial && !input.isOfficial) {
    return {
      allowed: false,
      reason: lockedHeat
        ? "Only a studio or organizer owner/admin can scratch an entry in a locked heat."
        : "Only a studio or organizer owner/admin can choose a resolution other than the scratch policy.",
    };
  }
  return { allowed: true, needsOfficial, needsReason: needsOfficial, isException, lockedHeat };
}

const ERROR_MESSAGES: Record<string, string> = {
  COMP_SC1_NOT_FOUND: "This entry was not found or you cannot manage it.",
  COMP_SC1_ALREADY_SCRATCHED: "This entry is already scratched.",
  COMP_SC1_NOT_SCRATCHABLE: "This entry can no longer be scratched.",
  COMP_SC1_CERTIFIED: "This entry is in a certified heat. Changes go through the results correction workflow.",
  COMP_SC1_DANCED: "This entry has already danced. Changes go through the results correction workflow.",
  COMP_SC1_OFFICIAL_REQUIRED: "Only a studio or organizer owner/admin can make this scratch.",
  COMP_SC1_REASON_REQUIRED: "A reason is required for this scratch.",
  COMP_SC1_RESOLUTION: "Choose No refund or Refund.",
  COMP_SC1_CREDIT_NOT_AVAILABLE: "Competition credit is not available yet.",
  COMP_SC1_REQUEST_REUSED: "This form was already used. Reload the page and try again.",
};

export function scratchErrorMessage(raw: string | null | undefined): string {
  const code = Object.keys(ERROR_MESSAGES).find((key) => (raw ?? "").includes(key));
  return code ? ERROR_MESSAGES[code] : "The entry could not be scratched. Try again.";
}

export function parseResolution(value: string | null | undefined): ScratchResolution | null {
  return value === "no_refund" || value === "credit" || value === "refund" ? value : null;
}
