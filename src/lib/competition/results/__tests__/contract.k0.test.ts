import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  approvalAllowed,
  canonicalEngineInput,
  canonicalJson,
  closeoutBlockers,
  engineAvailable,
  findTransition,
  publicationBlockers,
  readAccess,
  REFUND_EXCEPTION_EFFECTS,
  RESULT_READER_MATRIX,
  ROUND_STATES,
  ROUND_TRANSITIONS,
  type EngineInput,
  type PublicationGateException,
} from "@/lib/competition/results/contract";

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const FOUNDATION = read("src/lib/supabase/migrations/20260620_competition_foundation_v1.sql");
const PHASE10B = read("src/lib/supabase/migrations/20261108090000_phase10b_competition_profiles.sql");
const DOC = read("docs/competition/scoring-results-contract.md");

describe("K0 round state machine", () => {
  it("uses exactly the round statuses of the foundation check constraint", () => {
    const quoted = ROUND_STATES.map((s) => `'${s}'`).join(", ");
    expect(FOUNDATION).toContain(`check (status in (${quoted}))`);
  });

  it("has one writer RPC per transition", () => {
    const seen = new Set<string>();
    for (const t of ROUND_TRANSITIONS) {
      const key = `${t.from}->${t.to}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("only reaches published from approved", () => {
    const intoPublished = ROUND_TRANSITIONS.filter((t) => t.to === "published");
    expect(intoPublished.map((t) => t.from)).toEqual(["approved"]);
  });

  it("only reaches approved from calculated", () => {
    expect(ROUND_TRANSITIONS.filter((t) => t.to === "approved").map((t) => t.from)).toEqual(["calculated"]);
  });

  it("requires a reason for reopen, correction and cancel", () => {
    for (const t of ROUND_TRANSITIONS) {
      if (/reopen|correction|cancel/.test(t.rpc)) expect(t.reasonRequired, t.rpc).toBe(true);
    }
  });

  it("never cancels a published or complete round", () => {
    expect(findTransition("published", "cancelled")).toBeNull();
    expect(findTransition("complete", "cancelled")).toBeNull();
  });

  it("documents every writer RPC", () => {
    for (const t of ROUND_TRANSITIONS) expect(DOC, t.rpc).toContain(t.rpc);
  });
});

describe("K0 second-person approval (owner D3)", () => {
  it("allows a different approver", () => {
    expect(approvalAllowed({ calculatedBy: "a", approverId: "b", inputHashMatchesCurrentBallots: true })).toEqual({ ok: true, override: false });
  });

  it("refuses the calculator without a reason", () => {
    expect(approvalAllowed({ calculatedBy: "a", approverId: "a", inputHashMatchesCurrentBallots: true })).toEqual({
      ok: false,
      code: "COMP_SECOND_APPROVER_REQUIRED",
    });
    expect(approvalAllowed({ calculatedBy: "a", approverId: "a", overrideReason: "  ", inputHashMatchesCurrentBallots: true }).ok).toBe(false);
  });

  it("allows an audited single-staff override", () => {
    expect(
      approvalAllowed({ calculatedBy: "a", approverId: "a", overrideReason: "only staff on site", inputHashMatchesCurrentBallots: true }),
    ).toEqual({ ok: true, override: true });
  });

  it("refuses a stale result even with a second approver", () => {
    expect(approvalAllowed({ calculatedBy: "a", approverId: "b", inputHashMatchesCurrentBallots: false })).toEqual({
      ok: false,
      code: "COMP_RESULT_STALE",
    });
  });
});

describe("K0 engine boundary", () => {
  it("v1 keys match the 10B scoring_method keys", () => {
    expect(PHASE10B).toContain("'ordinal_majority', 'proficiency_rating', 'callback_tally'");
  });

  it("fails closed until a spec is approved", () => {
    expect(engineAvailable("ordinal_majority", new Set())).toBe(false);
    expect(engineAvailable("ordinal_majority", new Set(["ordinal_majority"]))).toBe(true);
    expect(engineAvailable("skating", new Set(["skating"]))).toBe(false);
  });

  const base: EngineInput = {
    engineKey: "ordinal_majority",
    engineVersion: "1",
    profile: { key: "studio_simple", version: 3 },
    round: { id: "r1", roundType: "final", targetAdvancementCount: null, advancementMethod: "none" },
    markScheme: { input: "placement_marks" },
    tieBreakChain: [],
    entries: [{ entryId: "e2" }, { entryId: "e1" }],
    judges: [{ officialId: "j2", letter: "B" }, { officialId: "j1", letter: "A" }],
    marks: [
      { officialId: "j2", entryId: "e1", value: 2 },
      { officialId: "j1", entryId: "e2", value: 1 },
      { officialId: "j1", entryId: "e1", value: 2 },
    ],
  };

  it("hashes the same ballots identically regardless of read order", () => {
    const shuffled: EngineInput = {
      ...base,
      entries: [...base.entries].reverse(),
      judges: [...base.judges].reverse(),
      marks: [...base.marks].reverse(),
    };
    expect(canonicalEngineInput(shuffled)).toBe(canonicalEngineInput(base));
  });

  it("changes when any mark changes", () => {
    const changed: EngineInput = { ...base, marks: base.marks.map((m, i) => (i === 0 ? { ...m, value: 1 } : m)) };
    expect(canonicalEngineInput(changed)).not.toBe(canonicalEngineInput(base));
  });

  it("sorts object keys and rejects non-finite numbers", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: "x" }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
  });
});

describe("K0 publication gate (owner Q2)", () => {
  const ex = (over: Partial<PublicationGateException>): PublicationGateException => ({
    kind: "competition_refund_entry_locked_heat",
    resolved: false,
    effect: "competitive",
    roundIds: ["r1"],
    ...over,
  });

  it("blocks only the affected round", () => {
    expect(publicationBlockers("r1", [ex({})])).toHaveLength(1);
    expect(publicationBlockers("r2", [ex({})])).toHaveLength(0);
  });

  it("does not block on financial-only or resolved exceptions", () => {
    expect(publicationBlockers("r1", [ex({ effect: "financial_only", kind: "competition_refund_unattributed" })])).toHaveLength(0);
    expect(publicationBlockers("r1", [ex({ resolved: true })])).toHaveLength(0);
  });

  it("classifies locked and certified heat refunds as competitive", () => {
    expect(REFUND_EXCEPTION_EFFECTS.competition_refund_entry_locked_heat).toBe("competitive");
    expect(REFUND_EXCEPTION_EFFECTS.competition_refund_entry_certified_heat).toBe("competitive");
    expect(REFUND_EXCEPTION_EFFECTS.competition_refund_unattributed).toBe("financial_only");
  });

  it("blocks closeout on any unresolved refund exception, financial-only included", () => {
    expect(closeoutBlockers([ex({ effect: "financial_only", kind: "competition_refund_reversed", roundIds: [] })])).toHaveLength(1);
    expect(closeoutBlockers([ex({ resolved: true })])).toHaveLength(0);
  });

  it("documents the publication error code", () => {
    expect(DOC).toContain("COMP_PUBLICATION_BLOCKED_BY_EXCEPTION");
  });
});

describe("K0 reader matrix", () => {
  it("never exposes unpublished results outside managers and scorers", () => {
    for (const [reader, row] of Object.entries(RESULT_READER_MATRIX)) {
      const expected = reader === "manager" || reader === "scorer" ? "all" : "none";
      expect(row.unpublished_result, reader).toBe(expected);
    }
  });

  it("gives entrants only their own published results", () => {
    expect(readAccess("entrant", "published_current")).toBe("own");
    expect(readAccess("entrant", "ballots")).toBe("none");
  });

  it("treats other tenants exactly like the public", () => {
    expect(RESULT_READER_MATRIX.other_tenant).toEqual(RESULT_READER_MATRIX.public);
  });

  it("hides superseded or withdrawn publications from every non-manager", () => {
    for (const [reader, row] of Object.entries(RESULT_READER_MATRIX)) {
      if (reader !== "manager") expect(row.published_superseded_or_withdrawn, reader).toBe("none");
    }
  });
});
