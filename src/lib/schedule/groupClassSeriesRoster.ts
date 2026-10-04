/**
 * GC-S1D-2: pure helpers for "This and following classes" roster management (enroll / remove ONE dancer).
 *
 * The authoritative rules (who may do it, which occurrences are targeted across the successor lineage, which are skipped,
 * atomic refusal on capacity / funding, idempotency, terminal-attendance preservation) live in the database RPCs
 * `preview_group_class_series_enrollment`, `enroll_group_class_series_from`, `preview_group_class_series_removal` and
 * `remove_group_class_series_from`. This module only parses their jsonb into a safe typed shape (never trusting a client
 * list or count), maps stable error codes to fixed copy, and builds the staff-facing wording. Database text never reaches
 * the UI.
 */

export type SeriesRosterKind = "enroll" | "remove";

export type SeriesRosterClassState =
  | "will_enroll"
  | "will_remove"
  | "already_enrolled"
  | "not_enrolled"
  | "skipped_cancelled"
  | "skipped_ended"
  | "skipped_terminal"
  | "blocked_capacity"
  | "blocked_funding_policy"
  | "blocked_membership_allowance"
  | "blocked_funding_invalid"
  | "blocked_incompatible"
  | "blocked_other";

const CLASS_STATES: ReadonlySet<string> = new Set([
  "will_enroll",
  "will_remove",
  "already_enrolled",
  "not_enrolled",
  "skipped_cancelled",
  "skipped_ended",
  "skipped_terminal",
  "blocked_capacity",
  "blocked_funding_policy",
  "blocked_membership_allowance",
  "blocked_funding_invalid",
  "blocked_incompatible",
  "blocked_other",
]);

export type SeriesRosterOutcome =
  | "ready"
  | "enrolled"
  | "removed"
  | "noop"
  | "blocked"
  | "no_eligible_targets"
  | "changed";

const OUTCOMES: ReadonlySet<string> = new Set(["ready", "enrolled", "removed", "noop", "blocked", "no_eligible_targets", "changed"]);

export type SeriesRosterClass = {
  appointmentId: string;
  occurrenceIndex: number;
  startsAt: string;
  state: SeriesRosterClassState;
};

export type SeriesRosterResult = {
  mode: "preview" | "apply";
  outcome: SeriesRosterOutcome;
  anchorIndex: number;
  /** Enrollments created (apply) -- zero for a preview or any refusal. */
  appliedCount: number;
  counts: Partial<Record<SeriesRosterClassState, number>>;
  classes: SeriesRosterClass[];
};

function toCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** Parses an RPC result for the given kind; null when it is not the expected shape. */
export function parseSeriesRosterResult(raw: unknown, kind: SeriesRosterKind): SeriesRosterResult | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;

  const mode = value.mode === "apply" ? "apply" : value.mode === "preview" ? "preview" : null;
  if (!mode) return null;
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) return null;
  const anchorIndex = toCount(value.anchor_index);
  if (anchorIndex === null) return null;
  const applied = toCount(kind === "enroll" ? value.enrolled_count : value.removed_count);
  if (applied === null) return null;
  if (!Array.isArray(value.classes)) return null;

  const classes: SeriesRosterClass[] = [];
  for (const entry of value.classes) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    const occurrenceIndex = toCount(row.occurrence_index);
    if (typeof row.appointment_id !== "string" || typeof row.starts_at !== "string" || occurrenceIndex === null) return null;
    const state = typeof row.state === "string" && CLASS_STATES.has(row.state) ? (row.state as SeriesRosterClassState) : "blocked_other";
    classes.push({ appointmentId: row.appointment_id, occurrenceIndex, startsAt: row.starts_at, state });
  }

  // Counts are derived from the classes, never trusted from a separate field.
  const counts: Partial<Record<SeriesRosterClassState, number>> = {};
  for (const item of classes) counts[item.state] = (counts[item.state] ?? 0) + 1;

  return { mode, outcome: value.outcome as SeriesRosterOutcome, anchorIndex, appliedCount: applied, counts, classes };
}

export type SeriesRosterFailure =
  | "not_authorized"
  | "not_found"
  | "not_a_series"
  | "client_not_found"
  | "invalid_funding"
  | "unknown";

export function classifySeriesRosterError(error: { message?: string | null } | null | undefined): SeriesRosterFailure {
  const message = String(error?.message ?? "");
  if (/GCSD2_UNAUTHORIZED/.test(message)) return "not_authorized";
  if (/GCSD2_NOT_FOUND/.test(message)) return "not_found";
  if (/GCSD2_NOT_A_SERIES_OCCURRENCE/.test(message)) return "not_a_series";
  if (/GCSD2_CLIENT_NOT_FOUND/.test(message)) return "client_not_found";
  if (/GCSD2_INVALID_FUNDING/.test(message)) return "invalid_funding";
  return "unknown";
}

const FAILURE_MESSAGES: Record<SeriesRosterFailure, string> = {
  not_authorized: "Only owners, admins and front desk can change a whole series. You can still add or remove a dancer for a single class.",
  not_found: "That class could not be found. Reload the page and try again.",
  not_a_series: "This class is not part of a series.",
  client_not_found: "That dancer could not be found. Choose the dancer again.",
  invalid_funding: "Choose how to bill this enrollment before continuing.",
  unknown: "Something went wrong. Nothing was changed. Please try again.",
};

export function seriesRosterFailureMessage(failure: SeriesRosterFailure): string {
  return FAILURE_MESSAGES[failure];
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export const SERIES_ROSTER_STATE_LABELS: Record<SeriesRosterClassState, string> = {
  will_enroll: "Will be enrolled",
  will_remove: "Will be removed",
  already_enrolled: "Already enrolled",
  not_enrolled: "Not enrolled",
  skipped_cancelled: "Cancelled class (skipped)",
  skipped_ended: "Class has ended (skipped)",
  skipped_terminal: "Attendance recorded (skipped)",
  blocked_capacity: "Class is full",
  blocked_funding_policy: "Class does not accept this funding type",
  blocked_membership_allowance: "No membership allowance left",
  blocked_funding_invalid: "Funding source can't be used here",
  blocked_incompatible: "Already enrolled with different funding",
  blocked_other: "Could not be checked",
};

/**
 * The label for one class in the full list. When the operation as a whole is refused (blocked / stale), a class that passed its
 * own check is NOT "will be enrolled": nothing is changed, so it reads as able to take the dancer, not as pending.
 */
export function seriesRosterClassStateLabel(state: SeriesRosterClassState, outcome: SeriesRosterOutcome): string {
  const refused = outcome === "blocked" || outcome === "changed";
  if (refused && state === "will_enroll") return "Can take the dancer (not enrolled while another class is blocked)";
  if (refused && state === "will_remove") return "Can be removed (nothing changed)";
  return SERIES_ROSTER_STATE_LABELS[state];
}

export function isBlockedState(state: SeriesRosterClassState): boolean {
  return state.startsWith("blocked_");
}

export function isSkippedState(state: SeriesRosterClassState): boolean {
  return state.startsWith("skipped_");
}

export function seriesRosterBlockers(result: SeriesRosterResult): SeriesRosterClass[] {
  return result.classes.filter((item) => isBlockedState(item.state));
}

export function seriesRosterSkippedCount(result: SeriesRosterResult): number {
  return result.classes.filter((item) => isSkippedState(item.state)).length;
}

/** "Tue, Nov 10 · 7:00 PM" in the studio time zone. */
export function seriesRosterClassLabel(startsAtIso: string, timeZone: string): string {
  const date = new Date(startsAtIso);
  if (!Number.isFinite(date.getTime())) return "Class";
  try {
    const day = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", month: "short", day: "numeric" }).format(date);
    const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
    return `${day} · ${time}`;
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

function skippedSentence(result: SeriesRosterResult): string | null {
  const parts: string[] = [];
  const cancelled = result.counts.skipped_cancelled ?? 0;
  const ended = result.counts.skipped_ended ?? 0;
  if (cancelled > 0) parts.push(`${plural(cancelled, "cancelled class", "cancelled classes")}`);
  if (ended > 0) parts.push(`${plural(ended, "class that has ended", "classes that have ended")}`);
  if (parts.length === 0) return null;
  return `${parts.join(" and ")} will be skipped.`;
}

export type SeriesRosterTone = "ready" | "info" | "blocked";

export type SeriesRosterSummary = {
  tone: SeriesRosterTone;
  headline: string;
  details: string[];
  canApply: boolean;
};

/** The compact, plain-language preview summary for the current result. `name` is the dancer's display name. */
export function seriesRosterSummary(result: SeriesRosterResult, kind: SeriesRosterKind, name: string): SeriesRosterSummary {
  const skipped = skippedSentence(result);
  const terminal = result.counts.skipped_terminal ?? 0;
  const details: string[] = [];

  if (result.outcome === "changed") {
    return { tone: "blocked", headline: "The classes changed since you reviewed them.", details: ["Review again before continuing."], canApply: false };
  }

  if (kind === "enroll") {
    const will = result.counts.will_enroll ?? 0;
    const already = result.counts.already_enrolled ?? 0;

    if (result.outcome === "blocked") {
      const blockersList = seriesRosterBlockers(result);
      const blockers = blockersList.length;
      const anchorFull = blockersList.some((c) => c.occurrenceIndex === result.anchorIndex && c.state === "blocked_capacity");
      const incompatible = (result.counts.blocked_incompatible ?? 0) > 0;
      const blockedDetails = [
        `${plural(blockers, "class needs", "classes need")} attention. Enrollment never goes through for only some of the classes, so nothing will be enrolled until this is fixed.`,
      ];
      if (anchorFull) {
        blockedDetails.unshift("This class is full, and the enrollment starts here, so nothing can be enrolled from this class onward.");
        blockedDetails.push("Raise Maximum students in Edit class, or open a later class to start from there.");
      } else if (incompatible) {
        blockedDetails.push("Some classes already have this dancer enrolled with different funding. Correct or remove those enrollments, or choose the same funding.");
      } else {
        blockedDetails.push("Fix the issue below, choose different funding, or enroll in This class only.");
      }
      return {
        tone: "blocked",
        headline: `${name} can't be enrolled from this class onward yet.`,
        details: blockedDetails,
        canApply: false,
      };
    }
    if (result.outcome === "no_eligible_targets") {
      return { tone: "info", headline: "No following class can take an enrollment.", details: ["They are cancelled or have ended."], canApply: false };
    }
    if (result.outcome === "noop") {
      return {
        tone: "info",
        headline: `${name} is already enrolled in every eligible class from here.`,
        details: ["There is nothing to change."],
        canApply: false,
      };
    }

    if (will > 0) details.push(`${plural(will, "class", "classes")} will be added, starting with this one.`);
    if (already > 0) details.push(`${plural(already, "class", "classes")} already enrolled and left as they are.`);
    if (skipped) details.push(skipped);
    if (terminal > 0) details.push(`${plural(terminal, "class", "classes")} where attendance is already recorded will be left alone.`);
    return {
      tone: "ready",
      headline: `Enroll ${name} in ${plural(will, "class", "classes")}`,
      details,
      canApply: result.outcome === "ready",
    };
  }

  const will = result.counts.will_remove ?? 0;
  const notEnrolled = result.counts.not_enrolled ?? 0;

  if (result.outcome === "blocked") {
    return {
      tone: "blocked",
      headline: `${name} could not be removed from the following classes.`,
      details: ["Nothing was changed. Please try again."],
      canApply: false,
    };
  }
  if (result.outcome === "noop" || will === 0) {
    const kept = terminal > 0 ? ` ${plural(terminal, "class has", "classes have")} recorded attendance and ${terminal === 1 ? "stays" : "stay"} as is.` : "";
    return {
      tone: "info",
      headline: `${name} is not enrolled in any following class that can be changed.`,
      details: [kept.trim(), skipped ?? ""].filter(Boolean),
      canApply: false,
    };
  }

  details.push("No credit is used or returned, and each removal frees a seat.");
  if (terminal > 0) details.push(`${plural(terminal, "class", "classes")} with recorded attendance will keep ${name} enrolled.`);
  if (notEnrolled > 0) details.push(`${plural(notEnrolled, "class", "classes")} where ${name} is not enrolled will be skipped.`);
  if (skipped) details.push(skipped);
  return {
    tone: "ready",
    headline: `Remove ${name} from ${plural(will, "class", "classes")}`,
    details,
    canApply: result.outcome === "ready",
  };
}

/** The success line after a series enrollment / removal was applied. */
export function seriesRosterSuccessMessage(result: SeriesRosterResult, kind: SeriesRosterKind, name: string): string {
  if (kind === "enroll") {
    const added = result.appliedCount;
    const already = result.counts.already_enrolled ?? 0;
    const skipped = seriesRosterSkippedCount(result);
    const extras: string[] = [];
    if (already > 0) extras.push(`${already} already enrolled`);
    if (skipped > 0) extras.push(`${skipped} skipped`);
    return `${name} was added to ${plural(added, "class", "classes")}${extras.length ? ` (${extras.join(", ")})` : ""}.`;
  }
  const removed = result.appliedCount;
  const kept = result.counts.skipped_terminal ?? 0;
  return `${name} was removed from ${plural(removed, "class", "classes")}${kept > 0 ? `; ${plural(kept, "class", "classes")} with recorded attendance ${kept === 1 ? "was" : "were"} kept` : ""}.`;
}

/** A refusal reason for one blocked class, e.g. "Class is full". */
export function seriesRosterClassReason(state: SeriesRosterClassState): string {
  return SERIES_ROSTER_STATE_LABELS[state];
}

export type SeriesRosterBilling = "package_credit" | "membership" | "pay_as_you_go" | "free_comped";

const BILLING_TYPES: ReadonlySet<string> = new Set(["package_credit", "membership", "pay_as_you_go", "free_comped"]);

export function isSeriesRosterBilling(value: string | null | undefined): value is SeriesRosterBilling {
  return !!value && BILLING_TYPES.has(value);
}

export const SERIES_ROSTER_SUCCESS_CODES = {
  enroll: "series_roster_enrolled",
  remove: "series_roster_removed",
} as const;

/** The class page URL to land on after a series roster change: the code plus numeric-only counts (never free text). */
export function seriesRosterDoneUrl(basePath: string, kind: SeriesRosterKind, result: SeriesRosterResult): string {
  const left = Math.max(0, result.classes.length - result.appliedCount);
  return `${basePath}?success=${SERIES_ROSTER_SUCCESS_CODES[kind]}&count=${result.appliedCount}&left=${left}`;
}

/** Banner copy for a series roster success code, with the counts taken from numeric params only. */
export function seriesRosterBannerMessage(code: string, count: number | null, left: number | null): string | null {
  const kind = code === SERIES_ROSTER_SUCCESS_CODES.enroll ? "enroll" : code === SERIES_ROSTER_SUCCESS_CODES.remove ? "remove" : null;
  if (!kind) return null;
  const n = count !== null && count >= 0 ? count : null;
  const head =
    kind === "enroll"
      ? n === null ? "Dancer added to the following classes." : `Dancer added to ${plural(n, "class", "classes")}.`
      : n === null ? "Dancer removed from the following classes." : `Dancer removed from ${plural(n, "class", "classes")}.`;
  if (left === null || left <= 0) return head;
  return `${head} ${plural(left, "other class was", "other classes were")} left as ${left === 1 ? "it was" : "they were"}.`;
}

export type SeriesRosterActionOutcome =
  | { status: "ok"; result: SeriesRosterResult }
  | { status: "error"; message: string };

export type SeriesApplyStep =
  | { type: "done"; url: string }
  | { type: "show"; result: SeriesRosterResult }
  | { type: "error"; message: string };

/**
 * What the UI does with an apply outcome: land on the class page with the success banner when the change was made;
 * otherwise show the fresh result (changed / blocked / nothing to do) -- nothing was changed -- or the fixed error copy.
 */
export function interpretSeriesApply(outcome: SeriesRosterActionOutcome, kind: SeriesRosterKind, basePath: string): SeriesApplyStep {
  if (outcome.status !== "ok") return { type: "error", message: outcome.message };
  const done = kind === "enroll" ? outcome.result.outcome === "enrolled" : outcome.result.outcome === "removed";
  if (done) return { type: "done", url: seriesRosterDoneUrl(basePath, kind, outcome.result) };
  return { type: "show", result: outcome.result };
}

/** The classes the previewed operation would change; the apply is refused as stale if the database count differs. */
export function seriesRosterExpectedCount(result: SeriesRosterResult, kind: SeriesRosterKind): number {
  return (kind === "enroll" ? result.counts.will_enroll : result.counts.will_remove) ?? 0;
}

/** "Enroll in 4 classes" / "Remove from 1 class". */
export function seriesRosterApplyLabel(kind: SeriesRosterKind, count: number): string {
  const noun = count === 1 ? "class" : "classes";
  return kind === "enroll" ? `Enroll in ${count} ${noun}` : `Remove from ${count} ${noun}`;
}

export type SeriesAddPanelState = {
  /** Render the Add dancer control (otherwise only the full-class message). */
  showAddControl: boolean;
  /** Fixed notice above the control when THIS class is full. */
  fullNotice: string | null;
  /** "This class" cannot succeed (class full): its submit is disabled and explained. */
  singleDisabled: boolean;
  singleNote: string | null;
};

/**
 * What the Add dancer control shows for a class that may be full. A full class never offers a path that looks capable of
 * overbooking: "This class" is disabled and explained. Broad staff on a series occurrence still reach "This and following
 * classes" from the full anchor; its preview then names the full anchor as blocking (nothing is enrolled, the anchor is never
 * skipped or shifted).
 */
export function seriesAddPanelState(input: { full: boolean; seriesScope: boolean; isBroadStaff: boolean }): SeriesAddPanelState {
  if (!input.full) return { showAddControl: true, fullNotice: null, singleDisabled: false, singleNote: null };
  if (!input.seriesScope) {
    return {
      showAddControl: false,
      fullNotice: `This class is full. ${input.isBroadStaff ? "Raise Maximum students in Edit class to add more dancers." : "Ask front desk to raise Maximum students to add more dancers."}`,
      singleDisabled: true,
      singleNote: null,
    };
  }
  return {
    showAddControl: true,
    fullNotice:
      "This class is full, so no dancer can be added to it. To enroll from this class onward, choose This and following classes: the review shows this full class as blocking, and nothing is enrolled unless every class can take the dancer.",
    singleDisabled: true,
    singleNote: "This class is full and can't take another dancer. Raise Maximum students in Edit class, or choose This and following classes to review the series.",
  };
}
