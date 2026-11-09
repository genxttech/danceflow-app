import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evidenceHash, type EvidenceInput } from "../evidence";

// Driven by sql-tests/concurrency/run_f2_races.sh: F2_EVIDENCE_JSON points at the output of
// competition_round_calculation_input for a real locked round. Skipped in ordinary runs.
const path = process.env.F2_EVIDENCE_JSON;

describe.skipIf(!path)("evidence hash parity with the database", () => {
  it("recomputes the database input_hash from the evidence document", () => {
    const data = JSON.parse(readFileSync(path as string, "utf8")) as { evidence: EvidenceInput; input_hash: string };
    expect(data.evidence.marks.length).toBeGreaterThan(0);
    expect(evidenceHash(data.evidence)).toBe(data.input_hash);
  });
});
