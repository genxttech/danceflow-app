import { useCallback, useEffect, useRef, useState } from "react";
import { newIdempotencyKey } from "@/lib/features";
import { StaffApiError, staffErrorKind, type StaffErrorKind } from "@/lib/staffApi";

/*
  Mutation framework for the Business app's writes (Business expansion plan, Phase 0, P0-3). Used by every Phase 1A screen:

    const m = useStaffMutation<Input, Result>({ run: (input, key) => api.addNote(studioId, clientId, input, key), enabled: isStaffFeatureEnabled("clientNotes") });
    m.submit(input);            // one user action = one Idempotency-Key, kept for every retry of that action
    m.state                      // idle | pending | success | failed

  RULES
  - One action at a time (in-flight guard): a second submit while one is running is ignored, so a double tap can never send two writes.
  - The Idempotency-Key is made when the person acts and reused by retry() with the SAME input, so a retry can never apply twice (server: Staff_API_Contract.md
    "Write helpers"). A new submit (different input, or after success/reset) gets a new key.
  - Optimistic update: optimistic.apply(input) runs before the request; optimistic.rollback(input) runs when the server DEFINITELY did not apply the write.
    When the outcome is UNKNOWN (no response, timeout, a body that is not the contract's JSON) the optimistic value stays, the state is failed + unconfirmed, and
    the person chooses retry() (same key, safe) or discard() (rolls back). Nothing is silently rolled back while the server may have applied it.
  - Timeout (default 15 s): the request is abandoned from the screen's point of view (unconfirmed); a late answer from an abandoned attempt is ignored.
  - Never resent on its own. The client (staffApi.ts) already waits out one short 429 for reads only; writes are only ever retried by the person.
  - Behind a feature flag: enabled=false makes submit() a no-op that reports "disabled" (the screen should not render the control at all).
*/

export const MUTATION_TIMEOUT_MS = 15_000;

export type MutationFailureKind = StaffErrorKind | "offline" | "timeout";

export type MutationFailure = {
  kind: MutationFailureKind;
  error: unknown;
  /** The server may have applied the write (no answer, timeout, unreadable answer): retry() with the same key is safe, discard() rolls back. */
  unconfirmed: boolean;
  /** retry() is offered (unconfirmed outcomes, a short rate limit, an outage that committed nothing). */
  retryable: boolean;
  /** Seconds the server asked us to wait (429). */
  retryAfterSeconds?: number;
  /** 409 with a slice code: the raw code and the server's current state, for reconciling. */
  conflict?: { serverCode: string | null; current: unknown };
};

export type MutationState<R> =
  | { status: "idle" }
  | { status: "pending"; attempt: number }
  | { status: "success"; result: R }
  | ({ status: "failed" } & MutationFailure);

export type SubmitOutcome = "started" | "busy" | "disabled";

export type MutationOptions<I, R> = {
  run: (input: I, idempotencyKey: string) => Promise<R>;
  enabled?: boolean;
  optimistic?: { apply: (input: I) => void; rollback: (input: I) => void };
  onSuccess?: (result: R, input: I) => void;
  /** A 409 the server answered with its current state; the screen replaces its local copy with `current`. */
  onConflict?: (conflict: { serverCode: string | null; current: unknown }, input: I) => void;
  timeoutMs?: number;
  /** Test seam. */
  makeKey?: () => string;
};

export function classifyFailure(error: unknown): MutationFailure {
  if (error instanceof TimeoutError) return { kind: "timeout", error, unconfirmed: true, retryable: true };
  if (!(error instanceof StaffApiError)) return { kind: "unavailable", error, unconfirmed: true, retryable: true };

  const kind = staffErrorKind(error);
  if (error.code === "network_error") return { kind: "offline", error, unconfirmed: true, retryable: true };
  if (error.code === "unexpected_response") return { kind: "unavailable", error, unconfirmed: true, retryable: true };

  switch (kind) {
    case "rate_limited":
      return { kind, error, unconfirmed: false, retryable: true, retryAfterSeconds: error.retryAfterSeconds };
    case "unavailable": // 503 service_unavailable: the server committed nothing
      return { kind, error, unconfirmed: false, retryable: true };
    case "conflict":
      return { kind, error, unconfirmed: false, retryable: false, conflict: { serverCode: error.extra?.serverCode ?? null, current: error.extra?.current } };
    default:
      return { kind, error, unconfirmed: false, retryable: false };
  }
}

class TimeoutError extends Error {
  constructor() {
    super("The request timed out.");
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function useStaffMutation<I, R>(options: MutationOptions<I, R>) {
  const [state, setState] = useState<MutationState<R>>({ status: "idle" });
  const optionsRef = useRef(options);
  // updated after every render so callbacks always see the latest options (a ref must not be written during render)
  useEffect(() => {
    optionsRef.current = options;
  });

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const inFlight = useRef(false);
  const attemptId = useRef(0);
  const action = useRef<{ input: I; key: string; applied: boolean } | null>(null);

  const attempt = useCallback(async (input: I, key: string) => {
    const opts = optionsRef.current;
    const id = ++attemptId.current;
    inFlight.current = true;
    if (mounted.current) setState({ status: "pending", attempt: id });
    try {
      const result = await withTimeout(opts.run(input, key), opts.timeoutMs ?? MUTATION_TIMEOUT_MS);
      if (id !== attemptId.current) return; // abandoned (timed out, then retried or discarded): the newer attempt decides
      inFlight.current = false;
      action.current = null;
      if (mounted.current) setState({ status: "success", result });
      opts.onSuccess?.(result, input);
    } catch (error) {
      if (id !== attemptId.current) return;
      inFlight.current = false;
      const failure = classifyFailure(error);
      if (!failure.unconfirmed && action.current?.applied) {
        opts.optimistic?.rollback(input);
        action.current.applied = false;
      }
      if (failure.conflict) opts.onConflict?.(failure.conflict, input);
      if (mounted.current) setState({ status: "failed", ...failure });
    }
  }, []);

  const submit = useCallback(
    (input: I): SubmitOutcome => {
      const opts = optionsRef.current;
      if (opts.enabled === false) return "disabled";
      if (inFlight.current) return "busy";
      const key = (opts.makeKey ?? newIdempotencyKey)();
      action.current = { input, key, applied: false };
      if (opts.optimistic) {
        opts.optimistic.apply(input);
        action.current.applied = true;
      }
      void attempt(input, key);
      return "started";
    },
    [attempt],
  );

  /** Same input, same key. Only after a failure that offers it. */
  const retry = useCallback((): SubmitOutcome => {
    const current = action.current;
    if (!current || inFlight.current) return "busy";
    if (optionsRef.current.enabled === false) return "disabled";
    if (optionsRef.current.optimistic && !current.applied) {
      optionsRef.current.optimistic.apply(current.input);
      current.applied = true;
    }
    void attempt(current.input, current.key);
    return "started";
  }, [attempt]);

  /** Gives up on the current action: rolls back an optimistic value that is still showing, forgets the key, goes idle. */
  const discard = useCallback(() => {
    const current = action.current;
    if (current?.applied) optionsRef.current.optimistic?.rollback(current.input);
    attemptId.current += 1; // anything still in flight is abandoned
    inFlight.current = false;
    action.current = null;
    if (mounted.current) setState({ status: "idle" });
  }, []);

  /** Back to idle after success or after the person has read a refusal. Does not roll back (the write succeeded or was already rolled back). */
  const reset = useCallback(() => {
    if (inFlight.current) return;
    action.current = null;
    if (mounted.current) setState({ status: "idle" });
  }, []);

  return { state, submit, retry, discard, reset, pending: state.status === "pending" };
}
