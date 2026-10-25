/**
 * F2: server-side orchestration of one calculation. Reads the evidence from the database, runs the pinned engine through
 * the narrow interface, and hands the result to `calculate_competition_round`, which re-verifies the input hash against the
 * ballots at write time. Pure with respect to its injected `rpc`, so it is unit-tested without a database.
 */
import { evidenceHash, traceHash, type EvidenceInput } from "./evidence";
import type { EngineLookup, EngineRow } from "./engines";

export type Rpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

type CalculationInput = {
  available: boolean;
  code?: string;
  status: string;
  engine_key?: string;
  engine_version?: string;
  evidence?: EvidenceInput;
  input_hash?: string;
};

export type CalculateOutcome = { ok: true; versionId: string; version: number; replayed: boolean } | { ok: false; code: string; message: string };

const fail = (code: string, message = code): CalculateOutcome => ({ ok: false, code, message });

function codeOf(message: string): string {
  return /COMP_[A-Z0-9_]+/.exec(message)?.[0] ?? message;
}

export function rowToRpc(row: EngineRow) {
  return {
    entry_id: row.entryId,
    placement: row.placement ?? null,
    tie_group: row.tieGroup ?? null,
    advanced: row.advanced ?? null,
    rating_band: row.ratingBand ?? null,
    output: row.output ?? {},
  };
}

export async function calculateRound(deps: { rpc: Rpc; engineFor: EngineLookup }, roundId: string, requestId: string): Promise<CalculateOutcome> {
  const read = await deps.rpc("competition_round_calculation_input", { p_round_id: roundId });
  if (read.error) return fail(codeOf(read.error.message), read.error.message);
  const input = read.data as CalculationInput | null;
  if (!input) return fail("COMP_FORBIDDEN");
  if (!input.available || !input.engine_key || !input.engine_version || !input.evidence || !input.input_hash) {
    return fail(input.code ?? "COMP_ENGINE_NOT_AVAILABLE");
  }
  if (input.status !== "ballots_locked") return fail("COMP_RESULT_INVALID_TRANSITION");

  const engine = deps.engineFor(input.engine_key, input.engine_version);
  if (!engine) return fail("COMP_ENGINE_NOT_AVAILABLE");

  // The database hashes the same document with its own canonicalizer; disagreement means do not calculate.
  const localHash = evidenceHash(input.evidence);
  if (localHash !== input.input_hash) return fail("COMP_RESULT_STALE", "The evidence hash computed by the app and by the database differ.");

  let run;
  try {
    run = engine.run(input.evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(/COMP_ENGINE_[A-Z_]+/.exec(message)?.[0] ?? "COMP_ENGINE_INVALID_INPUT", message);
  }

  const saved = await deps.rpc("calculate_competition_round", {
    p_round_id: roundId,
    p_engine_key: input.engine_key,
    p_engine_version: input.engine_version,
    p_input_hash: localHash,
    p_trace_hash: traceHash(run.trace),
    p_trace: run.trace,
    p_rows: run.rows.map(rowToRpc),
    p_warnings: run.warnings,
    p_request_id: requestId,
  });
  if (saved.error) return fail(codeOf(saved.error.message), saved.error.message);
  const data = saved.data as { result_version_id: string; version: number; replayed: boolean };
  return { ok: true, versionId: data.result_version_id, version: data.version, replayed: Boolean(data.replayed) };
}
