import { createHash } from "node:crypto";
import { canonicalEngineInput, canonicalJson, type EngineFailureCode, type V1EngineKey } from "../contract";
import type { EngineRun, StudioEngineInput, TraceRecord } from "./types";
import type { EngineResultRow } from "../contract";

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(cmp);
}

/** Thrown by checks; `runEngine` turns it into a fail-closed result. Never escapes the engine. */
export class EngineFailure extends Error {
  constructor(
    readonly code: EngineFailureCode,
    readonly reason: string,
    readonly offendingIds: string[] = [],
    readonly details: unknown = null,
  ) {
    super(`${code}: ${reason}`);
  }
}

export type ValidationCheck = { id: string; check: string; result: "pass" | "fail" | "skipped" };

/** Records V-checks for the `validation` trace record; the first failure stops the calculation. */
export class ValidationLog {
  readonly checks: ValidationCheck[] = [];
  pass(id: string, check: string): void {
    this.checks.push({ id, check, result: "pass" });
  }
  skip(id: string, check: string): void {
    this.checks.push({ id, check, result: "skipped" });
  }
  fail(id: string, check: string, code: EngineFailureCode, reason: string, offendingIds: string[] = [], details: unknown = null): never {
    this.checks.push({ id, check, result: "fail" });
    throw new EngineFailure(code, reason, sortedUnique(offendingIds), details);
  }
}

export type EngineBodyResult = { rows: EngineResultRow[]; warnings: string[] };

type EngineMeta = { key: V1EngineKey; specRef: string };

/**
 * Wraps an engine body: canonical input hash, `engine` trace record, fail-closed handling of every thrown error
 * (a malformed envelope is a fail-closed INVALID_INPUT, never a guessed result), trace and output hashes.
 */
export function runEngine(
  meta: EngineMeta,
  input: StudioEngineInput,
  body: (trace: TraceRecord[], validation: ValidationLog) => EngineBodyResult,
): EngineRun {
  const trace: TraceRecord[] = [{ step: "engine", rule: meta.specRef, data: { key: meta.key, version: "1", spec: meta.specRef } }];
  const validation = new ValidationLog();
  let inputHash: string | null = null;

  const finishFailure = (failure: EngineFailure): EngineRun => {
    trace.push({ step: "validation", rule: meta.specRef, data: { checks: validation.checks } });
    trace.push({
      step: "failure",
      rule: meta.specRef,
      data: { code: failure.code, reason: failure.reason, offendingIds: sortedUnique(failure.offendingIds), details: failure.details },
    });
    return {
      ok: false,
      engineKey: meta.key,
      engineVersion: "1",
      code: failure.code,
      reason: failure.reason,
      offendingIds: sortedUnique(failure.offendingIds),
      trace,
      inputHash,
      traceHash: sha256Hex(canonicalJson(trace)),
    };
  };

  try {
    inputHash = sha256Hex(canonicalEngineInput(normalizeStudioInput(input)));
  } catch (error) {
    return finishFailure(new EngineFailure("COMP_ENGINE_INVALID_INPUT", "malformed_input", [], { message: String(error) }));
  }

  try {
    const result = body(trace, validation);
    const warnings = [...result.warnings].sort(cmp);
    // The spec orders the trace engine, inputs, validation, ...; checks are collected while the body runs.
    const insertAt = trace.findIndex((r) => r.step === "inputs") + 1;
    trace.splice(insertAt > 0 ? insertAt : trace.length, 0, { step: "validation", rule: meta.specRef, data: { checks: validation.checks } });
    const rows = [...result.rows].sort((a, b) => cmp(a.entryId, b.entryId));
    return {
      ok: true,
      engineKey: meta.key,
      engineVersion: "1",
      rows,
      trace,
      warnings,
      inputHash,
      traceHash: sha256Hex(canonicalJson(trace)),
      outputHash: sha256Hex(canonicalJson({ rows, warnings })),
    };
  } catch (error) {
    if (error instanceof EngineFailure) return finishFailure(error);
    return finishFailure(new EngineFailure("COMP_ENGINE_INVALID_INPUT", "malformed_input", [], { message: String(error) }));
  }
}

/** K0 canonical form plus order-normalized context arrays, so shuffled but identical input hashes identically. */
export function normalizeStudioInput(input: StudioEngineInput): StudioEngineInput {
  const c = input.context;
  return {
    ...input,
    marks: [...input.marks].sort(
      (a, b) => cmp(a.officialId, b.officialId) || cmp(a.entryId, b.entryId) || cmp(String(a.role ?? ""), String(b.role ?? "")) || cmp(canonicalJson(a.value), canonicalJson(b.value)),
    ),
    tieBreakChain: [...input.tieBreakChain],
    context: {
      ...c,
      excludedEntries: [...c.excludedEntries].sort((a, b) => cmp(a.entryId, b.entryId)),
      heats: [...c.heats]
        .map((h) => ({ heatId: h.heatId, officialIds: [...h.officialIds].sort(cmp), entryIds: [...h.entryIds].sort(cmp) }))
        .sort((a, b) => cmp(a.heatId, b.heatId)),
      danceIds: [...c.danceIds].sort(cmp),
    },
  };
}

/** Shared structural checks: key/version, ids unique, excluded entries known, calculated entries. */
export function engineVersionIs1(v: unknown): boolean {
  return String(v) === "1";
}

export type PanelJudge = { officialId: string; letter: string };

/** Judges ordered by letter (spec §8), with duplicate detection. */
export function orderedJudges(judges: readonly PanelJudge[], validation: ValidationLog, id: string): PanelJudge[] {
  const ids = new Set<string>();
  const letters = new Set<string>();
  const dup: string[] = [];
  for (const j of judges) {
    if (ids.has(j.officialId) || letters.has(j.letter)) dup.push(j.officialId);
    ids.add(j.officialId);
    letters.add(j.letter);
  }
  if (dup.length > 0) validation.fail(id, "judges unique by official and letter", "COMP_ENGINE_INVALID_INPUT", "duplicate_judge", dup);
  return [...judges].sort((a, b) => cmp(a.letter, b.letter) || cmp(a.officialId, b.officialId));
}

/** X-5: split entries into calculated and excluded; duplicate or unknown ids fail closed. */
export function splitEntries(input: StudioEngineInput, validation: ValidationLog): { calculated: string[]; excluded: string[]; all: string[] } {
  const all = input.entries.map((e) => e.entryId);
  const unique = new Set(all);
  if (unique.size !== all.length) {
    const seen = new Set<string>();
    const dup = all.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    validation.fail("S1", "entries unique", "COMP_ENGINE_INVALID_INPUT", "duplicate_entry", dup);
  }
  const exIds = input.context.excludedEntries.map((e) => e.entryId);
  if (new Set(exIds).size !== exIds.length) {
    validation.fail("S2", "excluded entries unique", "COMP_ENGINE_INVALID_INPUT", "duplicate_excluded_entry", exIds.filter((id, i) => exIds.indexOf(id) !== i));
  }
  const unknown = input.context.excludedEntries.map((e) => e.entryId).filter((id) => !unique.has(id));
  if (unknown.length > 0) validation.fail("S2", "excluded entries belong to the round", "COMP_ENGINE_INVALID_INPUT", "excluded_entry_not_in_round", unknown);
  const excluded = new Set(input.context.excludedEntries.map((e) => e.entryId));
  return {
    all: [...all].sort(cmp),
    excluded: [...excluded].sort(cmp),
    calculated: all.filter((id) => !excluded.has(id)).sort(cmp),
  };
}

/** X-3 option flags, X-3 panel size, X-7 same panel in every heat, X-6 one dance. Shared by both engines. */
export function checkPanelStructure(input: StudioEngineInput, judges: readonly PanelJudge[], validation: ValidationLog, ids: { x3: string; x3Flags: string; x7: string; x6: string }): void {
  if (input.context.chiefJudgeTiebreak || input.context.scoreRolesSeparately) {
    validation.fail(ids.x3Flags, "no chief-judge tiebreak / per-role scoring (X-3)", "COMP_ENGINE_UNSPECIFIED_CASE", "x3_option_unsupported");
  }
  validation.pass(ids.x3Flags, "no chief-judge tiebreak / per-role scoring (X-3)");
  if (judges.length < 3 || judges.length % 2 === 0) {
    validation.fail(ids.x3, "at least 3 judges and an odd panel (X-3)", "COMP_ENGINE_UNSPECIFIED_CASE", "panel_size", [], { judges: judges.length });
  }
  validation.pass(ids.x3, "at least 3 judges and an odd panel (X-3)");
  const panel = judges.map((j) => j.officialId).sort(cmp);
  const heats = input.context.heats;
  if (heats.length === 0) {
    validation.fail(ids.x7, "same panel in every heat (X-7)", "COMP_ENGINE_UNSPECIFIED_CASE", "heat_panels_missing");
  }
  const heatIds = heats.map((h) => h.heatId);
  if (new Set(heatIds).size !== heatIds.length) {
    validation.fail(ids.x7, "heats unique", "COMP_ENGINE_INVALID_INPUT", "duplicate_heat", heatIds.filter((id, i) => heatIds.indexOf(id) !== i));
  }
  const roundEntries = new Set(input.entries.map((e) => e.entryId));
  const strayHeatEntries = heats.flatMap((h) => h.entryIds).filter((id) => !roundEntries.has(id));
  if (strayHeatEntries.length > 0) {
    validation.fail(ids.x7, "heat entries belong to the round", "COMP_ENGINE_INVALID_INPUT", "heat_entry_not_in_round", strayHeatEntries);
  }
  const mismatched = heats.filter((h) => {
    const hp = [...h.officialIds].sort(cmp);
    return hp.length !== panel.length || hp.some((id, i) => id !== panel[i]);
  });
  if (mismatched.length > 0) {
    validation.fail(ids.x7, "same panel in every heat (X-7)", "COMP_ENGINE_UNSPECIFIED_CASE", "heat_panel_mismatch", mismatched.map((h) => h.heatId));
  }
  validation.pass(ids.x7, "same panel in every heat (X-7)");
  if (input.context.danceIds.length !== 1) {
    validation.fail(ids.x6, "exactly one dance per run (X-6)", "COMP_ENGINE_UNSPECIFIED_CASE", "multi_dance_unsupported", input.context.danceIds, {
      dances: input.context.danceIds.length,
    });
  }
  validation.pass(ids.x6, "exactly one dance per run (X-6)");
}

/** Mark table for the `inputs` trace record: fully ordered, so duplicate marks with different values trace identically. */
export function traceMarks(input: StudioEngineInput, letterOf: Map<string, string>) {
  return input.marks
    .map((m) => ({ judge: letterOf.get(m.officialId) ?? m.officialId, entryId: m.entryId, value: m.value }))
    .sort((a, b) => cmp(a.judge, b.judge) || cmp(a.entryId, b.entryId) || cmp(canonicalJson(a.value), canonicalJson(b.value)));
}
