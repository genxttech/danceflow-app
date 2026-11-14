/**
 * PV-1 golden-fixture capture (QA tooling, never part of the app). Loaded only by scripts/qa/pv1/capture.vitest.mts: every input the F1 engine suites
 * pass to the two Studio engines is appended, with the engine's own result, to the JSONL file named by PV1_CAPTURE. The engines are not modified;
 * their public run functions are wrapped.
 */
import fs from "node:fs";
import { vi } from "vitest";

const out = process.env.PV1_CAPTURE;
if (!out) throw new Error("PV1_CAPTURE (output JSONL path) is required");

function record(engine: "callback" | "ordinal", input: unknown, run: unknown) {
  fs.appendFileSync(out!, `${JSON.stringify({ engine, input, run })}\n`);
}

vi.mock("@/lib/competition/results/engines/studioCallbackTally", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/competition/results/engines/studioCallbackTally")>();
  const run: typeof m.runStudioCallbackTally = (input) => {
    const snapshot = JSON.parse(JSON.stringify(input ?? null));
    const result = m.runStudioCallbackTally(input);
    record("callback", snapshot, result);
    return result;
  };
  return { ...m, runStudioCallbackTally: run, studioCallbackTally: { ...m.studioCallbackTally, run } };
});

vi.mock("@/lib/competition/results/engines/studioOrdinalMajority", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/competition/results/engines/studioOrdinalMajority")>();
  const run: typeof m.runStudioOrdinalMajority = (input) => {
    const snapshot = JSON.parse(JSON.stringify(input ?? null));
    const result = m.runStudioOrdinalMajority(input);
    record("ordinal", snapshot, result);
    return result;
  };
  return { ...m, runStudioOrdinalMajority: run, studioOrdinalMajority: { ...m.studioOrdinalMajority, run } };
});
