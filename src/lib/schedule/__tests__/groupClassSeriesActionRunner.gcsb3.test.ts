import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
// The REAL Next helper (not a stand-in): the runner must recognize genuine redirect control flow.
import { isRedirectError } from "next/dist/client/components/redirect-error";

import {
  CREATE_OUTCOME_UNCONFIRMED,
  PREVIEW_ACTION_FAILED,
  createInFlightGuard,
  dispatchGuarded,
  runKeyedAction,
  type KeyedResult,
  type SeriesSubmission,
} from "@/lib/schedule/groupClassSeriesActionRunner";
import {
  buildSeriesFormData,
  definitionKey,
  deriveSeriesView,
  initSeriesFormState,
  seriesFormReducer,
  type PreviewOccurrenceInput,
  type SeriesFormState,
} from "@/lib/schedule/groupClassSeriesFormModel";

const REQUEST_ID = "0f1e2d3c-4b5a-4978-8695-a4b3c2d1e0f9";

function filled(): SeriesFormState {
  return initSeriesFormState(() => REQUEST_ID, {
    title: "Beginner Salsa",
    startsOn: "2027-01-12",
    weekdays: [2, 4],
    startTime: "18:30",
    durationMinutes: "60",
    occurrenceCount: "6",
  });
}

function redirectError(url = "/app/schedule") {
  const error = new Error("NEXT_REDIRECT");
  (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
  return error;
}

function submissionFor(state: SeriesFormState): SeriesSubmission {
  return { formData: buildSeriesFormData(state), key: definitionKey(state.values) };
}

function occurrences(): PreviewOccurrenceInput[] {
  return [1, 2, 3].map((index) => {
    const start = new Date(Date.UTC(2027, 0, 12 + (index - 1) * 2, 23, 30));
    return {
      index, localDate: start.toISOString().slice(0, 10), startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + 3_600_000).toISOString(), dstNote: null, conflict: null,
    };
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function run<T>(call: (fd: FormData) => Promise<T>, state: SeriesFormState, failure = PREVIEW_ACTION_FAILED, guard = createInFlightGuard(), label = "preview") {
  guard.tryAcquire();
  return {
    guard,
    promise: runKeyedAction({ submission: submissionFor(state), call, failure, guard, isRedirect: isRedirectError, label }),
  };
}

describe("A. a rejected preview", () => {
  it("returns a safe retryable state, keeps the form's request id and definition, and exposes no raw error", async () => {
    const state = filled();
    const keyBefore = definitionKey(state.values);
    const { promise, guard } = run(async () => {
      throw new Error('relation "group_class_series" does not exist (secret detail)');
    }, state);

    const result = await promise;
    expect(result).toEqual({ key: keyBefore, state: PREVIEW_ACTION_FAILED });
    expect(JSON.stringify(result)).not.toMatch(/relation|group_class_series|secret/);
    expect(PREVIEW_ACTION_FAILED.error).toMatch(/Nothing was changed/);
    expect(PREVIEW_ACTION_FAILED.error).not.toMatch(/created|failed to create/i);
    // the form model is untouched: same id, same definition
    expect(state.requestId).toBe(REQUEST_ID);
    expect(definitionKey(state.values)).toBe(keyBefore);
    expect(guard.isHeld()).toBe(false);
    // only a fixed label is logged, never the thrown text
    expect(console.error).toHaveBeenCalledWith("GC-S1B series preview action did not complete.");
  });
});

describe("B. a rejected create (ambiguous outcome)", () => {
  it("returns the safe 'could not confirm' message, never claims failure, and keeps the same request id for the retry", async () => {
    const state = filled();
    const first = run(async () => {
      throw new TypeError("NetworkError: fetch failed (internal path /srv/app)");
    }, state, CREATE_OUTCOME_UNCONFIRMED, undefined, "create");
    const result = await first.promise;

    expect(result.state).toEqual(CREATE_OUTCOME_UNCONFIRMED);
    expect(result.state).toMatchObject({
      error: "We couldn't confirm whether the series was created. Check your schedule, then try again — retrying is safe.",
    });
    expect(CREATE_OUTCOME_UNCONFIRMED.error).not.toMatch(/\bfailed\b|did not|couldn't create|new request/i);
    expect(JSON.stringify(result)).not.toMatch(/NetworkError|fetch|internal|srv/);

    // retry: built from the same form instance, so the same id goes out again and nothing was reset
    const retry = submissionFor(state);
    expect(submissionFor(state).formData.get("clientRequestId")).toBe(REQUEST_ID);
    expect(retry.formData.get("clientRequestId")).toBe(REQUEST_ID);
    expect(state.requestId).toBe(REQUEST_ID);
    expect(retry.formData.get("title")).toBe("Beginner Salsa");
  });
});

describe("C. redirect control flow", () => {
  it("rethrows a Next redirect instead of turning it into an error state, and still releases the lock", async () => {
    const error = redirectError();
    expect(isRedirectError(error)).toBe(true);
    const { promise, guard } = run(async () => {
      throw error;
    }, filled(), CREATE_OUTCOME_UNCONFIRMED, undefined, "create");
    await expect(promise).rejects.toBe(error);
    expect(guard.isHeld()).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an ordinary error that merely looks similar is not treated as a redirect", async () => {
    const lookalike = new Error("NEXT_REDIRECT");
    const { promise } = run(async () => {
      throw lookalike;
    }, filled(), CREATE_OUTCOME_UNCONFIRMED, undefined, "create");
    await expect(promise).resolves.toMatchObject({ state: CREATE_OUTCOME_UNCONFIRMED });
  });
});

describe("D. result/definition binding", () => {
  it("a result submitted for definition A is ignored once the form shows definition B", async () => {
    const stateA = filled();
    const keyA = definitionKey(stateA.values);
    const { promise } = run(async () => ({ status: "preview" as const, occurrences: occurrences() }), stateA);

    // while A is in flight the user edits the form to definition B
    const stateB = seriesFormReducer(stateA, { type: "edit", patch: { startTime: "19:00" } });
    const resultA = await promise;
    expect(resultA.key).toBe(keyA);

    const view = deriveSeriesView({
      state: stateB,
      previewResult: resultA as KeyedResult<{ status: "preview"; occurrences: PreviewOccurrenceInput[] }>,
      createResult: { key: null, state: { status: "idle" } },
      pending: { preview: false, create: false },
      timeZone: "America/New_York",
    });
    expect(view.previewCurrent).toBe(false);
    expect(view.rows).toEqual([]);
    expect(view.canCreate).toBe(false);

    // and it still applies to the definition it was submitted for
    const viewA = deriveSeriesView({
      state: stateA,
      previewResult: resultA as KeyedResult<{ status: "preview"; occurrences: PreviewOccurrenceInput[] }>,
      createResult: { key: null, state: { status: "idle" } },
      pending: { preview: false, create: false },
      timeZone: "America/New_York",
    });
    expect(viewA.canCreate).toBe(true);
  });

  it("a newer dispatch for B never inherits A's stale rows while it is pending (the old result stays tagged A)", () => {
    const stateA = filled();
    const staleA: KeyedResult<{ status: "preview"; occurrences: PreviewOccurrenceInput[] }> = {
      key: definitionKey(stateA.values),
      state: { status: "preview", occurrences: occurrences() },
    };
    const stateB = seriesFormReducer(stateA, { type: "edit", patch: { title: "Renamed" } });
    // B has just been dispatched but its result has not arrived: pending flag not yet flipped (the review's stale window)
    const view = deriveSeriesView({
      state: stateB, previewResult: staleA, createResult: { key: null, state: { status: "idle" } },
      pending: { preview: false, create: false }, timeZone: "America/New_York",
    });
    expect(view.previewCurrent).toBe(false);
    expect(view.canCreate).toBe(false);
  });

  it("create-returned conflicts and errors for an older definition are not applied to a newer one", () => {
    const stateA = filled();
    const keyA = definitionKey(stateA.values);
    const stateB = seriesFormReducer(stateA, { type: "edit", patch: { title: "Another name" } });
    const base = {
      previewResult: { key: definitionKey(stateB.values), state: { status: "preview" as const, occurrences: occurrences() } },
      pending: { preview: false, create: false },
      timeZone: "America/New_York",
    };
    const staleConflict = { key: keyA, state: { status: "conflict" as const, conflicts: [{ index: 2, conflict: { category: "other" as const, message: "x" } }] } };
    const view = deriveSeriesView({ ...base, state: stateB, createResult: staleConflict });
    expect(view.rows[1].conflict).toBeNull();
    expect(view.canCreate).toBe(true);
  });
});

describe("E/F. same-tick duplicate dispatch", () => {
  function deferred() {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  it.each(["preview", "create"] as const)("two immediate %s attempts invoke the action once", async (label) => {
    const guard = createInFlightGuard();
    const pending = deferred();
    const call = vi.fn(async () => pending.promise);
    const state = filled();
    const inflight: Promise<unknown>[] = [];
    const dispatch = (submission: SeriesSubmission) => {
      inflight.push(
        runKeyedAction({
          submission, call, failure: label === "preview" ? PREVIEW_ACTION_FAILED : CREATE_OUTCOME_UNCONFIRMED,
          guard, isRedirect: isRedirectError, label,
        }),
      );
    };
    const attempt = () => dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch });

    expect(attempt()).toBe(true);
    expect(attempt()).toBe(false); // same tick: pending state has not rendered yet, the lock is the control
    expect(call).toHaveBeenCalledTimes(1);

    pending.resolve({ status: "idle" });
    await Promise.all(inflight);
    expect(guard.isHeld()).toBe(false);
  });

  it("preview and create share the lock, so they cannot overlap either", async () => {
    const guard = createInFlightGuard();
    const pending = deferred();
    const state = filled();
    const calls = vi.fn(async () => pending.promise);
    const mk = (label: "preview" | "create") => (submission: SeriesSubmission) => {
      void runKeyedAction({ submission, call: calls, failure: PREVIEW_ACTION_FAILED, guard, isRedirect: isRedirectError, label });
    };
    expect(dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch: mk("preview") })).toBe(true);
    expect(dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch: mk("create") })).toBe(false);
    expect(calls).toHaveBeenCalledTimes(1);
    pending.resolve({});
    await pending.promise;
  });

  it("does nothing when the action is not currently allowed", () => {
    const guard = createInFlightGuard();
    const dispatch = vi.fn();
    expect(dispatchGuarded({ guard, allowed: false, buildSubmission: () => submissionFor(filled()), dispatch })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(guard.isHeld()).toBe(false);
  });
});

describe("G. the lock is always released", () => {
  it("after a safe failure the next attempt dispatches", async () => {
    const guard = createInFlightGuard();
    const state = filled();
    let attempts = 0;
    const call = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("boom");
      return { status: "idle" as const };
    };
    const results: unknown[] = [];
    const dispatch = (submission: SeriesSubmission) => {
      results.push(runKeyedAction({ submission, call, failure: PREVIEW_ACTION_FAILED, guard, isRedirect: isRedirectError, label: "preview" }));
    };
    const attempt = () => dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch });

    expect(attempt()).toBe(true);
    await results[0];
    expect(guard.isHeld()).toBe(false);
    expect(attempt()).toBe(true);
    await results[1];
    expect(attempts).toBe(2);
  });

  it("is released after a redirect rejection and after a synchronous dispatch failure", async () => {
    const guard = createInFlightGuard();
    const state = filled();
    const run1 = runKeyedAction({
      submission: submissionFor(state), call: async () => { throw redirectError(); }, failure: CREATE_OUTCOME_UNCONFIRMED,
      guard: (guard.tryAcquire(), guard), isRedirect: isRedirectError, label: "create",
    });
    await expect(run1).rejects.toBeDefined();
    expect(guard.isHeld()).toBe(false);

    expect(() =>
      dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch: () => { throw new Error("could not start"); } }),
    ).toThrow("could not start");
    expect(guard.isHeld()).toBe(false);
    expect(dispatchGuarded({ guard, allowed: true, buildSubmission: () => submissionFor(state), dispatch: () => undefined })).toBe(true);
  });
});

describe("H. ambiguous create, then retry on the same form", () => {
  it("the retry carries the identical request id and a B2 replay (a redirect) is handled as success", async () => {
    const guard = createInFlightGuard();
    let state = filled();
    const sentIds: string[] = [];
    const server = vi.fn(async (fd: FormData) => {
      sentIds.push(String(fd.get("clientRequestId")));
      if (sentIds.length === 1) throw new TypeError("network lost after the server committed");
      throw redirectError(); // B2 replay => success redirect
    });
    const attempt = () => {
      guard.tryAcquire();
      return runKeyedAction({
        submission: submissionFor(state), call: server, failure: CREATE_OUTCOME_UNCONFIRMED,
        guard, isRedirect: isRedirectError, label: "create",
      });
    };

    const first = await attempt();
    expect(first.state).toEqual(CREATE_OUTCOME_UNCONFIRMED);

    // the owner may even keep editing between attempts: the id is not regenerated
    state = seriesFormReducer(state, { type: "edit", patch: { description: "More details" } });
    await expect(attempt()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });

    expect(sentIds).toEqual([REQUEST_ID, REQUEST_ID]);
    expect(state.requestId).toBe(REQUEST_ID);
    expect(guard.isHeld()).toBe(false);
  });
});

describe("the runner itself", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/schedule/groupClassSeriesActionRunner.ts"), "utf8");

  it("never generates or touches a request id", () => {
    expect(source).not.toMatch(/randomUUID|clientRequestId|requestId/);
  });

  it("the form wires both actions through it and uses the real Next redirect helper", () => {
    const form = readFileSync(join(process.cwd(), "src/app/app/schedule/new/GroupClassSeriesForm.tsx"), "utf8");
    expect(form.match(/runKeyedAction\(/g)?.length).toBe(2);
    expect(form).toContain('import { isRedirectError } from "next/dist/client/components/redirect-error"');
    expect(form).toContain("dispatchGuarded(");
    expect(form).not.toMatch(/useState/); // no separately tracked result keys left
    expect(form).not.toMatch(/previewedKey|createKey/);
    expect(form.match(/randomUUID/g)?.length).toBe(1);
  });
});
