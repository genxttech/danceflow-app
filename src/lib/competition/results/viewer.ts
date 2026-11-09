/**
 * F3 results visibility (read only). The database is the authority: competition_my_results (entrant, own division) and
 * competition_event_results_public (anon + authenticated, only a CURRENT publication chosen as public of a published public event) decide
 * what exists. Unpublished, withdrawn, superseded and unresolved results are never returned by those readers, and an excluded couple is never
 * named on the public path. This module only parses the payloads defensively (malformed rows are dropped, never guessed) and merges the two views.
 */

export type ViewerRow = {
  entryNumber: string;
  displayName: string | null;
  placement: number | null;
  tieGroup: string | null;
  advanced: boolean | null;
  ratingBand: string | null;
  mine: boolean;
};
export type ViewerExcluded = { entryNumber: string; displayName: string | null; mine: boolean };
export type ViewerRound = {
  publicationId: string;
  publicationVersion: number;
  publishedAt: string | null;
  visibility: "entrants" | "public";
  roundId: string;
  roundName: string;
  roundType: string;
  divisionName: string | null;
  programName: string | null;
  rows: ViewerRow[];
  excluded: ViewerExcluded[];
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function parseViewerRounds(raw: unknown): ViewerRound[] {
  if (!Array.isArray(raw)) return [];
  const out: ViewerRound[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const pub = p.publication as Record<string, unknown> | null | undefined;
    const round = p.round as Record<string, unknown> | null | undefined;
    if (!pub || !round || typeof pub.id !== "string" || typeof round.id !== "string" || typeof pub.version !== "number") continue;
    const visibility = pub.visibility === "public" ? "public" : pub.visibility === "entrants" ? "entrants" : null;
    if (!visibility) continue;
    const rows: ViewerRow[] = [];
    for (const r of Array.isArray(p.rows) ? p.rows : []) {
      const x = r as Record<string, unknown>;
      if (!x || typeof x !== "object" || str(x.entry_number) === null) continue;
      rows.push({
        entryNumber: String(x.entry_number),
        displayName: str(x.display_name),
        placement: typeof x.placement === "number" ? x.placement : null,
        tieGroup: str(x.tie_group),
        advanced: typeof x.advanced === "boolean" ? x.advanced : null,
        ratingBand: str(x.rating_band),
        mine: x.mine === true,
      });
    }
    const excluded: ViewerExcluded[] = [];
    for (const r of Array.isArray(p.excluded) ? p.excluded : []) {
      const x = r as Record<string, unknown>;
      if (!x || typeof x !== "object" || str(x.entry_number) === null) continue;
      excluded.push({ entryNumber: String(x.entry_number), displayName: str(x.display_name), mine: x.mine === true });
    }
    out.push({
      publicationId: pub.id,
      publicationVersion: pub.version,
      publishedAt: str(pub.published_at),
      visibility,
      roundId: round.id,
      roundName: str(round.name) ?? "Round",
      roundType: str(round.round_type) ?? "",
      divisionName: str(round.division_name),
      programName: str(round.program_name),
      rows,
      excluded,
    });
  }
  return out;
}

/**
 * The entrant's own view first (it carries the `mine` flags and, for an entrants-only publication, the viewer's own names), then any public
 * publication not already shown. Never invents a result: a publication id appears at most once.
 */
export function mergeViewerRounds(mine: ViewerRound[], publicRounds: ViewerRound[]): ViewerRound[] {
  const seen = new Set(mine.map((r) => r.publicationId));
  return [...mine, ...publicRounds.filter((r) => !seen.has(r.publicationId))];
}

export function placementLabel(row: ViewerRow): string {
  if (row.placement === null) return row.advanced === true ? "Advanced" : row.advanced === false ? "Not advanced" : "No placement";
  return row.tieGroup ? `${row.placement} (tie)` : String(row.placement);
}
