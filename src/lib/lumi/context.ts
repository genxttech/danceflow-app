/**
 * Bounds the dancer context sent to the model.
 *
 * A long-standing dancer can have far more syllabus progress and recap text than a request may carry. The dancer cannot edit that
 * data, so an oversize context must be trimmed here rather than refused. Nothing is changed while the context already fits; after
 * that, long text and long lists are shortened in steps until it does. Lists keep their first entries (callers order newest first).
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

export function serializeLumiContext(context: Record<string, unknown>, maxChars = LUMI_MAX_CONTEXT_CHARS) {
  let serialized = JSON.stringify(context);
  for (const step of STEPS) {
    if (serialized.length <= maxChars) return serialized;
    serialized = JSON.stringify(trim(context, step.text, step.list));
  }
  // Last resort for a pathological shape: a hard cut keeps the request inside its cap.
  return serialized.slice(0, maxChars);
}
