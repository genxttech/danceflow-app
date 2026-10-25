/**
 * F2: the narrow interface between the results lifecycle and the scoring engines, plus the thin mapper to F1's engines.
 *
 * F1 (PR #337, src/lib/competition/results/engines/) owns the engines. The lifecycle only needs "given this evidence, return
 * rows + trace + warnings". `toStudioEngineInput` maps F2's evidence document one to one onto F1's input shape and
 * `adaptStudioEngine` wraps an F1 engine in that interface. Both are structural: nothing here imports F1, so F2 compiles
 * without it, and the mapper holds NO scoring logic (renames and copies only).
 *
 * `REGISTERED_ENGINES` is empty in this PR. Once #337 is merged, registering is one line:
 * `STUDIO_ENGINES_BY_ID.map((id) => adaptStudioEngine(STUDIO_ENGINES[id]))`. Until then the action reports
 * COMP_ENGINE_NOT_AVAILABLE. A test-only stub lives in __tests__/stubEngine.ts and is never imported by application code.
 */
import type { EvidenceInput } from "./evidence";

export type EngineRow = {
  entryId: string;
  placement?: number | null;
  tieGroup?: string | null;
  advanced?: boolean | null;
  ratingBand?: string | null;
  output?: Record<string, unknown>;
};

export type EngineRun = { rows: EngineRow[]; trace: unknown[]; warnings: string[] };

export interface ResultEngine {
  key: string;
  version: string;
  /** Pure and deterministic. Throws an Error whose message starts with COMP_ENGINE_UNSPECIFIED_CASE / COMP_ENGINE_INVALID_INPUT to fail closed. */
  run(input: EvidenceInput): EngineRun;
}

/** F1 appends its approved engines here. Nothing else may add to this list. */
export const REGISTERED_ENGINES: readonly ResultEngine[] = [];

export type EngineLookup = (key: string, version: string) => ResultEngine | undefined;

export const lookupRegisteredEngine: EngineLookup = (key, version) =>
  REGISTERED_ENGINES.find((engine) => engine.key === key && engine.version === version);

// ---------------------------------------------------------------------------------------------------
// Thin mapper to F1's engine input (structural copy of F1's StudioEngineInput / ScoringEngine; no import of F1)
// ---------------------------------------------------------------------------------------------------

export type StudioEngineInputShape = {
  engineKey: string;
  engineVersion: string;
  profile: { key: string; version: number };
  round: { id: string; roundType: string; targetAdvancementCount: number | null; advancementMethod: string | null };
  markScheme: unknown;
  tieBreakChain: string[];
  entries: Array<{ entryId: string }>;
  judges: Array<{ officialId: string; letter: string }>;
  marks: Array<{ officialId: string; entryId: string; role?: "leader" | "follower" | null; value: unknown }>;
  context: {
    excludedEntries: Array<{ entryId: string; reason: "scratched" | "no_show" }>;
    heats: Array<{ heatId: string; officialIds: string[]; entryIds: string[] }>;
    danceIds: string[];
    chiefJudgeTiebreak: boolean;
    scoreRolesSeparately: boolean;
    finalCapacity?: number | null;
  };
};

type StudioEngineRunShape =
  | { ok: true; rows: EngineRow[]; trace: unknown[]; warnings: string[] }
  | { ok: false; code: string; reason: string };

/** The part of F1's `ScoringEngine` the adapter needs. */
export type StudioEngineLike = { id: string; key: string; version: string; run(input: StudioEngineInputShape): StudioEngineRunShape };

/** F2's engine_key is the registry id's name part (studio_ordinal_majority); F1's input carries the K0 scoring_method key (ordinal_majority). */
export function studioEngineKeyToMethodKey(engineKey: string): string {
  return engineKey.replace(/^studio_/, "");
}

export function toStudioEngineInput(ev: EvidenceInput): StudioEngineInputShape {
  if (!ev.profile) throw new Error("COMP_ENGINE_INVALID_INPUT: the round's program has no locked rules profile");
  return {
    engineKey: studioEngineKeyToMethodKey(ev.engineKey),
    engineVersion: ev.engineVersion,
    profile: ev.profile,
    round: ev.round,
    markScheme: ev.markScheme,
    tieBreakChain: ev.tieBreakChain,
    entries: ev.entries,
    judges: ev.judges,
    marks: ev.marks.map((m) => ({ officialId: m.officialId, entryId: m.entryId, role: m.role, value: m.value })),
    context: {
      excludedEntries: ev.excludedEntries,
      heats: ev.heats,
      danceIds: ev.danceIds,
      chiefJudgeTiebreak: ev.chiefJudgeTiebreak,
      scoreRolesSeparately: ev.scoreRolesSeparately,
      finalCapacity: ev.finalCapacity,
    },
  };
}

/** Wraps an F1 engine; an engine failure becomes the thrown fail-closed error the calculate path already understands. */
export function adaptStudioEngine(engine: StudioEngineLike): ResultEngine {
  return {
    key: engine.id.split("@")[0],
    version: engine.version,
    run(ev) {
      const run = engine.run(toStudioEngineInput(ev));
      if (!run.ok) throw new Error(`${run.code}: ${run.reason}`);
      return { rows: run.rows, trace: run.trace, warnings: run.warnings };
    },
  };
}
