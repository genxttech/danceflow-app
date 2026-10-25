/*
  NS1: heat no-shows -- pure helpers (no I/O). The database functions (mark_competition_heat_no_show,
  void_competition_heat_no_show, competition_round_no_shows) stay the only authority; this decides what to show and
  how to word a refusal.
*/

export type NoShowRow = {
  no_show_id: string;
  heat_id: string;
  heat_number: number;
  heat_entry_id: string;
  entry_id: string;
  entry_number: string | null;
  display_name: string;
  reason: string;
  marked_at: string;
  voided: boolean;
  void_reason: string | null;
  voided_at: string | null;
};

/** The database window: round active (ballots open), heat active or complete, entry not scratched / danced / disqualified. */
export function canMarkNoShow(input: { roundStatus: string | undefined; heatStatus: string; entryStatus: string }) {
  return input.roundStatus === "active"
    && (input.heatStatus === "active" || input.heatStatus === "complete")
    && !["scratched", "danced", "disqualified"].includes(input.entryStatus);
}

/** Active (not voided) no-shows keyed by heat entry id. */
export function activeNoShows(rows: NoShowRow[] | null | undefined) {
  return new Map((rows ?? []).filter((row) => !row.voided).map((row) => [row.heat_entry_id, row]));
}

export function friendlyNoShowError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? "";
  const match = message.match(/COMP_NO_SHOW_[A-Z_]+:\s*([\s\S]+?)(?:\n|$)/);
  if (match) return match[1].replace(/\s+/g, " ").trim();
  if (/COMP_FORBIDDEN/.test(message)) return "Only the event manager or the chief judge can record a no-show.";
  if (/COMP_REQUEST_REUSED/.test(message)) return "That request was already used. Refresh and try again.";
  return "That change could not be saved. Refresh and try again.";
}

/**
 * A judge's submitted ballot is out of date when it no longer matches the heat's entries (a no-show was recorded or
 * voided after it was submitted). The database makes such a ballot stale and refuses to lock it until it is corrected.
 */
export function ballotNeedsCorrection(heatEntryIds: string[], markedEntryIds: string[]) {
  if (heatEntryIds.length !== markedEntryIds.length) return true;
  const set = new Set(heatEntryIds);
  return markedEntryIds.some((id) => !set.has(id));
}
