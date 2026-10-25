/**
 * Studio scoring SETUP (SS1; docs/competition/scoring-method-registry.md, scoring-architecture-decisions.md).
 *
 * Lets an organizer configure a studio division with an approved registry method per round:
 *   - "Callbacks + Final": a callback round scored by studio_callback_tally@1 (ballot callback_yes@1), then a single-heat
 *     Final scored by studio_ordinal_majority@1 (ballot ordinal_rank@1);
 *   - "Final only": a Final scored by studio_ordinal_majority@1.
 *
 * Pure planning and validation only. Persistence and authorization live in scoringActions.ts; the database guard
 * (guard_competition_scoring_selection, REG) is the second, independent fail-closed layer. Nothing here approximates a
 * governing-body method: a preset is selectable only when EVERY method it names is `approved` in the registry (UCWDC,
 * proficiency, NDCA and WSDC are not, so no preset can name them). A selection is pinned by REG itself when the program is
 * published (profile_locked_at); this module never writes a pin.
 */

import { ballotFormatForScoring } from "../ballots/formats";
import {
  LEGACY_SCORING_MAP,
  checkCompatibility,
  methodId,
  resolveMethod,
  selectableMethods,
  type RegistryEntry,
  type ResultPurpose,
} from "./registry";

export type StudioPresetKey = "callbacks_final" | "final_only";

type Slot = { slot: "callback" | "final"; roundType: "preliminary" | "final"; name: string; key: string; version: string; purpose: ResultPurpose };

export type StudioPreset = { key: StudioPresetKey; label: string; description: string; slots: readonly Slot[] };

const CALLBACK_SLOT: Slot = { slot: "callback", roundType: "preliminary", name: "Callback round", key: "studio_callback_tally", version: "1", purpose: "advancement" };
const FINAL_SLOT: Slot = { slot: "final", roundType: "final", name: "Final", key: "studio_ordinal_majority", version: "1", purpose: "placement" };

export const STUDIO_PRESETS: readonly StudioPreset[] = Object.freeze([
  {
    key: "callbacks_final",
    label: "Callbacks + Final",
    description: "A callback round (judges mark yes) advances the target number of couples, then a single-heat Final is ranked by ordinal majority.",
    slots: [CALLBACK_SLOT, FINAL_SLOT],
  },
  {
    key: "final_only",
    label: "Final only (ordinal majority)",
    description: "One single-heat Final, ranked by ordinal majority.",
    slots: [FINAL_SLOT],
  },
]);

/** Fail-closed codes. Registry codes are re-used verbatim so the UI and SQL speak one vocabulary. */
export type SetupCode =
  | "COMP_SCORING_PRESET_UNKNOWN"
  | "COMP_ENGINE_NOT_AVAILABLE"
  | "COMP_METHOD_UNKNOWN"
  | "COMP_METHOD_BALLOT_FORMAT_MISMATCH"
  | "COMP_METHOD_PURPOSE_MISMATCH"
  | "COMP_METHOD_LEGACY_UNMAPPED"
  | "COMP_SCORING_NOT_STUDIO"
  | "COMP_SCORING_PROGRAM_LOCKED"
  | "COMP_SCORING_DIVISION_HAS_ENTRIES"
  | "COMP_SCORING_ROUNDS_CUSTOMIZED"
  | "COMP_SCORING_ROUND_STARTED";

export type SetupFail = { ok: false; code: SetupCode; message: string };

/** The legacy `scoring_method` value that the explicit REG map interprets as this registry method (the value E2 reads). */
export function legacyValueFor(key: string, version: string): string | null {
  for (const [legacy, mapped] of Object.entries(LEGACY_SCORING_MAP)) {
    if (mapped.key === key && mapped.version === version) return legacy;
  }
  return null;
}

export type ResolvedSlot = Slot & { entry: Readonly<RegistryEntry>; engineId: string; legacy: string; ballotFormat: string };

/**
 * Resolves a preset against the registry. Anything not approved + selectable, or whose ballot format / purpose does not
 * fit the round it is placed on, refuses the whole preset (fail closed).
 */
export function resolvePreset(presetKey: string): { ok: true; preset: StudioPreset; slots: ResolvedSlot[] } | SetupFail {
  const preset = STUDIO_PRESETS.find((p) => p.key === presetKey);
  if (!preset) return { ok: false, code: "COMP_SCORING_PRESET_UNKNOWN", message: "Choose one of the listed scoring setups." };
  const selectable = selectableMethods();
  const slots: ResolvedSlot[] = [];
  for (const slot of preset.slots) {
    const resolved = resolveMethod(slot.key, slot.version);
    if (!resolved.ok) return { ok: false, code: resolved.code === "COMP_METHOD_UNKNOWN" ? "COMP_METHOD_UNKNOWN" : "COMP_ENGINE_NOT_AVAILABLE", message: resolved.detail };
    if (!selectable.some((e) => e.key === slot.key && e.version === slot.version)) {
      return { ok: false, code: "COMP_ENGINE_NOT_AVAILABLE", message: `${methodId(slot.key, slot.version)} is not selectable.` };
    }
    const legacy = legacyValueFor(slot.key, slot.version);
    if (!legacy) return { ok: false, code: "COMP_METHOD_LEGACY_UNMAPPED", message: `${methodId(slot.key, slot.version)} has no legacy scoring value.` };
    const format = ballotFormatForScoring(legacy);
    if (!format) return { ok: false, code: "COMP_METHOD_BALLOT_FORMAT_MISMATCH", message: `No ballot format follows ${legacy}.` };
    const ballotFormat = `${format.id}@${format.version}`;
    const compat = checkCompatibility(resolved.entry, { ballotFormat, purpose: slot.purpose });
    if (!compat.ok) return { ok: false, code: compat.code as SetupCode, message: compat.detail };
    slots.push({ ...slot, entry: resolved.entry, engineId: resolved.engineId, legacy, ballotFormat });
  }
  return { ok: true, preset, slots };
}

/** Presets an organizer may pick right now. A preset naming any non-approved method is simply not offered. */
export function selectablePresets(): StudioPreset[] {
  return STUDIO_PRESETS.filter((p) => resolvePreset(p.key).ok);
}

/** S4-2 disclosure shown next to the choice. The wording is the REG provisional text (S4-2 stays open with the owner). */
export const STUDIO_METHOD_DISCLOSURE =
  "These are DanceFlow studio scoring methods. They are not UCWDC, NDCA or WSDC methods and carry no sanctioning claim. " +
  "Choosing one never changes the sanctioning you declare for the event, and DanceFlow does not verify any sanctioning. " +
  "The method is pinned when you publish and cannot be changed afterwards.";

// ---------------------------------------------------------------------------------------------------------------
// Planning the writes
// ---------------------------------------------------------------------------------------------------------------

export type SetupRound = {
  id: string;
  name: string;
  round_type: string;
  sequence_number: number;
  scoring_method: string;
  status: string;
  pairing_mode: string;
  scoring_override_key: string | null;
  scoring_override_version: string | null;
};

export type ConfigureInput = {
  presetKey: string;
  program: { id: string; status: string; profile_locked_at: string | null; rules_profile_key: string | null };
  division: { id: string; scoring_method_key: string | null; scoring_method_version: string | null };
  rounds: readonly SetupRound[];
  /** Sequence numbers held by CANCELLED rounds of the division (they still count for unique(division_id, sequence_number)). */
  cancelledSequences?: readonly number[];
  entryCount: number;
};

export type SetupOp =
  | { op: "set_division_selection"; key: string; version: string }
  | { op: "update_round"; roundId: string; patch: Partial<{ sequence_number: number; scoring_method: string; scoring_override_key: string | null; scoring_override_version: string | null }> }
  | { op: "insert_round"; row: { name: string; round_type: string; sequence_number: number; scoring_method: string; pairing_mode: string; scoring_override_key: string | null; scoring_override_version: string | null } };

const STUDIO_PROFILE_KEY = "studio_simple";

const fail = (code: SetupCode, message: string): SetupFail => ({ ok: false, code, message });

/**
 * Plans the writes that turn a studio division into the chosen preset. Never rewrites a locked program: a published, locked,
 * non-studio or already-entered division is refused (S4-7), and a division whose rounds were customised is refused rather than
 * reshaped. The plan is idempotent: running it on an already configured division yields no ops.
 */
export function planStudioScoring(input: ConfigureInput): { ok: true; ops: SetupOp[] } | SetupFail {
  const resolved = resolvePreset(input.presetKey);
  if (!resolved.ok) return resolved;
  const { program } = input;
  if (program.rules_profile_key !== STUDIO_PROFILE_KEY) {
    return fail("COMP_SCORING_NOT_STUDIO", "Studio scoring methods apply to studio competitions created with the setup wizard.");
  }
  if (program.profile_locked_at !== null || program.status !== "draft") {
    return fail("COMP_SCORING_PROGRAM_LOCKED", "This competition is published, so its scoring cannot be changed. Create a new competition to use these scoring options.");
  }
  if (input.entryCount > 0) return fail("COMP_SCORING_DIVISION_HAS_ENTRIES", "This division already has entries.");

  const rounds = [...input.rounds].sort((a, b) => a.sequence_number - b.sequence_number);
  if (rounds.some((r) => r.status !== "draft")) return fail("COMP_SCORING_ROUND_STARTED", "A round of this division has already been scheduled or started.");

  if (rounds.some((r) => r.scoring_method === "proficiency_rating")) {
    return fail("COMP_SCORING_ROUNDS_CUSTOMIZED", "This division is set up for ratings, which have no approved scoring method. It is not converted to placements automatically.");
  }
  if (resolved.slots.some((s) => s.slot === "callback") && (input.cancelledSequences ?? []).some((n) => n === 1 || n === 2)) {
    return fail("COMP_SCORING_ROUNDS_CUSTOMIZED", "A cancelled round occupies a round position this setup needs. Adjust the rounds in Advanced settings.");
  }
  const slots = resolved.slots;
  const finalSlot = slots.find((s) => s.slot === "final")!;
  const callbackSlot = slots.find((s) => s.slot === "callback") ?? null;
  const shapeOk = callbackSlot
    ? (rounds.length === 1 && rounds[0].round_type === "final") ||
      (rounds.length === 2 && rounds[0].round_type === "preliminary" && rounds[1].round_type === "final")
    : rounds.length === 1 && rounds[0].round_type === "final";
  if (!shapeOk) {
    return fail("COMP_SCORING_ROUNDS_CUSTOMIZED", "This division's rounds were customised, so they are not reshaped automatically. Adjust the rounds in Advanced settings.");
  }

  const ops: SetupOp[] = [];
  const finalRound = rounds[rounds.length - 1];
  const existingCallback = rounds.length === 2 ? rounds[0] : null;

  // The Final: division method is the Final's method, so it needs no override and must not keep a stale one.
  if (callbackSlot && !existingCallback) {
    ops.push({ op: "update_round", roundId: finalRound.id, patch: { sequence_number: finalRound.sequence_number + 1, scoring_method: finalSlot.legacy, scoring_override_key: null, scoring_override_version: null } });
    ops.push({
      op: "insert_round",
      row: { name: callbackSlot.name, round_type: "preliminary", sequence_number: finalRound.sequence_number, scoring_method: callbackSlot.legacy, pairing_mode: finalRound.pairing_mode, scoring_override_key: callbackSlot.key, scoring_override_version: callbackSlot.version },
    });
  } else {
    ops.push({ op: "update_round", roundId: finalRound.id, patch: { scoring_method: finalSlot.legacy, scoring_override_key: null, scoring_override_version: null } });
    if (callbackSlot && existingCallback) {
      ops.push({ op: "update_round", roundId: existingCallback.id, patch: { scoring_method: callbackSlot.legacy, scoring_override_key: callbackSlot.key, scoring_override_version: callbackSlot.version } });
    }
  }

  // The selection goes LAST: if a publish lands mid-way, the pin then resolves through the legacy values the round writes already
  // set (approved and consistent), never through a half-written selection.
  ops.push({ op: "set_division_selection", key: finalSlot.key, version: finalSlot.version });

  // Drop ops that change nothing so an already configured division plans zero writes.
  const roundById = new Map(rounds.map((r) => [r.id, r]));
  const effective = ops.filter((op) => {
    if (op.op === "set_division_selection") return op.key !== input.division.scoring_method_key || op.version !== input.division.scoring_method_version;
    if (op.op !== "update_round") return true;
    const round = roundById.get(op.roundId)!;
    return Object.entries(op.patch).some(([k, v]) => (round as unknown as Record<string, unknown>)[k] !== v);
  });
  return { ok: true, ops: effective };
}
