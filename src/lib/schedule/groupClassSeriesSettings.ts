/**
 * GC-S1D-3: pure helpers for "This and following classes" enrollment settings.
 *
 * The authoritative rules (who may do it, which occurrences are targeted across the successor lineage, which are skipped,
 * atomic refusal, stale-preview refusal) live in the database RPCs `preview_group_class_series_enrollment_settings` and
 * `apply_group_class_series_enrollment_settings`. This module only parses their jsonb into a safe typed shape (never trusting
 * a client list or count), maps stable error codes to fixed copy, and builds the staff-facing wording. Database text never
 * reaches the UI. The managed settings are exactly the single-class editor's: the discovery switch, the self-enrollment switch,
 * and whether package and membership funding are accepted.
 */

export type SeriesSettingsClassState =
  | "will_change"
  | "matches"
  | "skipped_cancelled"
  | "skipped_ended"
  | "blocked_requires_funding"
  | "blocked_other";

const CLASS_STATES: ReadonlySet<string> = new Set([
  "will_change",
  "matches",
  "skipped_cancelled",
  "skipped_ended",
  "blocked_requires_funding",
  "blocked_other",
]);

export type SeriesSettingsOutcome = "ready" | "updated" | "noop" | "blocked" | "no_eligible_targets" | "changed";

const OUTCOMES: ReadonlySet<string> = new Set(["ready", "updated", "noop", "blocked", "no_eligible_targets", "changed"]);

export type SeriesSettingsClass = {
  appointmentId: string;
  occurrenceIndex: number;
  startsAt: string;
  state: SeriesSettingsClassState;
};

export type SeriesSettingsResult = {
  mode: "preview" | "apply";
  outcome: SeriesSettingsOutcome;
  anchorIndex: number;
  /** Classes updated (apply); zero for a preview or any refusal. */
  updatedCount: number;
  counts: Partial<Record<SeriesSettingsClassState, number>>;
  classes: SeriesSettingsClass[];
};

function toCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parses an RPC result; null when it is not the expected shape. Counts are derived from the classes. */
export function parseSeriesSettingsResult(raw: unknown): SeriesSettingsResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const mode = value.mode === "apply" ? "apply" : value.mode === "preview" ? "preview" : null;
  if (!mode) return null;
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return null;
  const anchorIndex = toCount(value.anchor_index);
  const updated = toCount(value.updated_count);
  if (anchorIndex === null || updated === null) return null;
  if (!Array.isArray(value.classes)) return null;

  const classes: SeriesSettingsClass[] = [];
  for (const entry of value.classes) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const occurrenceIndex = toCount(row.occurrence_index);
    if (typeof row.appointment_id !== "string" || typeof row.starts_at !== "string" || occurrenceIndex === null) return null;
    const state = typeof row.state === "string" && CLASS_STATES.has(row.state) ? (row.state as SeriesSettingsClassState) : "blocked_other";
    classes.push({ appointmentId: row.appointment_id, occurrenceIndex, startsAt: row.starts_at, state });
  }

  const counts: Partial<Record<SeriesSettingsClassState, number>> = {};
  for (const item of classes) counts[item.state] = (counts[item.state] ?? 0) + 1;

  return { mode, outcome: value.outcome as SeriesSettingsOutcome, anchorIndex, updatedCount: updated, counts, classes };
}

export type SeriesSettingsFailure = "not_authorized" | "not_found" | "not_a_series" | "unknown";

export function classifySeriesSettingsError(error: { message?: string | null } | null | undefined): SeriesSettingsFailure {
  const message = String(error?.message ?? "");
  if (/GCSD3_UNAUTHORIZED/.test(message)) return "not_authorized";
  if (/GCSD3_NOT_FOUND/.test(message)) return "not_found";
  if (/GCSD3_NOT_A_SERIES_OCCURRENCE/.test(message)) return "not_a_series";
  return "unknown";
}

const FAILURE_MESSAGES: Record<SeriesSettingsFailure, string> = {
  not_authorized: "Only owners, admins and front desk can change the enrollment settings of a whole series. You can still change them for a single class.",
  not_found: "That class could not be found. Reload the page and try again.",
  not_a_series: "This class is not part of a series.",
  unknown: "Something went wrong. Nothing was changed. Please try again.",
};

export function seriesSettingsFailureMessage(failure: SeriesSettingsFailure): string {
  return FAILURE_MESSAGES[failure];
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export const SERIES_SETTINGS_STATE_LABELS: Record<SeriesSettingsClassState, string> = {
  will_change: "Will be updated",
  matches: "Already matches",
  skipped_cancelled: "Cancelled class (skipped)",
  skipped_ended: "Class has ended (skipped)",
  blocked_requires_funding: "Needs an accepted funding source",
  blocked_other: "Could not be checked",
};

/** A class that passed its own check is not "will be updated" when the operation as a whole is refused. */
export function seriesSettingsClassStateLabel(state: SeriesSettingsClassState, outcome: SeriesSettingsOutcome): string {
  if ((outcome === "blocked" || outcome === "changed") && state === "will_change") {
    return "Can take these settings (not updated while another class is blocked)";
  }
  return SERIES_SETTINGS_STATE_LABELS[state];
}

export function isBlockedSettingsState(state: SeriesSettingsClassState): boolean {
  return state.startsWith("blocked_");
}

export function isSkippedSettingsState(state: SeriesSettingsClassState): boolean {
  return state.startsWith("skipped_");
}

export function seriesSettingsBlockers(result: SeriesSettingsResult): SeriesSettingsClass[] {
  return result.classes.filter((item) => isBlockedSettingsState(item.state));
}

function skippedSentence(result: SeriesSettingsResult): string | null {
  const parts: string[] = [];
  const cancelled = result.counts.skipped_cancelled ?? 0;
  const ended = result.counts.skipped_ended ?? 0;
  if (cancelled > 0) parts.push(plural(cancelled, "cancelled class", "cancelled classes"));
  if (ended > 0) parts.push(plural(ended, "class that has ended", "classes that have ended"));
  return parts.length === 0 ? null : `${parts.join(" and ")} will be skipped.`;
}

export type SeriesSettingsSummary = {
  tone: "ready" | "info" | "blocked";
  headline: string;
  details: string[];
  canApply: boolean;
};

/** The compact preview summary: how many classes will be updated and how many already match. */
export function seriesSettingsSummary(result: SeriesSettingsResult): SeriesSettingsSummary {
  const change = result.counts.will_change ?? 0;
  const same = result.counts.matches ?? 0;
  const skipped = skippedSentence(result);

  if (result.outcome === "changed") {
    return { tone: "blocked", headline: "The classes changed since you reviewed them.", details: ["Review again before continuing."], canApply: false };
  }
  if (result.outcome === "blocked") {
    const blockers = seriesSettingsBlockers(result).length;
    return {
      tone: "blocked",
      headline: "These settings can't be applied to the following classes yet.",
      details: [
        `${plural(blockers, "class needs", "classes need")} attention. The update never goes through for only some of the classes, so nothing will be changed until this is fixed.`,
        "Choose at least one accepted funding source, or update This class only.",
      ],
      canApply: false,
    };
  }
  if (result.outcome === "no_eligible_targets") {
    return { tone: "info", headline: "No following class can take these settings.", details: ["They are cancelled or have ended."], canApply: false };
  }
  if (result.outcome === "noop") {
    return {
      tone: "info",
      headline: `All ${plural(same, "class", "classes")} from here already match these settings.`,
      details: ["There is nothing to change."].concat(skipped ? [skipped] : []),
      canApply: false,
    };
  }

  const details = [`${plural(change, "class", "classes")} will be updated, starting with this one. A later class with different settings will be changed to match.`];
  if (same > 0) details.push(`${plural(same, "class already matches", "classes already match")} and ${same === 1 ? "is" : "are"} left as ${same === 1 ? "it is" : "they are"}.`);
  if (skipped) details.push(skipped);
  details.push("Earlier classes are not changed.");
  return { tone: "ready", headline: `Update ${plural(change, "class", "classes")}`, details, canApply: result.outcome === "ready" };
}

export const SERIES_SETTINGS_SUCCESS_CODE = "series_settings_updated";

/** The page to land on after the update: the success code plus numeric-only counts (never free text). */
export function seriesSettingsDoneUrl(basePath: string, result: SeriesSettingsResult): string {
  const left = Math.max(0, result.classes.length - result.updatedCount);
  return `${basePath}?success=${SERIES_SETTINGS_SUCCESS_CODE}&count=${result.updatedCount}&left=${left}`;
}

/** Banner copy for the series settings success code, with counts taken from numeric params only. */
export function seriesSettingsBannerMessage(code: string, count: number | null, left: number | null): string | null {
  if (code !== SERIES_SETTINGS_SUCCESS_CODE) return null;
  const head = count !== null && count >= 0 ? `Enrollment settings updated for ${plural(count, "class", "classes")}.` : "Enrollment settings updated for the following classes.";
  if (left === null || left <= 0) return head;
  return `${head} ${plural(left, "other class was", "other classes were")} left as ${left === 1 ? "it was" : "they were"}.`;
}

export type SeriesSettingsActionOutcome =
  | { status: "ok"; result: SeriesSettingsResult }
  | { status: "error"; message: string };

export type SeriesSettingsApplyStep =
  | { type: "done"; url: string }
  | { type: "show"; result: SeriesSettingsResult }
  | { type: "error"; message: string };

/** What the UI does with an apply outcome: land on the edit page with the success banner, or show the fresh result / fixed error. */
export function interpretSeriesSettingsApply(outcome: SeriesSettingsActionOutcome, basePath: string): SeriesSettingsApplyStep {
  if (outcome.status !== "ok") return { type: "error", message: outcome.message };
  if (outcome.result.outcome === "updated") return { type: "done", url: seriesSettingsDoneUrl(basePath, outcome.result) };
  return { type: "show", result: outcome.result };
}

/** The classes the previewed operation would update; the apply is refused as stale if the database count differs. */
export function seriesSettingsExpectedCount(result: SeriesSettingsResult): number {
  return result.counts.will_change ?? 0;
}

export function seriesSettingsApplyLabel(count: number): string {
  return `Update ${count} ${count === 1 ? "class" : "classes"}`;
}

/**
 * What the settings form shows for the scope choice. The series scope exists only for broad staff on an eligible series
 * occurrence; everyone else sees the single-class editor exactly as before. This class is the default.
 */
export function seriesSettingsFooterState(input: { seriesEnabled: boolean; scope: "single" | "series" }): {
  showScopeChoice: boolean;
  effectiveScope: "single" | "series";
} {
  return { showScopeChoice: input.seriesEnabled, effectiveScope: input.seriesEnabled ? input.scope : "single" };
}
