/**
 * F1: shared interface for the Studio v1 scoring engines (K0 §5 boundary).
 *
 * The K0 `EngineInput` / `EngineOutput` envelope is unchanged. The facts the approved Studio specs need that the
 * envelope does not carry (scratched / no-show entries, the panel of every heat, the dances in the input, the final's
 * heat capacity, the X-3 option flags) travel in `context`; the server builds it from the same locked rows as the
 * envelope and it is part of the canonical input hash.
 *
 * Engines are pure: no clock, database, network, randomness, names or entry numbers.
 */

import type { EngineFailureCode, EngineInput, EngineOutput, V1EngineKey } from "../contract";

/** Engine ids fixed by the scoring method registry (REG, PR 338). */
export const STUDIO_ENGINE_IDS = ["studio_callback_tally@1", "studio_ordinal_majority@1"] as const;
export type StudioEngineId = (typeof STUDIO_ENGINE_IDS)[number];

export type TraceRecord = { step: string; rule: string; data: unknown };

/** One heat of the round and the panel that judged it (X-7: every heat must have the same panel). */
export type EngineHeat = { heatId: string; officialIds: string[]; entryIds: string[] };

export type ExcludedEntry = { entryId: string; reason: "scratched" | "no_show" };

export type StudioEngineContext = {
  /** X-5: scratched and no-show entries are excluded from calculation and never placed last. */
  excludedEntries: ExcludedEntry[];
  /** X-7: every heat of the round with its panel. */
  heats: EngineHeat[];
  /** X-6: exactly one dance per run. */
  danceIds: string[];
  /** X-3: a round with either option set to true is refused. */
  chiefJudgeTiebreak: boolean;
  scoreRolesSeparately: boolean;
  /** callback_tally only: the final's configured couples-per-heat capacity (10D). */
  finalCapacity?: number | null;
};

export type StudioEngineInput = EngineInput & { context: StudioEngineContext };

export type EngineRunSuccess = EngineOutput & {
  ok: true;
  engineKey: V1EngineKey;
  engineVersion: "1";
  /** sha256 of the K0 canonical serialization of the input (context included, arrays normalized). */
  inputHash: string;
  /** sha256 of canonicalJson(trace). */
  traceHash: string;
  /** sha256 of canonicalJson({rows, warnings}). */
  outputHash: string;
};

export type EngineRunFailure = {
  ok: false;
  engineKey: V1EngineKey;
  engineVersion: "1";
  code: EngineFailureCode;
  /** Stable machine reason, e.g. `judge_tie`, `callback_count`, `tie_over_capacity`. */
  reason: string;
  offendingIds: string[];
  /** The trace up to and including the `failure` record. No rows are ever returned on failure. */
  trace: TraceRecord[];
  inputHash: string | null;
  traceHash: string;
};

export type EngineRun = EngineRunSuccess | EngineRunFailure;

export type ScoringEngine = {
  /** Registry engine id (REG `engineId`): `<method>@<version>`. */
  id: StudioEngineId;
  /** K0 scoring_method key the engine is bound to. */
  key: V1EngineKey;
  version: "1";
  /** Spec the engine implements (docs/competition). */
  specRef: string;
  /** Ballot format the engine accepts (E2 formats registry). */
  ballotFormat: { id: string; version: number };
  run(input: StudioEngineInput): EngineRun;
};
