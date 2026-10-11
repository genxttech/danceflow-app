/**
 * 10C.5: the in-progress setup survives Back, Continue and a page refresh in this browser tab only
 * (sessionStorage). It is a convenience for an unsent draft, never a data model: nothing here is read by
 * the server, the answers are re-derived and re-validated on submit, and the stored copy is cleared once
 * the competition draft is created. Every access is guarded because storage can be unavailable.
 */

export type StoredSetup = { answers: unknown; step: string; requestKey: string };

const PREFIX = "danceflow.competition-setup.v3:";
/** Answers saved by earlier 10C.5 candidates (different shapes). Only this event's legacy keys are removed. */
const LEGACY_PREFIXES = ["danceflow.competition-setup.v1:", "danceflow.competition-setup.v2:"];

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadStoredSetup(eventId: string): StoredSetup | null {
  try {
    for (const prefix of LEGACY_PREFIXES) storage()?.removeItem(prefix + eventId);
    const raw = storage()?.getItem(PREFIX + eventId);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredSetup>;
    if (typeof value.step !== "string" || typeof value.requestKey !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(value.requestKey)) return null;
    return { answers: value.answers, step: value.step, requestKey: value.requestKey };
  } catch {
    return null;
  }
}

export function saveStoredSetup(eventId: string, value: StoredSetup) {
  try {
    storage()?.setItem(PREFIX + eventId, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the wizard still works, it just will not survive a refresh.
  }
}

export function clearStoredSetup(eventId: string) {
  try {
    storage()?.removeItem(PREFIX + eventId);
  } catch {
    // Nothing to clear.
  }
}
