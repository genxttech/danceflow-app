/**
 * F3 publication (release blocker RB2). The database is the authority (publish_competition_round_result / withdraw_competition_round_result);
 * this module only decides which controls a manager sees and parses the history the page reads. Nothing here publishes anything.
 */

export type PublicationVisibility = "entrants" | "public";
export type PublicationState = "current" | "withdrawn" | "superseded";

export type PublicationRecord = {
  id: string;
  publicationVersion: number;
  resultVersionId: string;
  visibility: PublicationVisibility;
  publishedAt: string | null;
  withdrawnAt: string | null;
  withdrawnReason: string | null;
  state: PublicationState;
};

const VISIBILITIES: readonly string[] = ["entrants", "public"];
const STATES: readonly string[] = ["current", "withdrawn", "superseded"];

/** Only the two values the database accepts; anything else is refused before a request is made (fail closed, never defaults to public). */
export function parseVisibility(raw: unknown): PublicationVisibility | null {
  const value = typeof raw === "string" ? raw.trim() : "";
  return VISIBILITIES.includes(value) ? (value as PublicationVisibility) : null;
}

/** competition_round_publications(round) -> records, newest first. Malformed rows are dropped, never guessed. */
export function parsePublications(raw: unknown): PublicationRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PublicationRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const visibility = parseVisibility(r.visibility);
    const state = typeof r.state === "string" && STATES.includes(r.state) ? (r.state as PublicationState) : null;
    if (typeof r.id !== "string" || typeof r.result_version_id !== "string" || typeof r.publication_version !== "number" || !visibility || !state) continue;
    out.push({
      id: r.id,
      publicationVersion: r.publication_version,
      resultVersionId: r.result_version_id,
      visibility,
      publishedAt: typeof r.published_at === "string" ? r.published_at : null,
      withdrawnAt: typeof r.withdrawn_at === "string" ? r.withdrawn_at : null,
      withdrawnReason: typeof r.withdrawn_reason === "string" ? r.withdrawn_reason : null,
      state,
    });
  }
  return out.sort((a, b) => b.publicationVersion - a.publicationVersion);
}

export type PublicationControlsInput = {
  isManager: boolean;
  roundStatus: string;
  /** The round's newest result version (the only one that can be published). */
  latestVersion: { id: string; status: string; stale: boolean } | null;
  /** True when a callback result still has an undecided row (a tie over the Final's capacity). */
  unresolvedTie: boolean;
  publications: PublicationRecord[];
};

export type PublicationControls = {
  current: PublicationRecord | null;
  /** Publish the latest approved version (offered only when the round is approved and nothing blocks it on this screen). */
  publishVersionId: string | null;
  /** Why publish is not offered although the round is approved; the database repeats every one of these. */
  publishBlockedReason: string | null;
  /** Withdraw the CURRENT publication (offered while published, complete, or being corrected). */
  withdrawPublicationId: string | null;
  /** A withdrawn latest publication with no replacement: recovery is a correction, never an un-withdraw. */
  needsCorrection: boolean;
};

const WITHDRAW_STATES = ["published", "complete", "ballots_locked", "calculated", "approved"];

export function publicationControls(input: PublicationControlsInput): PublicationControls {
  const current = input.publications.find((p) => p.state === "current") ?? null;
  const none: PublicationControls = { current, publishVersionId: null, publishBlockedReason: null, withdrawPublicationId: null, needsCorrection: false };
  if (!input.isManager) return none;
  const withdrawPublicationId = current && WITHDRAW_STATES.includes(input.roundStatus) ? current.id : null;
  const latestPub = input.publications[0] ?? null;
  const needsCorrection = !current && input.roundStatus === "published" && latestPub?.state === "withdrawn";
  if (input.roundStatus !== "approved") return { ...none, withdrawPublicationId, needsCorrection };
  const v = input.latestVersion;
  let blocked: string | null = null;
  if (!v || v.status !== "approved") blocked = "The latest result version is not approved.";
  else if (v.stale) blocked = "The ballots changed after this result was approved. Open a correction and recalculate.";
  else if (input.unresolvedTie) blocked = "This callback result has an undecided tie. It cannot be published until the tie is resolved.";
  else if (input.publications.some((p) => p.resultVersionId === v.id)) blocked = "This result version was already published. A corrected, newly approved version is needed.";
  return { ...none, withdrawPublicationId, publishVersionId: blocked ? null : (v?.id ?? null), publishBlockedReason: blocked };
}
