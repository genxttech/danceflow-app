/**
 * PV-1 randomized corpus: seeded, reproducible engine inputs (both Studio engines), each run through the TypeScript engine. Output JSONL lines
 * {engine, input, run} in the same shape as the golden capture. Usage:
 *   node --import tsx scripts/qa/pv1/random-corpus.ts <seed> <count> <out.jsonl>
 * Inputs mimic database evidence (uuid ids, one dance, heats with panels) and deliberately include the failure and edge cases the engines guard:
 * even/small panels, ties at the cut, unknown capacity, excluded entries listed on heats, wrong callback counts, tied or out-of-range marks.
 */
import fs from "node:fs";
import { runStudioCallbackTally } from "../../../src/lib/competition/results/engines/studioCallbackTally";
import { runStudioOrdinalMajority } from "../../../src/lib/competition/results/engines/studioOrdinalMajority";
import type { StudioEngineInput } from "../../../src/lib/competition/results/engines/types";

const [seedArg, countArg, outPath] = process.argv.slice(2);
if (!outPath) throw new Error("usage: random-corpus.ts <seed> <count> <out.jsonl>");

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(seedArg));
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p: number) => rand() < p;
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
const hex = (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[int(0, 15)]).join("");
const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-${pick(["8", "9", "a", "b"])}${hex(3)}-${hex(12)}`;
function shuffle<T>(xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function build(engine: "callback" | "ordinal"): StudioEngineInput {
  const n = int(1, 12);
  const entries = Array.from({ length: n }, () => uuid());
  const excluded = chance(0.3) ? shuffle(entries).slice(0, int(1, Math.min(2, n))) : [];
  const calculated = entries.filter((e) => !excluded.includes(e));
  const J = chance(0.85) ? pick([3, 5, 7]) : pick([1, 2, 4]);
  const judges = Array.from({ length: J }, (_, i) => ({ officialId: uuid(), letter: String.fromCharCode(65 + i) }));
  const panel = judges.map((j) => j.officialId);
  // Heats: callback 1-3 heats partitioning the calculated entries; ordinal usually one heat.
  const heatCount = engine === "ordinal" ? (chance(0.9) ? 1 : 2) : int(1, 3);
  const heats = Array.from({ length: heatCount }, () => ({ heatId: uuid(), officialIds: [...panel], entryIds: [] as string[] }));
  calculated.forEach((e) => heats[int(0, heatCount - 1)].entryIds.push(e));
  if (excluded.length && chance(0.3)) heats[0].entryIds.push(excluded[0]);
  if (excluded.length && heatCount > 1 && chance(0.2)) heats[1].entryIds.push(excluded[0]);
  if (chance(0.04)) heats[0].officialIds = heats[0].officialIds.slice(1);
  if (chance(0.03) && calculated.length > 0 && heatCount > 1) heats[1].entryIds.push(heats[0].entryIds[0] ?? calculated[0]);
  const danceIds = chance(0.95) ? ["dance-1"] : ["dance-1", "dance-2"];
  const profile = chance(0.97) ? { key: "studio_simple", version: pick([1, 3]) } : { key: "studio_simple", version: 2 };

  const marks: StudioEngineInput["marks"] = [];
  let round: StudioEngineInput["round"];
  let finalCapacity: number | null = null;
  if (engine === "callback") {
    const T = chance(0.05) ? null : int(1, n + 1);
    round = { id: uuid(), roundType: "preliminary", targetAdvancementCount: T, advancementMethod: "promote_callback" } as StudioEngineInput["round"];
    finalCapacity = chance(0.15) ? null : int(1, 10);
    // A shared "strength" so tallies cluster and ties at the cut are common.
    const strength = new Map(calculated.map((e) => [e, rand()]));
    for (const j of judges) {
      const want = T === null ? int(0, calculated.length) : chance(0.88) ? Math.min(T, calculated.length) : int(0, calculated.length);
      const ranked = [...calculated].sort((a, b) => strength.get(b)! + rand() * 0.5 - (strength.get(a)! + rand() * 0.5));
      for (const e of ranked.slice(0, want)) marks.push({ officialId: j.officialId, entryId: e, value: chance(0.995) ? true : 1 });
      if (excluded.length && chance(0.1)) marks.push({ officialId: j.officialId, entryId: excluded[0], value: true });
    }
  } else {
    round = { id: uuid(), roundType: "final", targetAdvancementCount: null, advancementMethod: null } as StudioEngineInput["round"];
    const N = calculated.length;
    const base = shuffle(calculated);
    for (const j of judges) {
      // Mostly the base order with a few swaps, so majorities and tie chains occur.
      const order = [...base];
      for (let k = 0; k < int(0, 3); k++) {
        const a = int(0, Math.max(0, N - 1));
        const b = Math.min(N - 1, a + 1);
        [order[a], order[b]] = [order[b], order[a]];
      }
      if (chance(0.15)) order.splice(0, order.length, ...shuffle(order));
      order.forEach((e, i) => marks.push({ officialId: j.officialId, entryId: e, value: i + 1 }));
      if (chance(0.03) && N > 1 && marks.length) marks[marks.length - 1].value = 1;
      if (chance(0.02) && marks.length) marks[marks.length - 1].value = N + 1;
      if (excluded.length && chance(0.05)) marks.push({ officialId: j.officialId, entryId: excluded[0], value: N + 1 });
    }
  }
  if (chance(0.02) && marks.length) marks.push({ ...marks[0] });
  return {
    engineKey: engine === "callback" ? "callback_tally" : "ordinal_majority",
    engineVersion: "1",
    profile,
    round,
    markScheme: null,
    tieBreakChain: [],
    entries: entries.map((entryId) => ({ entryId })),
    judges,
    marks,
    context: {
      excludedEntries: excluded.map((entryId) => ({ entryId, reason: pick(["scratched", "no_show"] as const) })),
      heats,
      danceIds,
      chiefJudgeTiebreak: chance(0.02),
      scoreRolesSeparately: false,
      finalCapacity,
    },
  } as StudioEngineInput;
}

const lines: string[] = [];
for (let i = 0; i < Number(countArg); i++) {
  const engine = chance(0.5) ? "callback" : "ordinal";
  const input = build(engine);
  const snapshot = JSON.parse(JSON.stringify(input));
  const run = engine === "callback" ? runStudioCallbackTally(input) : runStudioOrdinalMajority(input);
  lines.push(JSON.stringify({ engine, input: snapshot, run }));
}
fs.writeFileSync(outPath, `${lines.join("\n")}\n`);
const ok = lines.filter((l) => JSON.parse(l).run.ok).length;
console.log(JSON.stringify({ seed: Number(seedArg), cases: lines.length, ok, fail: lines.length - ok }));
