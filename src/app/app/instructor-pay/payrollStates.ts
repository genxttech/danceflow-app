import { getStudioTimeZone } from "@/lib/booking/selfServiceAvailability";

/**
 * Plain-language state copy for Payroll Prep: what is locked and why, what the
 * generation cap means, and the next action for empty states. Pure functions so
 * the wording and the locked/unlocked decisions are testable.
 */

export const EARNINGS_CAP_LABEL = 500;

/** Why an earning has no edit controls, or null when it is still editable. */
export function earningLockNote(earning: { status: string; payroll_batch_id?: string | null }) {
  if (earning.status === "paid") return "Paid and locked. Its payroll record can still be viewed and exported.";
  if (earning.status === "void") return "Voided. It is kept for history and cannot be changed.";
  if (earning.payroll_batch_id) return "Locked in a payroll batch. Open the batch to review or export it.";
  return null;
}

/** Whether per-earning edit actions (override, approve, void) are available. */
export function earningIsEditable(earning: { status: string; payroll_batch_id?: string | null }) {
  return earningLockNote(earning) === null;
}

/** Why a pay period has no assign/create-batch controls, or null while open. */
export function periodLockNote(status: string) {
  if (status === "open" || status === "in_review") return null;
  if (status === "paid") return "Paid and closed. Its batches and exports remain available to view.";
  if (status === "void") return "Voided. It is kept for history.";
  return "Closed. It can no longer receive earnings; its batches and exports remain available to view.";
}

export type GenerationResult = {
  scanned: number;
  staged: number;
  skipped: number;
  attendanceFailed: number;
  truncated: boolean;
};

/** Result banner for earning generation, honest about the 500-item cap. */
export function generationMessage(result: GenerationResult) {
  const counts = `Reviewed ${result.scanned}, staged ${result.staged}, skipped ${result.skipped}.`;
  const notes: string[] = [];
  if (result.truncated) {
    notes.push(
      `Only the most recent ${EARNINGS_CAP_LABEL} eligible lessons and classes were reviewed, and more eligible items remain. Narrow the date range and generate again to cover them.`,
    );
  }
  if (result.attendanceFailed > 0) {
    notes.push(
      `${result.attendanceFailed} class${result.attendanceFailed === 1 ? "" : "es"} could not be staged because attendance could not be read. Try again.`,
    );
  }
  if (notes.length === 0) return `Earnings review complete. ${counts}`;
  return `Earnings review incomplete. ${counts} ${notes.join(" ")}`;
}

export const PAY_PERIOD_EMPTY = {
  title: "No pay periods yet",
  description: "Create a pay period to organize approved earnings into a payroll batch.",
  actionLabel: "Create a pay period",
  actionHref: "#create-pay-period",
};

export const EARNINGS_EMPTY = {
  noInstructors: {
    title: "Add an instructor to get started",
    description: "Earnings are created for instructors on lessons and classes. Add an instructor, then set their compensation.",
    actionLabel: "Add instructor",
    actionHref: "/app/instructors",
  },
  noRules: {
    title: "Set a compensation rule",
    description: "DanceFlow creates earnings only for instructors with a compensation rule.",
    actionLabel: "Set compensation",
  },
  noEligible: {
    title: "No earnings in this view",
    description: "Generate earnings after lessons or classes are completed, or change the filters.",
    actionLabel: "Generate earnings",
    actionHref: "#generate-earnings",
  },
};

export function batchesEmptyMessage(periodStatus: string) {
  return periodStatus === "open" || periodStatus === "in_review"
    ? "No payroll batches yet. Assign eligible earnings, then create a batch."
    : "No payroll batches were created for this period.";
}

/**
 * Display-only calendar date of a stored timestamp (for example paid_at) in the
 * STUDIO time zone, never the server, process or browser zone. The stored value
 * is not changed. A date-only value is already a business date and is shown as is.
 */
export function formatStudioDate(value: string | null | undefined, timeZone: string | null | undefined) {
  if (!value) return "—";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const instant = new Date(dateOnly ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(instant.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: dateOnly ? "UTC" : getStudioTimeZone(timeZone),
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(instant);
}
