import { act, renderHook } from "@testing-library/react-native";
import { MUTATION_TIMEOUT_MS, classifyFailure, useStaffMutation, type MutationOptions } from "@/lib/mutation";
import { StaffApiError } from "@/lib/staffApi";

/* The mutation framework (Business expansion, Phase 0, P0-3b). */

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(run: MutationOptions<string, string>["run"], extra: Partial<MutationOptions<string, string>> = {}) {
  let n = 0;
  const optimistic = { apply: jest.fn(), rollback: jest.fn() };
  const onSuccess = jest.fn();
  const onConflict = jest.fn();
  const hook = renderHook(() =>
    useStaffMutation<string, string>({ run, optimistic, onSuccess, onConflict, makeKey: () => `key-${++n}-xxxxxxxx`, ...extra }),
  );
  return { hook, optimistic, onSuccess, onConflict };
}

const apiError = (status: number, code: string, extra?: { serverCode?: string; current?: unknown }, retryAfter?: number) =>
  new StaffApiError(status, code as never, "msg", retryAfter, extra);

describe("happy path and the in-flight guard", () => {
  it("runs once, applies the optimistic value first, and reports success", async () => {
    const d = deferred<string>();
    const run = jest.fn(() => d.promise);
    const { hook, optimistic, onSuccess } = setup(run);

    let outcome = "";
    act(() => {
      outcome = hook.result.current.submit("a");
    });
    expect(outcome).toBe("started");
    expect(optimistic.apply).toHaveBeenCalledWith("a");
    expect(hook.result.current.state.status).toBe("pending");

    await act(async () => d.resolve("done"));
    expect(hook.result.current.state).toEqual({ status: "success", result: "done" });
    expect(onSuccess).toHaveBeenCalledWith("done", "a");
    expect(optimistic.rollback).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("a", "key-1-xxxxxxxx");
  });

  it("ignores a double tap: a second submit while one is running sends nothing", async () => {
    const d = deferred<string>();
    const run = jest.fn(() => d.promise);
    const { hook, optimistic } = setup(run);
    act(() => {
      hook.result.current.submit("a");
    });
    let second = "";
    act(() => {
      second = hook.result.current.submit("a");
    });
    expect(second).toBe("busy");
    expect(run).toHaveBeenCalledTimes(1);
    expect(optimistic.apply).toHaveBeenCalledTimes(1);
    await act(async () => d.resolve("ok"));
  });

  it("is a no-op behind a flag that is off", () => {
    const run = jest.fn(async () => "x");
    const { hook, optimistic } = setup(run, { enabled: false });
    let outcome = "";
    act(() => {
      outcome = hook.result.current.submit("a");
    });
    expect(outcome).toBe("disabled");
    expect(run).not.toHaveBeenCalled();
    expect(optimistic.apply).not.toHaveBeenCalled();
    expect(hook.result.current.state.status).toBe("idle");
  });

  it("a new action after success gets a NEW key", async () => {
    const run = jest.fn(async () => "ok");
    const { hook } = setup(run);
    await act(async () => {
      hook.result.current.submit("a");
    });
    await act(async () => {
      hook.result.current.submit("b");
    });
    expect(run.mock.calls.map((c) => (c as unknown[])[1])).toEqual(["key-1-xxxxxxxx", "key-2-xxxxxxxx"]);
  });
});

describe("definite refusals roll back and are not retried with the same input", () => {
  it.each([
    ["403 writes_disabled", apiError(403, "writes_disabled"), "writes_disabled"],
    ["426 upgrade_required", apiError(426, "upgrade_required"), "upgrade_required"],
    ["403 role_not_permitted", apiError(403, "role_not_permitted"), "not_permitted"],
    ["401 sign in again", apiError(401, "unauthenticated"), "sign_in_again"],
    ["400 invalid_request", apiError(400, "invalid_request"), "client_bug"],
    ["404 not_found", apiError(404, "not_found"), "not_found"],
  ])("%s", async (_n, error, kind) => {
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(error)));
    await act(async () => {
      hook.result.current.submit("a");
    });
    const state = hook.result.current.state;
    expect(state).toMatchObject({ status: "failed", kind, unconfirmed: false, retryable: false });
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
  });

  it("409 conflict: rolls back, hands the server's current state to onConflict, no retry", async () => {
    const current = { appointment: { id: "a", status: "no_show" } };
    const { hook, optimistic, onConflict } = setup(jest.fn(async () => Promise.reject(apiError(409, "conflict", { serverCode: "outcome_conflict", current }))));
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "conflict", retryable: false, conflict: { serverCode: "outcome_conflict", current } });
    expect(onConflict).toHaveBeenCalledWith({ serverCode: "outcome_conflict", current }, "a");
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
  });

  it("429 rolls back and offers a retry with the server's wait", async () => {
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(apiError(429, "rate_limited", undefined, 30))));
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "rate_limited", retryable: true, unconfirmed: false, retryAfterSeconds: 30 });
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
  });

  it("503 (nothing committed) rolls back and offers a retry", async () => {
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(apiError(503, "service_unavailable"))));
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(hook.result.current.state).toMatchObject({ kind: "unavailable", unconfirmed: false, retryable: true });
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
  });
});

describe("unknown outcomes keep the optimistic value and retry with the SAME key", () => {
  it("offline: not rolled back, retry reuses key and input, success clears it", async () => {
    const run = jest
      .fn<Promise<string>, [string, string]>()
      .mockRejectedValueOnce(apiError(0, "network_error"))
      .mockResolvedValueOnce("saved");
    const { hook, optimistic, onSuccess } = setup(run);

    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "offline", unconfirmed: true, retryable: true });
    expect(optimistic.rollback).not.toHaveBeenCalled();

    await act(async () => {
      hook.result.current.retry();
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual(["a", "key-1-xxxxxxxx"]);
    expect(run.mock.calls[1]).toEqual(["a", "key-1-xxxxxxxx"]); // the same key
    expect(optimistic.apply).toHaveBeenCalledTimes(1); // still showing, not re-applied
    expect(hook.result.current.state).toEqual({ status: "success", result: "saved" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("an unreadable answer is unconfirmed, not a refusal", () => {
    expect(classifyFailure(apiError(200, "unexpected_response"))).toMatchObject({ kind: "unavailable", unconfirmed: true, retryable: true });
    expect(classifyFailure(new Error("boom"))).toMatchObject({ unconfirmed: true, retryable: true });
  });

  it("discard rolls back the change that is still showing and returns to idle", async () => {
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(apiError(0, "network_error"))));
    await act(async () => {
      hook.result.current.submit("a");
    });
    act(() => hook.result.current.discard());
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
    expect(optimistic.rollback).toHaveBeenCalledWith("a");
    expect(hook.result.current.state.status).toBe("idle");
  });

  it("retry after a rolled-back 429 re-applies the optimistic value with the same key", async () => {
    const run = jest
      .fn<Promise<string>, [string, string]>()
      .mockRejectedValueOnce(apiError(429, "rate_limited", undefined, 5))
      .mockResolvedValueOnce("ok");
    const { hook, optimistic } = setup(run);
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
    await act(async () => {
      hook.result.current.retry();
    });
    expect(optimistic.apply).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][1]).toBe(run.mock.calls[0][1]);
    expect(hook.result.current.state.status).toBe("success");
  });
});

describe("server-named conflicts", () => {
  it("usage_sync_pending: the change stands, so it is unconfirmed and retryable, and nothing is rolled back", async () => {
    const err = apiError(409, "conflict", { serverCode: "usage_sync_pending" });
    expect(classifyFailure(err)).toMatchObject({ kind: "sync_pending", unconfirmed: true, retryable: true });
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(err)));
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(optimistic.rollback).not.toHaveBeenCalled();
    expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "sync_pending" });
  });
  it("other 409 codes stay conflicts with their raw code", () => {
    expect(classifyFailure(apiError(409, "conflict", { serverCode: "payment_required" }))).toMatchObject({ kind: "conflict", retryable: false, conflict: { serverCode: "payment_required" } });
  });
});

describe("forward compatibility and the final server follow-ups", () => {
  it("a 409 with a code this build does not know is NOT retryable and rolls back (forward-compat clause)", async () => {
    for (const body of [apiError(409, "not_markable"), new StaffApiError(409, "not_markable", "x", undefined, { serverCode: "some_future_code" })]) {
      const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(body)));
      await act(async () => {
        hook.result.current.submit("a");
      });
      expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "not_markable", retryable: false, unconfirmed: false });
      expect(optimistic.rollback).toHaveBeenCalledTimes(1);
    }
  });

  it("charge_failed: the no-show IS recorded, so nothing rolls back, and Try again repeats the same request and key and succeeds", async () => {
    const failed = apiError(409, "conflict", { serverCode: "charge_failed" });
    expect(classifyFailure(failed)).toMatchObject({ kind: "sync_pending", unconfirmed: true, retryable: true, serverCode: "charge_failed" });
    const run = jest.fn<Promise<string>, [string, string]>().mockRejectedValueOnce(failed).mockResolvedValueOnce("charged");
    const { hook, optimistic, onSuccess } = setup(run);
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(optimistic.rollback).not.toHaveBeenCalled();
    await act(async () => {
      hook.result.current.retry();
    });
    expect(run.mock.calls[1]).toEqual(run.mock.calls[0]);
    expect(hook.result.current.state).toEqual({ status: "success", result: "charged" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("package_exhausted: repeating cannot succeed (not retryable) and the screen is not rolled back, because the status may already be recorded", async () => {
    const err = apiError(409, "conflict", { serverCode: "package_exhausted" });
    expect(classifyFailure(err)).toMatchObject({ kind: "conflict", retryable: false, keepOptimistic: true });
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(err)));
    await act(async () => {
      hook.result.current.submit("a");
    });
    expect(optimistic.rollback).not.toHaveBeenCalled();
    expect(hook.result.current.state).toMatchObject({ status: "failed", retryable: false });
  });
});

describe("timeout", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("becomes unconfirmed after the timeout; the optimistic value stays; a late answer from the abandoned attempt is ignored once retried", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const run = jest.fn<Promise<string>, [string, string]>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { hook, optimistic, onSuccess } = setup(run);

    act(() => {
      hook.result.current.submit("a");
    });
    await act(async () => {
      jest.advanceTimersByTime(MUTATION_TIMEOUT_MS + 1);
    });
    expect(hook.result.current.state).toMatchObject({ status: "failed", kind: "timeout", unconfirmed: true, retryable: true });
    expect(optimistic.rollback).not.toHaveBeenCalled();

    act(() => {
      hook.result.current.retry();
    });
    expect(run.mock.calls[1][1]).toBe(run.mock.calls[0][1]); // same key

    await act(async () => first.resolve("late"));
    expect(onSuccess).not.toHaveBeenCalled(); // the abandoned attempt does not decide
    expect(hook.result.current.state.status).toBe("pending");

    await act(async () => second.resolve("final"));
    expect(hook.result.current.state).toEqual({ status: "success", result: "final" });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });
});

describe("reset", () => {
  it("returns to idle after a refusal without rolling back again", async () => {
    const { hook, optimistic } = setup(jest.fn(async () => Promise.reject(apiError(403, "writes_disabled"))));
    await act(async () => {
      hook.result.current.submit("a");
    });
    act(() => hook.result.current.reset());
    expect(hook.result.current.state.status).toBe("idle");
    expect(optimistic.rollback).toHaveBeenCalledTimes(1);
  });
});
