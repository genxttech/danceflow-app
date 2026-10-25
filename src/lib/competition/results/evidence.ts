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

export type EvidenceInput = {
  engineKey: string;
  engineVersion: string;
  round: { id: string; roundType: string; targetAdvancementCount: number | null; advancementMethod: string | null };
  entries: Array<{ entryId: string }>;
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
