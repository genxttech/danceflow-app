/**
 * R-07 independent verification (owner ratification 2026-11-23): negative / fail-closed tests for the Studio scoring controls.
 * TEST-ONLY: no registry, engine or SQL behavior is changed here. Docs: docs/competition/governance/audit/R-07-VERIFICATION.md.
 *
 *   (1) only studio_callback_tally and studio_ordinal_majority are selectable
 *   (3) proficiency_rating@1 stays rejected; unapproved / unavailable / unknown methods fail closed
 *   (4) legacy `majority_rules` is NOT UCWDC Majority Rules and is never reinterpreted
 *   (5) unsupported legacy mappings return an explicit error, never a fallback engine
 *   (6)/(7) multi-dance: no combined result; an engine run covers exactly one dance
 *   SQL mirror: the migration text must agree with the TypeScript registry (static parity, NOT a database execution).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { BALLOT_FORMATS, ballotFormatForScoring, findBallotFormat } from "../../ballots/formats";
import { validateBallot } from "../../ballots/schemes";
import { REGISTERED_ENGINES, lookupRegisteredEngine } from "../../results/engineAdapter";
import { STUDIO_ENGINES } from "../../results/engines";
import { runStudioCallbackTally } from "../../results/engines/studioCallbackTally";
import { runStudioOrdinalMajority } from "../../results/engines/studioOrdinalMajority";
import { callbackInput, ordinalInput } from "../../results/engines/__tests__/helpers";
import {
  LEGACY_SCORING_MAP,
  SCORING_REGISTRY,
  resolveLegacyScoringMethod,
  resolveMethod,
  resolveRoundMethod,
  selectableMethods,
} from "../registry";
import { studioScoringReadiness } from "../studioReadiness";
import { STUDIO_PRESETS, resolvePreset, selectablePresets } from "../studioSetup";

const APPROVED = ["studio_callback_tally@1", "studio_ordinal_majority@1"];

/** Every legacy value the programs/rounds CHECK constraints still allow (10B + 10C.5), plus the registry-only value. */
const LEGACY_CHECK_VALUES = [
  "skating",
  "majority_rules",
  "wsdc_callback",
  "relative_placement",
  "round_specific",
  "proficiency",
  "cumulative_points",
  "feedback_only",
  "custom",
  "none",
];

describe("R-07(1)/(3): only two methods are selectable; everything else fails closed", () => {
  it("selectable set is exactly the two Studio methods", () => {
    expect(selectableMethods().map((e) => `${e.key}@${e.version}`).sort()).toEqual(APPROVED);
    expect(SCORING_REGISTRY.filter((e) => e.status === "approved").map((e) => `${e.key}@${e.version}`).sort()).toEqual(APPROVED);
  });

  it.each(SCORING_REGISTRY.filter((e) => e.status !== "approved").map((e) => [e.key, e.version, e.status] as const))(
    "%s@%s (%s) cannot resolve and carries no engine, no ballot format and no purpose",
    (key, version) => {
      const r = resolveMethod(key, version);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
      const entry = SCORING_REGISTRY.find((e) => e.key === key && e.version === version)!;
      expect(entry.engineId).toBeNull();
      expect(entry.acceptedBallotFormats).toEqual([]);
      expect(entry.resultPurposes).toEqual([]);
    },
  );

  it("proficiency_rating@1 is rejected (not merely unavailable)", () => {
    expect(SCORING_REGISTRY.find((e) => e.key === "proficiency_rating")?.status).toBe("rejected");
    const r = resolveMethod("proficiency_rating", "1");
    expect(!r.ok && r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
  });

  it.each([
    ["", ""],
    ["studio_ordinal_majority", ""],
    ["studio_ordinal_majority", "2"],
    ["studio_ordinal_majority", "1 "],
    ["Studio_Ordinal_Majority", "1"],
    [" studio_ordinal_majority", "1"],
    ["studio_ordinal_majority@1", "1"],
    ["studio_callback_tally", "v1"],
    ["ucwdc_majority_rules", "1"],
    ["ucwdc_majority_rules", "16.9b"],
    ["ndca_skating", "1"],
    ["wsdc_relative_placement", "1"],
    ["majority_rules", "1"],
    ["ordinal_rank", "1"],
    ["__proto__", "1"],
    ["constructor", "1"],
    ["toString", "1"],
  ])("unknown key/version %j@%j is COMP_METHOD_UNKNOWN (no near-match, case or whitespace tolerance)", (key, version) => {
    const r = resolveMethod(key, version);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("COMP_METHOD_UNKNOWN");
  });

  it("an explicit unavailable selection never falls back to a lower layer (legacy or division)", () => {
    const a = resolveRoundMethod({ roundOverride: { key: "ucwdc_majority_rules", version: "v16.9b" }, divisionSelection: { key: "studio_ordinal_majority", version: "1" }, legacyScoringMethod: "ordinal_majority" });
    expect(!a.ok && a.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
    const b = resolveRoundMethod({ divisionSelection: { key: "ndca_skating", version: "unpinned" }, legacyScoringMethod: "callback_tally" });
    expect(!b.ok && b.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
    const c = resolveRoundMethod({ divisionSelection: { key: "made_up", version: "1" }, legacyScoringMethod: "ordinal_majority" });
    expect(!c.ok && c.code).toBe("COMP_METHOD_UNKNOWN");
  });
});

describe("R-07(4)/(5): legacy identifiers never become a body method; unmapped values return an explicit error", () => {
  it("the legacy map holds exactly the three explicit keys", () => {
    expect(Object.keys(LEGACY_SCORING_MAP).sort()).toEqual(["callback_tally", "ordinal_majority", "proficiency_rating"]);
  });

  it("no legacy mapping targets a UCWDC, NDCA or WSDC method", () => {
    for (const mapped of Object.values(LEGACY_SCORING_MAP)) {
      expect(mapped.key).not.toMatch(/ucwdc|ndca|wsdc/);
    }
  });

  it.each(LEGACY_CHECK_VALUES)("legacy %s is COMP_METHOD_LEGACY_UNMAPPED, not an engine", (legacy) => {
    expect(Object.hasOwn(LEGACY_SCORING_MAP, legacy)).toBe(false);
    const r = resolveLegacyScoringMethod(legacy);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("COMP_METHOD_LEGACY_UNMAPPED");
    expect(r).not.toHaveProperty("engineId");
  });

  it.each(["", " ", "Ordinal_Majority", "ordinal_majority ", "ORDINAL_MAJORITY", "studio_ordinal_majority", "ordinal_rank", "__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"])(
    "non-exact or prototype-chain legacy value %j is unmapped",
    (legacy) => {
      const r = resolveLegacyScoringMethod(legacy);
      expect(!r.ok && r.code).toBe("COMP_METHOD_LEGACY_UNMAPPED");
    },
  );

  it("a round whose legacy value is majority_rules and that has no selection resolves to an error, with every other layer empty or null", () => {
    for (const legacyScoringMethod of [...LEGACY_CHECK_VALUES, null, undefined, ""]) {
      const r = resolveRoundMethod({ legacyScoringMethod });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("COMP_METHOD_LEGACY_UNMAPPED");
    }
  });

  it("proficiency_rating legacy maps explicitly but is blocked as COMP_ENGINE_NOT_AVAILABLE (never an engine)", () => {
    const r = resolveRoundMethod({ legacyScoringMethod: "proficiency_rating" });
    expect(!r.ok && r.code).toBe("COMP_ENGINE_NOT_AVAILABLE");
  });
});

describe("SQL mirror parity (static: reads the migration text; does NOT execute the database)", () => {
  const dir = resolve(__dirname, "../../../supabase/migrations");
  const reg = readFileSync(resolve(dir, "20270113090000_competition_scoring_registry.sql"), "utf8");
  const e2 = readFileSync(resolve(dir, "20270102090000_competition_e2_ballots.sql"), "utf8");

  it("competition_scoring_legacy_map inserts exactly the TypeScript LEGACY_SCORING_MAP", () => {
    const block = /insert into public\.competition_scoring_legacy_map[^;]*?values([^;]*);/is.exec(reg)?.[1] ?? "";
    const rows = [...block.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)].map((m) => [m[1], `${m[2]}@${m[3]}`]);
    const ts = Object.entries(LEGACY_SCORING_MAP).map(([k, v]) => [k, `${v.key}@${v.version}`]);
    expect(rows.sort()).toEqual(ts.sort());
    expect(rows.some(([legacy]) => legacy === "majority_rules")).toBe(false);
  });

  it("competition_scoring_methods seed rows carry the same statuses and engine ids as SCORING_REGISTRY", () => {
    const seed = /insert into public\.competition_scoring_methods[\s\S]*?values([\s\S]*?);\s*\n\s*\n/i.exec(reg)?.[1] ?? "";
    const sqlRows = [...seed.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([^']+)'\s*,\s*'(approved|draft|unavailable|rejected)'/g)].map((m) => `${m[1]}@${m[2]}=${m[3]}`);
    const tsRows = SCORING_REGISTRY.map((e) => `${e.key}@${e.version}=${e.status}`);
    expect(sqlRows.sort()).toEqual(tsRows.sort());
    // the table CHECK refuses an approved row without an engine, and a non-approved row with one
    expect(reg).toMatch(/status = 'approved' and engine_id is not null/);
    expect(reg).toMatch(/status <> 'approved' and engine_id is null/);
  });

  it("the selection guard refuses unknown, unapproved and engine-less methods", () => {
    expect(reg).toMatch(/COMP_METHOD_UNKNOWN/);
    expect(reg).toMatch(/v_method\.status <> 'approved' or v_method\.engine_id is null/);
  });

  it("_compe2_format_approved approves exactly the ballot formats the TypeScript registry approves", () => {
    const body = /function public\._compe2_format_approved[\s\S]*?\$\$;/i.exec(e2)?.[0] ?? "";
    const pairs = [...body.matchAll(/\('([a-z_]+)',\s*(\d+)\)/g)].map((m) => `${m[1]}@${m[2]}`).sort();
    const ts = BALLOT_FORMATS.filter((f) => f.approved).map((f) => `${f.id}@${f.version}`).sort();
    expect(pairs).toEqual(ts);
    expect(pairs).not.toContain("three_band@1");
  });

  it("_compe2_format_for_scoring maps the same scoring values to the same ballot formats as formats.ts", () => {
    const body = /function public\._compe2_format_for_scoring[\s\S]*?\$\$;/i.exec(e2)?.[0] ?? "";
    const rows = [...body.matchAll(/\('([a-z_]+)',\s*'([a-z_]+)',\s*(\d+)\)/g)].map((m) => [m[1], { id: m[2], version: Number(m[3]) }] as const);
    expect(rows.length).toBe(3);
    for (const [scoring, fmt] of rows) expect(ballotFormatForScoring(scoring)).toEqual(fmt);
    for (const legacy of LEGACY_CHECK_VALUES) expect(rows.some(([s]) => s === legacy)).toBe(false);
  });

  it("_compe2_validate_marks refuses every format other than ordinal_rank / three_band, and three_band is gated before it by _compe2_format_approved", () => {
    expect(e2).toMatch(/p_format is distinct from 'ordinal_rank' and p_format is distinct from 'three_band'/);
    expect(e2).toMatch(/COMP_BALLOT_SCORING_METHOD_UNSUPPORTED: no validator for ballot format/);
    // both the RPC and the insert trigger refuse an unapproved format before any mark is validated
    expect([...e2.matchAll(/not public\._compe2_format_approved\(/g)].length).toBeGreaterThanOrEqual(2);
  });
});

describe("ballot formats: nothing outside ordinal_rank@1 / callback_yes@1 accepts a ballot (R-07(2),(3),(8),(10))", () => {
  it("the approved ballot formats are exactly ordinal_rank@1 and callback_yes@1", () => {
    expect(BALLOT_FORMATS.filter((f) => f.approved).map((f) => `${f.id}@${f.version}`).sort()).toEqual(["callback_yes@1", "ordinal_rank@1"]);
  });

  it.each([
    ["three_band", 1],
    ["ordinal_rank", 2],
    ["ordinal_rank", 0],
    ["medal_group_rank", 1], // UCWDC medal ballot (HM, B, S, G, GH, GG): NOT IMPLEMENTED
    ["medal", 1],
    ["wsdc_relative_placement", 1],
    ["skating", 1],
    ["", 1],
  ])("validateBallot refuses %s@%d", (id, version) => {
    const r = validateBallot({ format: { id, version }, expectedEntryIds: ["a", "b"], marks: [{ entryId: "a", value: 1 }, { entryId: "b", value: 2 }] });
    expect(r.ok).toBe(false);
  });

  it("medal-tier values are not accepted as ordinal ranks", () => {
    for (const value of ["HM", "B", "S", "G", "GH", "GG", "Gold", "1.5", 0, 3, -1, null]) {
      const r = validateBallot({ format: { id: "ordinal_rank", version: 1 }, expectedEntryIds: ["a", "b"], marks: [{ entryId: "a", value }, { entryId: "b", value: 2 }] });
      expect(r.ok).toBe(false);
    }
  });

  it("three_band (Bronze/Silver/Gold) fails closed even with valid-looking marks", () => {
    const r = validateBallot({ format: { id: "three_band", version: 1 }, expectedEntryIds: ["a"], marks: [{ entryId: "a", value: "Gold" }] });
    expect(!r.ok && r.errors[0].code).toBe("COMP_BALLOT_FORMAT_NOT_APPROVED");
    expect(findBallotFormat("three_band", 1)?.approved).toBe(false);
  });

  it.each(LEGACY_CHECK_VALUES)("legacy scoring value %s has no ballot format", (legacy) => {
    expect(ballotFormatForScoring(legacy)).toBeNull();
  });

  // KNOWN GAP (P3, not reachable): ballotFormatForScoring indexes a plain object, so a prototype-chain name returns a
  // non-format value instead of null. The input is a DB value constrained by the rounds/programs CHECK lists (none of these
  // names is allowed), so no stored row can reach it. `it.fails` documents it without changing behavior; remove the marker when
  // the lookup uses Object.hasOwn.
  it.fails("KNOWN GAP: ballotFormatForScoring('constructor') should be null", () => {
    expect(ballotFormatForScoring("constructor")).toBeNull();
  });
});

describe("setup presets expose only approved methods", () => {
  it("every preset slot is one of the two approved methods and the preset list is fixed", () => {
    expect(STUDIO_PRESETS.map((p) => p.key).sort()).toEqual(["callbacks_final", "final_only"]);
    for (const p of STUDIO_PRESETS) for (const s of p.slots) expect(APPROVED).toContain(`${s.key}@${s.version}`);
    expect(selectablePresets().map((p) => p.key).sort()).toEqual(["callbacks_final", "final_only"]);
  });

  it.each(["", "majority_rules", "ucwdc_majority_rules", "ndca_skating", "wsdc_relative_placement", "proficiency_rating", "__proto__", "constructor"])(
    "resolvePreset(%j) fails closed",
    (key) => {
      const r = resolvePreset(key);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.code).toBe("COMP_SCORING_PRESET_UNKNOWN");
    },
  );
});

describe("results engines: only the two Studio engines are registered; no fallback engine", () => {
  it("REGISTERED_ENGINES and STUDIO_ENGINES hold exactly the two Studio engines", () => {
    expect(Object.keys(STUDIO_ENGINES).sort()).toEqual(APPROVED);
    expect(REGISTERED_ENGINES.map((e) => `${e.key}@${e.version}`).sort()).toEqual(APPROVED);
  });

  it.each([
    ["ucwdc_majority_rules", "v16.9b"],
    ["ndca_skating", "unpinned"],
    ["wsdc_relative_placement", "unpinned"],
    ["proficiency_rating", "1"],
    ["majority_rules", "1"],
    ["ordinal_majority", "1"], // the K0 legacy key, not a registry engine key
    ["studio_ordinal_majority", "2"],
    ["studio_callback_tally", ""],
    ["__proto__", "1"],
  ])("lookupRegisteredEngine(%s, %s) is undefined", (key, version) => {
    expect(lookupRegisteredEngine(key, version)).toBeUndefined();
  });

  it("a studio engine refuses an input addressed to another engine key or version", () => {
    for (const engineKey of ["majority_rules", "skating", "ucwdc_majority_rules", "relative_placement", "callback_tally"] as const) {
      const run = runStudioOrdinalMajority({ ...ordinalInput({ 1: [1, 1, 1], 2: [2, 2, 2] }), engineKey: engineKey as never });
      expect(run.ok).toBe(false);
    }
    for (const engineKey of ["majority_rules", "skating", "ordinal_majority"] as const) {
      const run = runStudioCallbackTally({ ...callbackInput([[11], [11], [11]], [11, 12], 1, null), engineKey: engineKey as never });
      expect(run.ok).toBe(false);
    }
    const v2 = runStudioOrdinalMajority({ ...ordinalInput({ 1: [1, 1, 1], 2: [2, 2, 2] }), engineVersion: "2" });
    expect(v2.ok).toBe(false);
  });
});

describe("R-07(6)/(7), X-6: one result per dance, never a combined or aggregate result", () => {
  const dances = [[], ["a", "b"], ["a", "b", "c"], Array.from({ length: 10 }, (_, i) => `d${i}`)];

  it.each(dances.map((d) => [d.length, d] as const))("ordinal engine with %d dance(s) fails with COMP_ENGINE_UNSPECIFIED_CASE", (_n, danceIds) => {
    const base = ordinalInput({ 1: [1, 1, 1], 2: [2, 2, 2] });
    const run = runStudioOrdinalMajority({ ...base, context: { ...base.context, danceIds: [...danceIds] } });
    expect(run.ok).toBe(false);
    expect(!run.ok && run.code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
    expect(!run.ok && run.reason).toBe("multi_dance_unsupported");
  });

  it.each(dances.map((d) => [d.length, d] as const))("callback engine with %d dance(s) fails with COMP_ENGINE_UNSPECIFIED_CASE", (_n, danceIds) => {
    const base = callbackInput([[11], [11], [11]], [11, 12], 1, null);
    const run = runStudioCallbackTally({ ...base, context: { ...base.context, danceIds: [...danceIds] } });
    expect(run.ok).toBe(false);
    expect(!run.ok && run.code).toBe("COMP_ENGINE_UNSPECIFIED_CASE");
  });

  it("a single-dance run carries no overall, combined or aggregate field", () => {
    const run = runStudioOrdinalMajority(ordinalInput({ 1: [1, 1, 1], 2: [2, 2, 2], 3: [3, 3, 3] }));
    expect(run.ok).toBe(true);
    const text = JSON.stringify(run).toLowerCase();
    for (const forbidden of ["overall", "combined", "aggregate", "championship", "carry_forward", "carryforward", "all_dances"]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("readiness: unsupported configurations are never a calculable round", () => {
  const program = { id: "p", name: "P", status: "draft", profile_locked_at: null, advancement_method: "none" };
  const division = (key: string | null, version: string | null) => ({ id: "d", program_id: "p", name: "D", scoring_method_key: key, scoring_method_version: version });
  const round = (scoring_method: string, over: Partial<{ scoring_override_key: string | null; scoring_override_version: string | null }> = {}) => ({
    id: "r", division_id: "d", name: "Final", round_type: "final", scoring_method, status: "planned", scoring_override_key: null, scoring_override_version: null, ...over,
  });
  const run = (div: ReturnType<typeof division>, r: ReturnType<typeof round>) =>
    studioScoringReadiness({ programs: [program], divisions: [div], rounds: [r], heatsByRound: new Map() });

  it.each(["majority_rules", "skating", "wsdc_callback", "relative_placement", "custom", "round_specific", "proficiency", "cumulative_points"])(
    "legacy %s with no registry selection is never counted as a configured (calculable) round",
    (legacy) => {
      const report = run(division(null, null), round(legacy));
      expect(report.configuredRounds).toBe(0);
      expect(report.notices.map((n) => n.code)).toContain("COMP_SCORING_NO_METHOD");
    },
  );

  it.each([
    ["ucwdc_majority_rules", "v16.9b"],
    ["ndca_skating", "unpinned"],
    ["wsdc_relative_placement", "unpinned"],
    ["proficiency_rating", "1"],
  ])("a draft division selecting %s@%s is a publish BLOCKER (COMP_ENGINE_NOT_AVAILABLE)", (key, version) => {
    const report = run(division(key, version), round("ordinal_majority"));
    expect(report.blockers.map((b) => b.code)).toContain("COMP_ENGINE_NOT_AVAILABLE");
  });

  it("an unknown registry selection is a publish BLOCKER (COMP_METHOD_UNKNOWN)", () => {
    const report = run(division("made_up", "9"), round("ordinal_majority"));
    expect(report.blockers.map((b) => b.code)).toContain("COMP_METHOD_UNKNOWN");
  });

  it("a legacy/selection mismatch (selected callback, legacy ordinal) is a BLOCKER, never silently rescored", () => {
    const report = run(division("studio_callback_tally", "1"), round("ordinal_majority"));
    expect(report.blockers.map((b) => b.code)).toContain("COMP_SCORING_LEGACY_MISMATCH");
  });

  it("a legacy proficiency_rating round without selection is not calculable", () => {
    const report = run(division(null, null), round("proficiency_rating"));
    expect(report.configuredRounds).toBe(0);
    expect(report.blockers).toEqual([]);
    expect(report.notices.length).toBeGreaterThan(0);
  });
});

describe("legacy/selection incoherence cannot make an engine score the wrong ballot shape (defence behind the app-side readiness blocker)", () => {
  it("the ordinal engine refuses callback-style (boolean) marks", () => {
    const base = ordinalInput({ 1: [1, 1, 1], 2: [2, 2, 2] });
    const run = runStudioOrdinalMajority({ ...base, marks: base.marks.map((m) => ({ ...m, value: true })) });
    expect(run.ok).toBe(false);
  });

  it("the callback engine refuses ordinal (numeric rank) marks", () => {
    const base = callbackInput([[11], [11], [11]], [11, 12], 1, null);
    const run = runStudioCallbackTally({ ...base, marks: base.marks.map((m) => ({ ...m, value: 1 })) });
    expect(run.ok).toBe(false);
  });
});
