import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptStudioEngine, toStudioEngineInput, studioEngineKeyToMethodKey, type StudioEngineInputShape, type StudioEngineLike } from "../engineAdapter";
import type { EvidenceInput } from "../evidence";

const E1 = "e1";
const E2 = "e2";
const E3 = "e3";

function evidence(overrides: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    engineKey: "studio_ordinal_majority",
    engineVersion: "1",
    profile: { key: "studio_simple", version: 3 },
    markScheme: { input: "placement_marks", scored_by: "entry" },
    tieBreakChain: ["shared tie"],
    round: { id: "round-final", roundType: "final", targetAdvancementCount: null, advancementMethod: "none" },
    chiefJudgeTiebreak: false,
    scoreRolesSeparately: false,
    finalCapacity: 8,
    entries: [{ entryId: E1 }, { entryId: E2 }, { entryId: E3 }],
    excludedEntries: [{ entryId: E3, reason: "scratched" }],
    heats: [{ heatId: "heat-1", officialIds: ["o1", "o2", "o3"], entryIds: [E1, E2] }],
    danceIds: ["waltz"],
    judges: [
      { officialId: "o1", letter: "A" },
      { officialId: "o2", letter: "B" },
      { officialId: "o3", letter: "C" },
    ],
    ballots: [{ ballotId: "b1", heatId: "heat-1", officialId: "o1", version: 1 }],
    marks: [
      { officialId: "o1", entryId: E1, heatId: "heat-1", role: null, value: 1 },
      { officialId: "o1", entryId: E2, heatId: "heat-1", role: null, value: 2 },
    ],
    ...overrides,
  };
}

describe("toStudioEngineInput (thin mapper)", () => {
  it("maps the evidence one to one onto F1's input shape", () => {
    const ev = evidence();
    expect(toStudioEngineInput(ev)).toEqual({
      engineKey: "ordinal_majority",
      engineVersion: "1",
      profile: { key: "studio_simple", version: 3 },
      round: ev.round,
      markScheme: ev.markScheme,
      tieBreakChain: ["shared tie"],
      entries: ev.entries,
      judges: ev.judges,
      marks: [
        { officialId: "o1", entryId: E1, role: null, value: 1 },
        { officialId: "o1", entryId: E2, role: null, value: 2 },
      ],
      context: {
        excludedEntries: [{ entryId: E3, reason: "scratched" }],
        heats: ev.heats,
        danceIds: ["waltz"],
        chiefJudgeTiebreak: false,
        scoreRolesSeparately: false,
        finalCapacity: 8,
      },
    });
  });

  it("does not mutate or reorder the evidence", () => {
    const ev = evidence();
    const copy = JSON.parse(JSON.stringify(ev));
    toStudioEngineInput(ev);
    expect(ev).toEqual(copy);
  });

  it("carries the X-3 flags through unchanged (the engine, not the mapper, refuses them)", () => {
    const out = toStudioEngineInput(evidence({ chiefJudgeTiebreak: true, scoreRolesSeparately: true }));
    expect(out.context.chiefJudgeTiebreak).toBe(true);
    expect(out.context.scoreRolesSeparately).toBe(true);
  });

  it("refuses a round whose program has no locked profile", () => {
    expect(() => toStudioEngineInput(evidence({ profile: null }))).toThrow(/COMP_ENGINE_INVALID_INPUT/);
  });

  it("maps the registry engine name to the K0 scoring method key", () => {
    expect(studioEngineKeyToMethodKey("studio_callback_tally")).toBe("callback_tally");
    expect(studioEngineKeyToMethodKey("studio_ordinal_majority")).toBe("ordinal_majority");
  });
});

describe("adaptStudioEngine", () => {
  const ok: StudioEngineLike = {
    id: "studio_ordinal_majority@1",
    key: "ordinal_majority",
    version: "1",
    run: (input: StudioEngineInputShape) => ({ ok: true, rows: [{ entryId: input.entries[0].entryId, placement: 1 }], trace: [{ step: "engine" }], warnings: ["w"] }),
  };
  it("exposes the registry name and version and passes rows, trace and warnings through", () => {
    const adapted = adaptStudioEngine(ok);
    expect(adapted.key).toBe("studio_ordinal_majority");
    expect(adapted.version).toBe("1");
    expect(adapted.run(evidence())).toEqual({ rows: [{ entryId: E1, placement: 1 }], trace: [{ step: "engine" }], warnings: ["w"] });
  });
  it("turns an engine failure into the thrown fail-closed error", () => {
    const failing: StudioEngineLike = { ...ok, run: () => ({ ok: false, code: "COMP_ENGINE_UNSPECIFIED_CASE", reason: "judge_tie" }) };
    expect(() => adaptStudioEngine(failing).run(evidence())).toThrow("COMP_ENGINE_UNSPECIFIED_CASE: judge_tie");
  });
});

// F1's golden fixtures (PR #337) through the adapter. F1's code is not on this branch until #337 merges, so this block runs only
// on a local, unpushed branch that merges competition-f1-studio-engines; elsewhere it is skipped.
const f1Dir = join(__dirname, "..", "engines");
const f1Present = existsSync(join(f1Dir, "index.ts")) && existsSync(join(f1Dir, "__tests__", "helpers.ts"));

describe.skipIf(!f1Present)("F1 golden fixtures through the adapter (needs #337 merged locally)", () => {
  async function load() {
    const indexPath = "../engines/index";
    const helpersPath = "../engines/__tests__/helpers";
    const f1 = (await import(/* @vite-ignore */ indexPath)) as { STUDIO_ENGINES: Record<string, StudioEngineLike> };
    const helpers = (await import(/* @vite-ignore */ helpersPath)) as {
      ordinalInput(table: Record<number, number[]>): StudioEngineInputShape;
      callbackInput(sel: number[][], entries: number[], target: number | null, cap: number | null): StudioEngineInputShape;
    };
    return { f1, helpers };
  }

  /** Inverse of the mapper, test only: rebuilds the evidence F2 would have produced for an F1 fixture. */
  function evidenceOf(input: StudioEngineInputShape): EvidenceInput {
    return {
      engineKey: `studio_${input.engineKey}`,
      engineVersion: input.engineVersion,
      profile: input.profile,
      markScheme: input.markScheme,
      tieBreakChain: input.tieBreakChain,
      round: input.round,
      chiefJudgeTiebreak: input.context.chiefJudgeTiebreak,
      scoreRolesSeparately: input.context.scoreRolesSeparately,
      finalCapacity: input.context.finalCapacity ?? null,
      entries: input.entries,
      excludedEntries: input.context.excludedEntries,
      heats: input.context.heats,
      danceIds: input.context.danceIds,
      judges: input.judges,
      ballots: [],
      marks: input.marks.map((m) => ({ officialId: m.officialId, entryId: m.entryId, heatId: null, role: null, value: m.value })),
    };
  }

  const strip = (i: StudioEngineInputShape) => ({
    ...i,
    context: { ...i.context, finalCapacity: i.context.finalCapacity ?? null },
    marks: i.marks.map((m) => ({ ...m, role: m.role ?? null })),
  });

  it("the mapper reproduces F1's ordinal and callback fixtures exactly", async () => {
    const { helpers } = await load();
    const fixtures = [
      helpers.ordinalInput({ 1: [1, 1, 2], 2: [2, 2, 1], 3: [3, 3, 3] }),
      helpers.ordinalInput({ 1: [1, 2, 1, 3, 2], 2: [2, 1, 3, 1, 1], 3: [3, 3, 2, 2, 3] }),
      helpers.callbackInput([[1, 2], [1, 3], [2, 3]], [1, 2, 3, 4], 2, 8),
    ];
    for (const fx of fixtures) expect(strip(toStudioEngineInput(evidenceOf(fx)))).toEqual(strip(fx));
  });

  it("an adapted engine returns exactly what F1's engine returns on the golden fixtures", async () => {
    const { f1, helpers } = await load();
    type Run = { ok: true; rows: unknown[]; trace: unknown[]; warnings: string[] };
    const ordinal = helpers.ordinalInput({ 1: [1, 1, 2], 2: [2, 2, 1], 3: [3, 3, 3] });
    const direct = f1.STUDIO_ENGINES["studio_ordinal_majority@1"].run(ordinal) as unknown as Run;
    const adapted = adaptStudioEngine(f1.STUDIO_ENGINES["studio_ordinal_majority@1"]).run(evidenceOf(ordinal));
    expect(adapted).toEqual({ rows: direct.rows, trace: direct.trace, warnings: direct.warnings });
    const callback = helpers.callbackInput([[1, 2], [1, 3], [2, 3]], [1, 2, 3, 4], 2, 8);
    const cDirect = f1.STUDIO_ENGINES["studio_callback_tally@1"].run(callback) as unknown as Run;
    const cAdapted = adaptStudioEngine(f1.STUDIO_ENGINES["studio_callback_tally@1"]).run(evidenceOf(callback));
    expect(cAdapted).toEqual({ rows: cDirect.rows, trace: cDirect.trace, warnings: cDirect.warnings });
  });

  it("a fail-closed F1 fixture (judge tie) fails closed through the adapter", async () => {
    const { f1, helpers } = await load();
    const tie = helpers.ordinalInput({ 1: [1, 1, 2], 2: [1, 2, 1], 3: [3, 3, 3] });
    const direct = f1.STUDIO_ENGINES["studio_ordinal_majority@1"].run(tie) as unknown as { ok: boolean };
    expect(direct.ok).toBe(false);
    expect(() => adaptStudioEngine(f1.STUDIO_ENGINES["studio_ordinal_majority@1"]).run(evidenceOf(tie))).toThrow(/COMP_ENGINE_/);
  });
});
