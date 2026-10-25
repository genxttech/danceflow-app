/**
 * F2: the narrow interface between the results lifecycle and the scoring engines.
 *
 * F1 owns the engines (pure TypeScript under src/lib/competition/scoring/**). The lifecycle only needs "given this evidence,
 * return rows + trace + warnings", so that is all this module defines. `REGISTERED_ENGINES` is empty until F1 registers its
 * approved engines (studio_ordinal_majority@1, studio_callback_tally@1); the action therefore reports
 * COMP_ENGINE_NOT_AVAILABLE for every round today. A test-only stub lives in __tests__/stubEngine.ts and is never
 * imported by application code.
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
