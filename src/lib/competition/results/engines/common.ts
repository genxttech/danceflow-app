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

/**
 * Input size caps (review P2-3). A calculation is a synchronous, in-process loop over the input; an oversized or hostile envelope must fail closed
 * before it is hashed or looped over, never exhaust the server. The caps are far above any real studio round (a 300-couple round, 15 judges).
 */
export const ENGINE_INPUT_CAPS = {
  entries: 1000,
  judges: 25,
  marks: 50_000,
  heats: 500,
  excludedEntries: 1000,
  danceIds: 50,
  heatEntriesTotal: 2000,
  heatOfficials: 25,
  tieBreakChain: 32,
  idLength: 200,
} as const;

function tooLarge(field: string, count: number, max: number): never {
  throw new EngineFailure("COMP_ENGINE_INVALID_INPUT", "input_too_large", [], { field, count, max });
}

function capArray(field: string, value: unknown, max: number): void {
  if (!Array.isArray(value)) throw new EngineFailure("COMP_ENGINE_INVALID_INPUT", "malformed_input", [], { field });
  if (value.length > max) tooLarge(field, value.length, max);
}

/** Throws an EngineFailure (never a raw error) when any collection or id exceeds the caps. Runs before canonicalisation and hashing. */
export function checkInputCaps(input: StudioEngineInput): void {
  const c = ENGINE_INPUT_CAPS;
  capArray("entries", input.entries, c.entries);
  capArray("judges", input.judges, c.judges);
  capArray("marks", input.marks, c.marks);
  capArray("tieBreakChain", input.tieBreakChain, c.tieBreakChain);
  const ctx = input.context;
  if (ctx === null || typeof ctx !== "object") throw new EngineFailure("COMP_ENGINE_INVALID_INPUT", "malformed_input", [], { field: "context" });
  capArray("context.excludedEntries", ctx.excludedEntries, c.excludedEntries);
  capArray("context.heats", ctx.heats, c.heats);
  capArray("context.danceIds", ctx.danceIds, c.danceIds);
  let heatEntries = 0;
  for (const h of ctx.heats) {
    capArray("context.heats[].officialIds", h.officialIds, c.heatOfficials);
    capArray("context.heats[].entryIds", h.entryIds, c.entries);
    heatEntries += h.entryIds.length;
  }
  if (heatEntries > c.heatEntriesTotal) tooLarge("context.heats[].entryIds (total)", heatEntries, c.heatEntriesTotal);
  const longId = (id: unknown) => typeof id === "string" && id.length > c.idLength;
  const tooLong = [
    ...input.entries.map((e) => e.entryId),
    ...input.judges.map((j) => j.officialId),
    ...input.marks.flatMap((m) => [m.officialId, m.entryId]),
  ].filter(longId);
  if (tooLong.length > 0) tooLarge("id length", (tooLong[0] as string).length, c.idLength);
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
    checkInputCaps(input);
  } catch (error) {
    if (error instanceof EngineFailure) return finishFailure(error);
    return finishFailure(new EngineFailure("COMP_ENGINE_INVALID_INPUT", "malformed_input", [], { message: String(error) }));
  }

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

/** Profile families the Studio v1 engines are specified for (studio_simple @1 and @3); anything else is not guessed at. */
export const SUPPORTED_PROFILE_KEY = "studio_simple";
export const SUPPORTED_PROFILE_VERSIONS: readonly number[] = [1, 3];

/**
 * Neither Studio v1 engine reads a tie-break chain (callback: D-CT-4 is a fixed rule; ordinal: "A different chain ships as ordinal_majority@2"),
 * and both are specified for studio_simple @1/@3 only. A non-empty chain or another profile fails closed instead of being silently ignored (review P2-2).
 */
export function checkProfileAndTieChain(input: StudioEngineInput, validation: ValidationLog, id: string): void {
  if (!Array.isArray(input.tieBreakChain) || input.tieBreakChain.length > 0) {
    validation.fail(id, "no tie-break chain (the engine's tie rule is fixed)", "COMP_ENGINE_UNSPECIFIED_CASE", "tie_break_chain_unsupported", [], {
      chain: Array.isArray(input.tieBreakChain) ? input.tieBreakChain : null,
    });
  }
  const p = input.profile;
  if (!p || p.key !== SUPPORTED_PROFILE_KEY || !SUPPORTED_PROFILE_VERSIONS.includes(p.version)) {
    validation.fail(id, "profile is studio_simple @1 or @3", "COMP_ENGINE_UNSPECIFIED_CASE", "profile_unsupported", [], { profile: p ?? null });
  }
  validation.pass(id, "no tie-break chain; profile is studio_simple @1 or @3");
}

/** X-3 option flags, X-3 panel size, X-7 same panel in every heat, X-6 one dance. Shared by both engines. */
export function checkPanelStructure(
  input: StudioEngineInput,
  judges: readonly PanelJudge[],
  validation: ValidationLog,
  ids: { x3: string; x3Flags: string; x7: string; x6: string },
): string[] {
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
  // Runs AFTER the approved X-3 / X-7 / X-6 refusals so a multi-dance or mixed-panel round still reports the approved COMP_ENGINE_UNSPECIFIED_CASE
  // reason (an entry on two heats is normal there), and only a single-dance, single-panel round reaches this data-integrity check.
  // Review P2-4: every calculated entry is in exactly one heat. An entry in two heats, or in none, would be counted against a panel that did not
  // judge it (or not at all). Excluded (scratched / no-show) entries may stay on a heat roster.
  // X-5 excludes scratched and no-show entries from calculation at ENTRY level; the A3 contract applies one entry-level exclusion with precedence
  // scratched > no_show > excluded even when the entry's heat rows differ (scratched on one heat, no-show on another). An excluded entry is not
  // calculated, so how many heat rosters still list it is irrelevant to this check: only calculated entries must be in exactly one heat.
  const excludedIds = new Set(input.context.excludedEntries.map((e) => e.entryId));
  const heatOf = new Map<string, number>();
  for (const h of heats) for (const id of new Set(h.entryIds)) heatOf.set(id, (heatOf.get(id) ?? 0) + 1);
  const inTwoHeats = [...heatOf].filter(([id, n]) => n > 1 && !excludedIds.has(id)).map(([id]) => id);
  const sameHeatTwice = heats.flatMap((h) => h.entryIds.filter((id, i) => h.entryIds.indexOf(id) !== i && !excludedIds.has(id)));
  const calculatedIds = input.entries.map((e) => e.entryId).filter((id) => !excludedIds.has(id));
  const inNoHeat = calculatedIds.filter((id) => !heatOf.has(id));
  const coverageOffenders = [...inTwoHeats, ...sameHeatTwice, ...inNoHeat];
  if (coverageOffenders.length > 0) {
    validation.fail(ids.x7, "every calculated entry is in exactly one heat", "COMP_ENGINE_INVALID_INPUT", "entry_heat_coverage", coverageOffenders, {
      inMoreThanOneHeat: sortedUnique([...inTwoHeats, ...sameHeatTwice]),
      inNoHeat: sortedUnique(inNoHeat),
    });
  }
  // INT5-SECFIX P3: the entry-level exclusion above is silent about WHICH heats still list an excluded entry. When it is listed on more than one heat
  // (scratched on one, no-show on the other, ...) the whole entry is excluded (A3 precedence, unchanged) and a warning names the heats, so the
  // trace-side output shows the entry was dropped everywhere. A warning is derived from the input, so it changes neither the input hash nor the
  // exclusion; it is part of the output hash like the other warnings.
  const heatsOf = new Map<string, Set<string>>();
  for (const h of heats) for (const id of h.entryIds) if (excludedIds.has(id)) heatsOf.set(id, (heatsOf.get(id) ?? new Set<string>()).add(h.heatId));
  return [...heatsOf]
    .filter(([, hs]) => hs.size > 1)
    .map(([id, hs]) => `excluded_entry_in_multiple_heats:${id}@${[...hs].sort(cmp).join("+")}`)
    .sort(cmp);
}

/** Mark table for the `inputs` trace record: fully ordered, so duplicate marks with different values trace identically. */
export function traceMarks(input: StudioEngineInput, letterOf: Map<string, string>) {
  return input.marks
    .map((m) => ({ judge: letterOf.get(m.officialId) ?? m.officialId, entryId: m.entryId, value: m.value }))
    .sort((a, b) => cmp(a.judge, b.judge) || cmp(a.entryId, b.entryId) || cmp(canonicalJson(a.value), canonicalJson(b.value)));
}
