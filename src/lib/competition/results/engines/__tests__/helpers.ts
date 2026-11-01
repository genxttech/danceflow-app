import type { EngineMark } from "../../contract";
import type { EngineRun, EngineRunFailure, EngineRunSuccess, StudioEngineInput } from "../types";

export const officialId = (n: number) => `official-${n}`;
export const entryKey = (n: number | string) => `e${n}`;

function judges(count: number) {
  return Array.from({ length: count }, (_, i) => ({ officialId: officialId(i + 1), letter: `J${i + 1}` }));
}

function baseContext(judgeCount: number, entryIds: string[]): StudioEngineInput["context"] {
  return {
    excludedEntries: [],
    heats: [{ heatId: "heat-1", officialIds: judges(judgeCount).map((j) => j.officialId), entryIds }],
    danceIds: ["waltz"],
    chiefJudgeTiebreak: false,
    scoreRolesSeparately: false,
  };
}

/** table: entry number -> ordinal per judge (J1, J2, ...). */
export function ordinalInput(table: Record<number, number[]>, overrides: Partial<StudioEngineInput> = {}): StudioEngineInput {
  const entryNumbers = Object.keys(table).map(Number);
  const judgeCount = table[entryNumbers[0]].length;
  const marks: EngineMark[] = [];
  for (const n of entryNumbers) table[n].forEach((value, j) => marks.push({ officialId: officialId(j + 1), entryId: entryKey(n), value }));
  const entryIds = entryNumbers.map(entryKey);
  return {
    engineKey: "ordinal_majority",
    engineVersion: "1",
    profile: { key: "studio_simple", version: 3 },
    round: { id: "round-final", roundType: "final", targetAdvancementCount: null, advancementMethod: "none" },
    markScheme: { input: "placement_marks", scored_by: "entry" },
    tieBreakChain: [],
    entries: entryIds.map((entryId) => ({ entryId })),
    judges: judges(judgeCount),
    marks,
    context: baseContext(judgeCount, entryIds),
    ...overrides,
  };
}

/** selections: per judge, the entry numbers called back. */
export function callbackInput(
  selections: number[][],
  entryNumbers: number[],
  target: number | null,
  finalCapacity: number | null,
  overrides: Partial<StudioEngineInput> = {},
): StudioEngineInput {
  const marks: EngineMark[] = [];
  selections.forEach((sel, j) => sel.forEach((n) => marks.push({ officialId: officialId(j + 1), entryId: entryKey(n), value: true })));
  const entryIds = entryNumbers.map(entryKey);
  const ctx = baseContext(selections.length, entryIds);
  ctx.finalCapacity = finalCapacity;
  return {
    engineKey: "callback_tally",
    engineVersion: "1",
    profile: { key: "studio_simple", version: 1 },
    round: { id: "round-callback", roundType: "preliminary", targetAdvancementCount: target, advancementMethod: "promote_callback" },
    markScheme: null,
    tieBreakChain: [],
    entries: entryIds.map((entryId) => ({ entryId })),
    judges: judges(selections.length),
    marks,
    context: ctx,
    ...overrides,
  };
}

export function expectOk(run: EngineRun): EngineRunSuccess {
  if (!run.ok) throw new Error(`expected success, got ${run.code}/${run.reason} ${JSON.stringify(run.offendingIds)}`);
  return run;
}

export function expectFail(run: EngineRun): EngineRunFailure {
  if (run.ok) throw new Error("expected failure, got success");
  return run;
}

export function placements(run: EngineRun): Record<string, number | null | undefined> {
  return Object.fromEntries(expectOk(run).rows.map((r) => [r.entryId, r.placement]));
}

/** Deterministic PRNG for shuffles (tests only; engines never use randomness). */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Same input, every array order shuffled (marks, entries, judges, context arrays). */
export function shuffleInput(input: StudioEngineInput, rand: () => number): StudioEngineInput {
  return {
    ...input,
    entries: shuffled(input.entries, rand),
    judges: shuffled(input.judges, rand),
    marks: shuffled(input.marks, rand),
    context: {
      ...input.context,
      excludedEntries: shuffled(input.context.excludedEntries, rand),
      heats: shuffled(input.context.heats, rand).map((h) => ({ ...h, officialIds: shuffled(h.officialIds, rand), entryIds: shuffled(h.entryIds, rand) })),
      danceIds: shuffled(input.context.danceIds, rand),
    },
  };
}
