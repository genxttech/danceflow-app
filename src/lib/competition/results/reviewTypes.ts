/**
 * CF1 A3 (design 4.7): the `excluded` section of `competition_round_results_review(round)`.
 *
 * One entry per couple currently excluded from the round's ranking set, with the recorded reason. The couple keeps its heat entry,
 * ballots and marks (participation is retained), has no placement or rank, and must be shown as "Excluded (reason kind), with the
 * recorded reason" -- never as a no-show and never silently omitted. A round with no exclusion returns `[]`.
 */
export type ReviewExclusionReasonKind = "ineligible" | "refunded" | "other";

export type ReviewExcludedCouple = {
  entry_id: string;
  entry_number: string | null;
  display_name: string | null;
  exclusion_id: string;
  /** The request row the effective co-signed row completes. */
  decision_id: string | null;
  seq: number;
  state: "excluded";
  reason_kind: ReviewExclusionReasonKind;
  reason: string;
  requested_by: string | null;
  requested_by_role: "chair" | "manager" | null;
  requested_at: string | null;
  requested_by_name: string;
  cosigned_by: string | null;
  cosigned_by_role: "chair" | "manager" | null;
  cosigned_at: string | null;
  cosigned_by_name: string;
};

const KINDS: readonly string[] = ["ineligible", "refunded", "other"];

/** Defensive reader: tolerates a database without A3 (key absent) and drops malformed rows instead of throwing. */
export function parseReviewExcluded(review: unknown): ReviewExcludedCouple[] {
  const raw = (review as { excluded?: unknown } | null | undefined)?.excluded;
  if (!Array.isArray(raw)) return [];
  const out: ReviewExcludedCouple[] = [];
  for (const item of raw) {
    const r = item as Partial<ReviewExcludedCouple> | null;
    if (!r || typeof r.entry_id !== "string" || typeof r.exclusion_id !== "string" || typeof r.reason !== "string") continue;
    if (typeof r.reason_kind !== "string" || !KINDS.includes(r.reason_kind)) continue;
    out.push(r as ReviewExcludedCouple);
  }
  return out;
}

/** The label a results page or a publication shows for an excluded couple (F3 owns the final wording; this is the required content). */
export function excludedCoupleLabel(couple: Pick<ReviewExcludedCouple, "reason_kind" | "reason">): string {
  return `Excluded (${couple.reason_kind}), ${couple.reason}`;
}
