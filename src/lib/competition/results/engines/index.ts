export * from "./types";
export { studioOrdinalMajority, runStudioOrdinalMajority, ORDINAL_MAJORITY_SPEC } from "./studioOrdinalMajority";
export { studioCallbackTally, runStudioCallbackTally, CALLBACK_TALLY_SPEC, NOT_CALLED_BACK_LABEL } from "./studioCallbackTally";

import { studioCallbackTally } from "./studioCallbackTally";
import { studioOrdinalMajority } from "./studioOrdinalMajority";
import type { ScoringEngine, StudioEngineId } from "./types";

/** Engines by registry id; the only engines F1 provides. */
export const STUDIO_ENGINES: Readonly<Record<StudioEngineId, ScoringEngine>> = {
  "studio_callback_tally@1": studioCallbackTally,
  "studio_ordinal_majority@1": studioOrdinalMajority,
};
