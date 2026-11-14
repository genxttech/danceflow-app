import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toStudioEngineInput } from "../engineAdapter";
import { canonicalEvidence, evidenceHash, normalizeEvidence, sha256Hex, type EvidenceExclusionReason, type EvidenceInput } from "../evidence";
import { excludedCoupleLabel, parseReviewExcluded } from "../reviewTypes";

// CF1 A3 (U72, U83): `fixtures/cf1a3-parity.json` is printed by sql-tests/test_T_competition_cf1_a3_results.sql (notices "CF1A3_PARITY")
// from the REAL SQL builder `_compf2_evidence` on the QA Postgres: one round with scratched + no-show + excluded couples, one round with no
// exclusion. SQL canonical text and sha256 are recorded next to each document; the TypeScript side must reproduce both byte for byte.
type ParityCase = { name: string; evidence: EvidenceInput; canonical: string; input_hash: string };
const cases = JSON.parse(readFileSync(join(__dirname, "fixtures", "cf1a3-parity.json"), "utf8")) as ParityCase[];

describe("CF1 A3 evidence parity with the database", () => {
  for (const c of cases) {
    it(`${c.name}: canonical JSON and sha256 equal the SQL builder's`, () => {
      expect(canonicalEvidence(c.evidence)).toBe(c.canonical);
      expect(evidenceHash(c.evidence)).toBe(c.input_hash);
      expect(sha256Hex(c.canonical)).toBe(c.input_hash);
    });
  }

  const excl = cases.find((c) => c.name === "excluded_precedence_r13") as ParityCase;
  const clean = cases.find((c) => c.name === "no_exclusion_r3") as ParityCase;

  it("the exclusion round carries all three reasons, one row per entry", () => {
    const reasons = excl.evidence.excludedEntries.map((e) => e.reason).sort();
    expect(reasons).toEqual(["excluded", "no_show", "scratched"]);
    expect(new Set(excl.evidence.excludedEntries.map((e) => e.entryId)).size).toBe(3);
    // participation is kept: every entry is still in `entries`, but only the ranking-set couples are in heats[].entryIds
    expect(excl.evidence.entries).toHaveLength(5);
    expect(excl.evidence.heats[0].entryIds).toHaveLength(2);
  });

  it("is independent of read order for the third reason too", () => {
    const shuffled: EvidenceInput = { ...excl.evidence, excludedEntries: [...excl.evidence.excludedEntries].reverse() };
    expect(evidenceHash(shuffled)).toBe(excl.input_hash);
    expect(normalizeEvidence(shuffled).excludedEntries).toEqual(normalizeEvidence(excl.evidence).excludedEntries);
  });

  it("the reason is hash-bound: relabelling an excluded couple as a no-show changes the hash", () => {
    const relabelled: EvidenceInput = {
      ...excl.evidence,
      excludedEntries: excl.evidence.excludedEntries.map((e) => (e.reason === "excluded" ? { ...e, reason: "no_show" as EvidenceExclusionReason } : e)),
    };
    expect(evidenceHash(relabelled)).not.toBe(excl.input_hash);
  });

  it("a round with no exclusion has no 'excluded' reason and the SQL hash is reproduced (U83: nothing changed for existing versions)", () => {
    expect(clean.evidence.excludedEntries).toEqual([]);
    expect(Object.keys(clean.evidence).sort()).toEqual(
      ["ballots", "chiefJudgeTiebreak", "danceIds", "engineKey", "engineVersion", "entries", "excludedEntries", "finalCapacity", "heats", "judges", "markScheme", "marks", "profile", "round", "scoreRolesSeparately", "tieBreakChain"].sort(),
    );
    expect(evidenceHash(clean.evidence)).toBe(clean.input_hash);
  });

  it("the engine input mapper passes the third reason through unchanged (U73: type level; no engine is registered in this tree)", () => {
    const input = toStudioEngineInput(excl.evidence);
    expect(input.context.excludedEntries.filter((e) => e.reason === "excluded")).toHaveLength(1);
    expect(input.context.heats[0].entryIds).toEqual(excl.evidence.heats[0].entryIds);
  });
});

describe("CF1 A3 review 'excluded' section", () => {
  const row = {
    entry_id: "e1", entry_number: "73", display_name: "Pat and Sam", exclusion_id: "x1", decision_id: "x0", seq: 2, state: "excluded",
    reason_kind: "refunded", reason: "Registration refunded after the heat was danced", requested_by: "u1", requested_by_role: "manager", requested_at: "2026-10-30T00:00:00Z",
    requested_by_name: "A manager", cosigned_by: "u2", cosigned_by_role: "chair", cosigned_at: "2026-10-30T00:01:00Z", cosigned_by_name: "A manager",
  };

  it("reads the section and shows the recorded reason (never a no-show)", () => {
    const couples = parseReviewExcluded({ excluded: [row] });
    expect(couples).toHaveLength(1);
    expect(excludedCoupleLabel(couples[0])).toBe("Excluded (refunded), Registration refunded after the heat was danced");
    expect(excludedCoupleLabel(couples[0])).not.toMatch(/no.?show/i);
  });

  it("tolerates a database without A3 (key absent) and drops malformed rows", () => {
    expect(parseReviewExcluded({ versions: [] })).toEqual([]);
    expect(parseReviewExcluded(null)).toEqual([]);
    expect(parseReviewExcluded({ excluded: [{ entry_id: "e1" }, { ...row, reason_kind: "other-thing" }, row] })).toHaveLength(1);
  });
});
