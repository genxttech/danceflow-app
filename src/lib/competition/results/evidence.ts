/**
 * F2: the evidence input that calculate/approve bind their input_hash to.
 *
 * The document is built in SQL from the CURRENT ballots (`_compf2_evidence`, migration 20270114090000) and returned by
 * `competition_round_calculation_input`. The app never invents it: it hashes what the database returned with the K0
 * canonical serialization and cross-checks the database's own hash (a mismatch means the two implementations disagree and
 * the calculation is refused). `calculate_competition_round` then recomputes the hash from the ballots at write time, so a
 * ballot that arrives between read and write is rejected as COMP_RESULT_STALE.
 *
 * No scoring happens here.
 */
import { createHash } from "node:crypto";
import { canonicalJson } from "./contract";

export type EvidenceMark = {
  officialId: string;
  entryId: string;
  /** null for callback (round-level) ballots. */
  heatId: string | null;
  role: null;
  value: unknown;
};

export type EvidenceHeat = { heatId: string; officialIds: string[]; entryIds: string[] };

export type EvidenceInput = {
  engineKey: string;
  engineVersion: string;
  /** Locked (10B) rules profile; null when the program was never locked. */
  profile: { key: string; version: number } | null;
  /** Always null for engine @1 (the engines use their default scheme, K1 X-1 option (a)). */
  markScheme: unknown;
  /** Always [] for engine @1 (ignored by the engines). */
  tieBreakChain: string[];
  round: { id: string; roundType: string; targetAdvancementCount: number | null; advancementMethod: string | null };
  /** X-3 option flags of the round. */
  chiefJudgeTiebreak: boolean;
  scoreRolesSeparately: boolean;
  /** The next round's heat capacity (10D), null when the round has no successor. */
  finalCapacity: number | null;
  /** Every entry on the ballot heats, scratched ones included. */
  entries: Array<{ entryId: string }>;
  /** X-5: scratched entries with no live heat entry in the round. */
  excludedEntries: Array<{ entryId: string; reason: "scratched" | "no_show" }>;
  /** X-7: each ballot heat with the panel that judged it and its live entries. */
  heats: EvidenceHeat[];
  /** X-6: dances of the ballot heats. */
  danceIds: string[];
  judges: Array<{ officialId: string; letter: string }>;
  ballots: Array<{ ballotId: string; heatId: string | null; officialId: string; version: number }>;
  marks: EvidenceMark[];
};

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Same ordering the SQL builder applies, so the hash never depends on read order. */
export function normalizeEvidence(input: EvidenceInput): EvidenceInput {
  return {
    ...input,
    entries: [...input.entries].sort((a, b) => cmp(a.entryId, b.entryId)),
    excludedEntries: [...input.excludedEntries].sort((a, b) => cmp(a.entryId, b.entryId)),
    heats: input.heats
      .map((h) => ({ heatId: h.heatId, officialIds: [...h.officialIds].sort(cmp), entryIds: [...h.entryIds].sort(cmp) }))
      .sort((a, b) => cmp(a.heatId, b.heatId)),
    danceIds: [...input.danceIds].sort(cmp),
    judges: [...input.judges].sort((a, b) => cmp(a.officialId, b.officialId)),
    ballots: [...input.ballots].sort((a, b) => cmp(a.ballotId, b.ballotId)),
    marks: [...input.marks].sort(
      (a, b) => cmp(a.officialId, b.officialId) || cmp(a.entryId, b.entryId) || cmp(a.heatId ?? "", b.heatId ?? ""),
    ),
  };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function canonicalEvidence(input: EvidenceInput): string {
  return canonicalJson(normalizeEvidence(input));
}

export function evidenceHash(input: EvidenceInput): string {
  return sha256Hex(canonicalEvidence(input));
}

/** trace_hash = sha256(canonicalJson(trace)) (K0 section 5). */
export function traceHash(trace: unknown[]): string {
  return sha256Hex(canonicalJson(trace));
}
