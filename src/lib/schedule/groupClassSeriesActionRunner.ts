/**
 * GC-S1B B3: safe client-side runner for the reviewed B2 series server actions.
 *
 * Why it exists: a server action that rejects (network drop, unexpected server
 * exception) propagates through useActionState to the nearest error boundary,
 * which would unmount the form and lose both the entered definition and the
 * form-scoped client_request_id. A create whose confirmation never arrived may
 * well have committed, so losing the id could allow a duplicate series. The
 * runner therefore:
 *   - catches ordinary failures and returns a SAFE structured state (the form
 *     stays mounted, the request id and definition are untouched);
 *   - rethrows Next's redirect control-flow signal (a successful create or replay
 *     arrives as a rejected action promise carrying a redirect) so navigation
 *     still happens;
 *   - tags every result with the exact definition key it was submitted for, so a
 *     result can never be applied to a different (edited) definition;
 *   - releases a synchronous in-flight guard on every exit path.
 *
 * It never generates or changes a request id: the id is part of the submitted
 * FormData built from the form's single instance state.
 */

export type KeyedResult<T> = { key: string | null; state: T };

/** What the form dispatches: the exact payload plus the definition key it was built from. */
export type SeriesSubmission = { formData: FormData; key: string };

export type ClientFailureState = { status: "error"; code: "action_failed"; error: string };

export const PREVIEW_ACTION_FAILED: ClientFailureState = {
  status: "error",
  code: "action_failed",
  error: "We couldn't check the schedule just now. Nothing was changed — please try again.",
};

/**
 * Deliberately does not claim the create failed: the server may have committed.
 * Retrying on the same form is safe because the same request id is reused.
 */
export const CREATE_OUTCOME_UNCONFIRMED: ClientFailureState = {
  status: "error",
  code: "action_failed",
  error: "We couldn't confirm whether the series was created. Check your schedule, then try again — retrying is safe.",
};

export type InFlightGuard = {
  /** Returns true if the caller now owns the lock; false if another action is already in flight. */
  tryAcquire: () => boolean;
  release: () => void;
  isHeld: () => boolean;
};

/** Synchronous (same-tick) lock: React's pending flag is not guaranteed to flip before the next event. */
export function createInFlightGuard(): InFlightGuard {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
    isHeld() {
      return held;
    },
  };
}

export async function runKeyedAction<T>(params: {
  submission: SeriesSubmission;
  call: (formData: FormData) => Promise<T>;
  failure: ClientFailureState;
  guard: InFlightGuard;
  isRedirect: (error: unknown) => boolean;
  label: string;
}): Promise<KeyedResult<T | ClientFailureState>> {
  const { submission, call, failure, guard, isRedirect, label } = params;
  try {
    const state = await call(submission.formData);
    return { key: submission.key, state };
  } catch (error) {
    // A successful create/replay is delivered as a rejected promise carrying a
    // redirect: never convert it into an error state.
    if (isRedirect(error)) throw error;
    // Only a fixed label is logged: nothing from the thrown error reaches the UI.
    console.error(`GC-S1B series ${label} action did not complete.`);
    return { key: submission.key, state: failure };
  } finally {
    guard.release();
  }
}

/**
 * The dispatch protocol the form uses for both preview and create: acquire the
 * shared same-tick lock, then dispatch the submission built from the current
 * definition. Returns false (and dispatches nothing) when the action is not
 * currently allowed or another action is already in flight. The lock is released
 * by runKeyedAction's finally on every outcome, and here if the dispatch itself
 * throws synchronously, so it can never be left stuck.
 */
export function dispatchGuarded(params: {
  guard: InFlightGuard;
  allowed: boolean;
  buildSubmission: () => SeriesSubmission;
  dispatch: (submission: SeriesSubmission) => void;
}): boolean {
  const { guard, allowed, buildSubmission, dispatch } = params;
  if (!allowed || guard.isHeld() || !guard.tryAcquire()) return false;
  try {
    dispatch(buildSubmission());
    return true;
  } catch (error) {
    guard.release();
    throw error;
  }
}
