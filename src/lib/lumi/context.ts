/**
 * Bounds the dancer context sent to the model.
 *
 * A long-standing dancer can have far more syllabus progress and recap text than a request may carry. The dancer cannot edit that
 * data, so an oversize context must be trimmed here rather than refused. Nothing is changed while the context already fits; after
 * that, long text and long lists are shortened in steps until it does, the syllabus history (the only unbounded source) first so
 * recaps and goals keep their detail. Lists keep their first entries: goals and recaps arrive newest first, and syllabus progress
 * is ordered by `orderSyllabusProgress`. A shortened context says so, so the model does not treat it as the whole history.
 */

export const LUMI_MAX_CONTEXT_CHARS = 32_000;

const STEPS = [
  { text: 800, list: 60 },
  { text: 400, list: 30 },
  { text: 200, list: 15 },
  { text: 120, list: 8 },
  { text: 60, list: 3 },
];

function trim(value: unknown, text: number, list: number): unknown {
  if (typeof value === "string") return value.length > text ? `${value.slice(0, text)}…` : value;
  if (Array.isArray(value)) return value.slice(0, list).map((item) => trim(item, text, list));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, trim(item, text, list)]));
  }
  return value;
}

/** What the dancer is working on now comes first; finished and untouched figures are the first to be dropped. */
const STATUS_PRIORITY: Record<string, number> = { practicing: 0, introduced: 1, comfortable: 2, not_started: 3, mastered: 4 };

export function orderSyllabusProgress<T extends { status?: string | null; updated_at?: string | null }>(rows: T[]): T[] {
  const rank = (row: T) => STATUS_PRIORITY[row.status ?? ""] ?? 2;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
}

export function serializeLumiContext(context: Record<string, unknown>, maxChars = LUMI_MAX_CONTEXT_CHARS) {
  let serialized = JSON.stringify(context);
  if (serialized.length <= maxChars) return serialized;

  const shortened: Record<string, unknown> = { ...context, historyShortened: true };
  // The syllabus runs one step ahead of everything else: it is shortened first, but when the other sections are what is large,
  // they are shortened before current syllabus work is cut to its smallest size.
  for (let index = 0; index <= STEPS.length; index += 1) {
    const syllabusStep = STEPS[Math.min(index, STEPS.length - 1)];
    const otherStep = STEPS[index - 1];
    const candidate = otherStep ? (trim(shortened, otherStep.text, otherStep.list) as Record<string, unknown>) : { ...shortened };
    if ("visibleSyllabusProgress" in context) {
      candidate.visibleSyllabusProgress = trim(context.visibleSyllabusProgress, syllabusStep.text, syllabusStep.list);
    }
    serialized = JSON.stringify(candidate);
    if (serialized.length <= maxChars) return serialized;
  }
  // Last resort for a pathological shape: a hard cut keeps the request inside its cap.
  return serialized.slice(0, maxChars);
}
