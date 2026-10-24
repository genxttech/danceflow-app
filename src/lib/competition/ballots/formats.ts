/**
 * Ballot FORMAT registry (E2).
 *
 * A ballot format is independent of sanctioning, competition format, scoring method and engine: it only says what a
 * judge's marks look like and how they are validated. Ballots store `ballot_format` + `ballot_format_version`; marks are
 * jsonb validated against that format. The set is open: a new format (for example a future UCWDC format) is one entry here,
 * one SQL registry row and one validator; ballots and marks storage do not change. No UCWDC/NDCA/WSDC format exists yet
 * because none has an approved spec.
 *
 * Which engine accepts which format is F1/registry work, not decided here.
 */

export type BallotFormatKey = `${string}@${number}`;

export type BallotFormat = {
  id: string;
  version: number;
  /** Only approved formats accept ballots; everything else fails closed. */
  approved: boolean;
  /** 'heat' = one ballot per judge and heat; 'round' = one per judge for the whole round (heat_id null). */
  scope: "heat" | "round";
  /** K1 decisions behind the format (provisional rules stay tagged with their decision id). */
  decisions: string[];
};

export const BALLOT_FORMATS: readonly BallotFormat[] = [
  { id: "ordinal_rank", version: 1, approved: true, scope: "heat", decisions: ["D-OM-4", "D-OM-5"] },
  { id: "callback_yes", version: 1, approved: true, scope: "round", decisions: ["D-CT-1", "D-CT-2", "D-CT-5"] },
  // Gold/Silver/Bronze: the three-band median proposal is NOT approved, so this format fails closed.
  { id: "three_band", version: 1, approved: false, scope: "heat", decisions: ["D-PR-3", "D-PR-5"] },
];

export function formatKey(id: string, version: number): BallotFormatKey {
  return `${id}@${version}`;
}

export function findBallotFormat(id: string, version: number): BallotFormat | null {
  return BALLOT_FORMATS.find((format) => format.id === id && format.version === version) ?? null;
}

/**
 * Today a round's ballot format follows its scoring method (the only selector that exists). When scoring methods become a
 * versioned registry chosen per division, this mapping is the single place that changes; stored ballots already carry
 * their own format id and version.
 */
const FORMAT_FOR_SCORING: Record<string, { id: string; version: number }> = {
  ordinal_majority: { id: "ordinal_rank", version: 1 },
  callback_tally: { id: "callback_yes", version: 1 },
  proficiency_rating: { id: "three_band", version: 1 },
};

export function ballotFormatForScoring(scoringMethod: string): { id: string; version: number } | null {
  return FORMAT_FOR_SCORING[scoringMethod] ?? null;
}
