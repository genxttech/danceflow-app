import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approvalAllowed, canonicalJson, RESULT_EVENT_KINDS, RESULT_ERROR_CODES } from "../contract";
import { calculateRound, type Rpc } from "../calculate";
import { REGISTERED_ENGINES, lookupRegisteredEngine } from "../engineAdapter";
import { canonicalEvidence, evidenceHash, normalizeEvidence, sha256Hex, traceHash, type EvidenceInput } from "../evidence";
import { resultErrorMessage } from "../messages";
import { stubEngine } from "./stubEngine";

// Shared with sql-tests/test_T_competition_f2_results.sql: the SQL canonicalizer + sha256 must reproduce this exactly.
export const GOLDEN_DOC = { zeta: [3, 1, { b: null, a: true }], Alpha: 'q"u\\o\nte é', n: { y: 0, x: -5 }, empty: {}, list: [] };
export const GOLDEN_CANONICAL = '{"Alpha":"q\\"u\\\\o\\nte é","empty":{},"list":[],"n":{"x":-5,"y":0},"zeta":[3,1,{"a":true,"b":null}]}';
export const GOLDEN_HASH = "6f684ff05c7edb2c86c41efa2a9e3da721bacc59453573d90689a195af940fb3";

const R = "00000000-0000-0000-0000-000000000001";
const J1 = "00000000-0000-0000-0000-0000000000a1";
const J2 = "00000000-0000-0000-0000-0000000000a2";
const E1 = "00000000-0000-0000-0000-0000000000e1";
const E2 = "00000000-0000-0000-0000-0000000000e2";
const H1 = "00000000-0000-0000-0000-0000000000d1";

function evidence(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    engineKey: "studio_ordinal_majority",
    engineVersion: "1",
    profile: { key: "studio_simple", version: 1 },
    markScheme: { input: "placement_marks", scored_by: "entry" },
    tieBreakChain: [],
    round: { id: R, roundType: "final", targetAdvancementCount: null, advancementMethod: null },
    chiefJudgeTiebreak: false,
    scoreRolesSeparately: false,
    finalCapacity: null,
    entries: [{ entryId: E2 }, { entryId: E1 }],
    excludedEntries: [],
    heats: [{ heatId: H1, officialIds: [J2, J1], entryIds: [E2, E1] }],
    danceIds: ["waltz"],
    judges: [{ officialId: J2, letter: "B" }, { officialId: J1, letter: "A" }],
    ballots: [
      { ballotId: "00000000-0000-0000-0000-0000000000b2", heatId: H1, officialId: J2, version: 1 },
      { ballotId: "00000000-0000-0000-0000-0000000000b1", heatId: H1, officialId: J1, version: 1 },
    ],
    marks: [
      { officialId: J2, entryId: E2, heatId: H1, role: null, value: 1 },
      { officialId: J1, entryId: E1, heatId: H1, role: null, value: 1 },
      { officialId: J2, entryId: E1, heatId: H1, role: null, value: 2 },
      { officialId: J1, entryId: E2, heatId: H1, role: null, value: 2 },
    ],
    ...overrides,
  };
}

describe("canonical evidence hashing", () => {
  it("matches the golden vector the SQL suite pins", () => {
    expect(canonicalJson(GOLDEN_DOC)).toBe(GOLDEN_CANONICAL);
    expect(sha256Hex(canonicalJson(GOLDEN_DOC))).toBe(GOLDEN_HASH);
  });

  it("does not depend on read order", () => {
    const a = evidence();
    const b = evidence({
      entries: [...a.entries].reverse(),
      judges: [...a.judges].reverse(),
      ballots: [...a.ballots].reverse(),
      marks: [...a.marks].reverse(),
      heats: a.heats.map((h) => ({ ...h, officialIds: [...h.officialIds].reverse(), entryIds: [...h.entryIds].reverse() })),
      excludedEntries: [...a.excludedEntries].reverse(),
      danceIds: [...a.danceIds].reverse(),
    });
    expect(evidenceHash(a)).toBe(evidenceHash(b));
    expect(canonicalEvidence(a)).toBe(canonicalEvidence(b));
  });

  it("changes when any mark or ballot version changes (hash binding)", () => {
    const base = evidenceHash(evidence());
    const flipped = evidence();
    flipped.marks = flipped.marks.map((m, i) => (i === 0 ? { ...m, value: 2 } : m));
    expect(evidenceHash(flipped)).not.toBe(base);
    const bumped = evidence();
    bumped.ballots = bumped.ballots.map((b, i) => (i === 0 ? { ...b, version: 2 } : b));
    expect(evidenceHash(bumped)).not.toBe(base);
  });

  it("sorts marks by official, entry, then heat", () => {
    const sorted = normalizeEvidence(evidence()).marks.map((m) => `${m.officialId.slice(-2)}:${m.entryId.slice(-2)}`);
    expect(sorted).toEqual(["a1:e1", "a1:e2", "a2:e1", "a2:e2"]);
  });

  it("trace hash is the canonical hash of the trace", () => {
    expect(traceHash([{ b: 1, a: 2 }])).toBe(sha256Hex('[{"a":2,"b":1}]'));
  });
});

describe("engine registry", () => {
  it("integration branch: F1's two Studio engines are registered (the stub is test-only)", () => {
    expect(REGISTERED_ENGINES.map((e) => `${e.key}@${e.version}`).sort()).toEqual(["studio_callback_tally@1", "studio_ordinal_majority@1"]);
    expect(lookupRegisteredEngine("studio_ordinal_majority", "1")).toBeDefined();
  });
  it("application code never imports the stub", () => {
    const root = join(__dirname, "..", "..", "..", "..");
    for (const file of ["lib/competition/results/engineAdapter.ts", "lib/competition/results/calculate.ts", "app/app/events/[id]/competition/results/actions.ts"]) {
      expect(readFileSync(join(root, file), "utf8")).not.toMatch(/from\s+["'][^"']*stubEngine/);
    }
  });
});

function fakeRpc(options: { ev?: EvidenceInput; status?: string; hash?: string; available?: boolean; saveError?: string }): { rpc: Rpc; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const ev = options.ev ?? evidence();
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpc: Rpc = async (name, args) => {
    calls.push({ name, args });
    if (name === "competition_round_calculation_input") {
      return {
        data: {
          available: options.available ?? true,
          code: "COMP_ENGINE_NOT_AVAILABLE",
          status: options.status ?? "ballots_locked",
          engine_key: "studio_ordinal_majority",
          engine_version: "1",
          evidence: ev,
          input_hash: options.hash ?? evidenceHash(ev),
        },
        error: null,
      };
    }
    if (options.saveError) return { data: null, error: { message: options.saveError } };
    return { data: { result_version_id: "v1", version: 1, replayed: false }, error: null };
  };
  return { rpc, calls };
}

describe("calculateRound orchestration", () => {
  const engineFor = (key: string, version: string) => (key === stubEngine.key && version === stubEngine.version ? stubEngine : undefined);

  it("hands the engine result and both hashes to the RPC", async () => {
    const { rpc, calls } = fakeRpc({});
    const out = await calculateRound({ rpc, engineFor }, R, "req");
    expect(out).toEqual({ ok: true, versionId: "v1", version: 1, replayed: false });
    const save = calls[1];
    expect(save.name).toBe("calculate_competition_round");
    expect(save.args.p_input_hash).toBe(evidenceHash(evidence()));
    expect(save.args.p_trace_hash).toBe(traceHash(save.args.p_trace as unknown[]));
    expect((save.args.p_rows as Array<{ entry_id: string }>).map((r) => r.entry_id).sort()).toEqual([E1, E2]);
    expect(save.args.p_request_id).toBe("req");
  });

  it("fails closed when no engine is registered", async () => {
    const { rpc, calls } = fakeRpc({});
    const out = await calculateRound({ rpc, engineFor: () => undefined }, R, "req");
    expect(out).toMatchObject({ ok: false, code: "COMP_ENGINE_NOT_AVAILABLE" });
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the database says the method is unavailable", async () => {
    const { rpc } = fakeRpc({ available: false });
    expect(await calculateRound({ rpc, engineFor }, R, "req")).toMatchObject({ ok: false, code: "COMP_ENGINE_NOT_AVAILABLE" });
  });

  it("refuses when app and database hashes disagree", async () => {
    const { rpc, calls } = fakeRpc({ hash: "0".repeat(64) });
    expect(await calculateRound({ rpc, engineFor }, R, "req")).toMatchObject({ ok: false, code: "COMP_RESULT_STALE" });
    expect(calls).toHaveLength(1);
  });

  it("refuses a round whose ballots are not locked", async () => {
    const { rpc } = fakeRpc({ status: "active" });
    expect(await calculateRound({ rpc, engineFor }, R, "req")).toMatchObject({ ok: false, code: "COMP_RESULT_INVALID_TRANSITION" });
  });

  it("maps an engine refusal to its code without calling calculate", async () => {
    const { rpc, calls } = fakeRpc({});
    const refusing = { ...stubEngine, run: () => { throw new Error("COMP_ENGINE_UNSPECIFIED_CASE: tie"); } };
    expect(await calculateRound({ rpc, engineFor: () => refusing }, R, "req")).toMatchObject({ ok: false, code: "COMP_ENGINE_UNSPECIFIED_CASE" });
    expect(calls).toHaveLength(1);
  });

  it("surfaces a database refusal code (stale at write time)", async () => {
    const { rpc } = fakeRpc({ saveError: "COMP_RESULT_STALE: the engine input does not match" });
    expect(await calculateRound({ rpc, engineFor }, R, "req")).toMatchObject({ ok: false, code: "COMP_RESULT_STALE" });
  });
});

describe("contract alignment", () => {
  it("second-person approval rule (D3)", () => {
    expect(approvalAllowed({ calculatedBy: "a", approverId: "b", inputHashMatchesCurrentBallots: true })).toEqual({ ok: true, override: false });
    expect(approvalAllowed({ calculatedBy: "a", approverId: "a", inputHashMatchesCurrentBallots: true })).toEqual({ ok: false, code: "COMP_SECOND_APPROVER_REQUIRED" });
    expect(approvalAllowed({ calculatedBy: "a", approverId: "a", overrideReason: "sole manager", inputHashMatchesCurrentBallots: true })).toEqual({ ok: true, override: true });
    expect(approvalAllowed({ calculatedBy: "a", approverId: "b", inputHashMatchesCurrentBallots: false })).toEqual({ ok: false, code: "COMP_RESULT_STALE" });
  });

  it("every kind and code the SQL writes is in the contract", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "..", "supabase", "migrations", "20270114090000_competition_f2_results_lifecycle.sql"), "utf8");
    for (const kind of sql.matchAll(/'(round_state_changed|result_[a-z_]+|advancement_applied)'/g)) {
      if (/^result_(versions|rows|approvals|events|version_id)/.test(kind[1])) continue;
      expect(RESULT_EVENT_KINDS as readonly string[]).toContain(kind[1]);
    }
    for (const code of sql.matchAll(/'(COMP_[A-Z0-9_]+):/g)) {
      expect(resultErrorMessage(code[1])).not.toMatch(/could not be done/);
    }
  });

  it("explains every F2 refusal in plain words", () => {
    for (const code of ["COMP_RESULT_STALE", "COMP_SECOND_APPROVER_REQUIRED", "COMP_ENGINE_NOT_AVAILABLE", "COMP_CORRECTION_LATER_ROUND_BALLOTS", "COMP_PUBLICATION_REQUIRES_APPROVAL"]) {
      expect(resultErrorMessage(code)).not.toMatch(/could not be done/);
    }
    expect(resultErrorMessage("anything else")).toMatch(/could not be done/);
  });
});
