import "server-only";
import { notFound } from "next/navigation";

/**
 * Competition Finals (CF1 + its foundation: officials, ballots, judging desk, day-of, studio scoring, callback
 * targets, results, public results) is DARK BY DEFAULT.
 *
 * - `COMPETITION_FINALS_ENABLED` must be exactly "true" for any CF1 page, server action or navigation entry to exist.
 *   Unset, empty or any other value means OFF. It is read only on the server (never a NEXT_PUBLIC_ variable), so the
 *   browser bundle can neither read nor override it.
 * - The public results page additionally needs `COMPETITION_PUBLIC_RESULTS_ENABLED` = "true". Public visibility of
 *   results is a separate owner decision; enabling the organizer workspace never exposes anything publicly.
 *
 * With the flag OFF every page and server action added by CF1 answers notFound() before it reads a session, creates a
 * database client or touches any input, and every live page CF1 modified renders and behaves exactly as the release it
 * was built on. This is defense in depth: the database gates (R2 refund gate, OD-17, publication, desk-suite gate,
 * RLS) stay authoritative and are never relaxed by this flag.
 */
export function competitionFinalsEnabled(): boolean {
  return process.env.COMPETITION_FINALS_ENABLED === "true";
}

export function competitionPublicResultsEnabled(): boolean {
  return competitionFinalsEnabled() && process.env.COMPETITION_PUBLIC_RESULTS_ENABLED === "true";
}

/** First statement of every CF1 page and server action. Throws Next's notFound() when Competition Finals is off. */
export function requireCompetitionFinals(): void {
  if (!competitionFinalsEnabled()) notFound();
}

/** First statement of the public results page. */
export function requireCompetitionPublicResults(): void {
  if (!competitionPublicResultsEnabled()) notFound();
}
