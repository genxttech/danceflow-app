import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { runBoundedDrain } from "../drain";

const SQL = readFileSync("src/lib/supabase/migrations/20270206090000_d24_m2c_drain_recovery.sql", "utf8");
function paramsOf(fn: string): string[] {
  const m = new RegExp("create or replace function public\\." + fn + "\\(([^)]*)\\)", "s").exec(SQL);
  if (!m) throw new Error("function not found in migration: " + fn);
  return m[1].split(",").map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
}

const batch = (o: Record<string, unknown>) => ({ data: { outcome: "completed", picked: 25, applied: 25, rejected: 0, failed: 0, pending_after: 10, more: true, ...o }, error: null });

describe("runBoundedDrain (D24 M2-C)", () => {
  it("calls d24_run_drain with exactly the migration's parameter names", async () => {
    const rpc = vi.fn(async (..._a: unknown[]) => batch({ more: false }));
    await runBoundedDrain({ supabase: { rpc } as never, trigger: "manual" });
    expect(rpc.mock.calls[0][0]).toBe("d24_run_drain");
    expect(Object.keys(rpc.mock.calls[0][1] as object).sort()).toEqual([...paramsOf("d24_run_drain")].sort());
  });

  it("stops when the queue is drained and sums the batches", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce(batch({ applied: 25, picked: 25, more: true }))
      .mockResolvedValueOnce(batch({ applied: 3, picked: 3, more: false, pending_after: 0 }));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled" });
    expect(s).toMatchObject({ batches: 2, applied: 28, picked: 28, pendingAfter: 0, stopReason: "drained" });
  });

  it("does not call a backlog drained when events remain pending", async () => {
    const rpc = vi.fn(async () => batch({ more: false, picked: 3, applied: 0, rejected: 0, failed: 3, pending_after: 3 }));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled" });
    expect(s).toMatchObject({ stopReason: "pending_remaining", pendingAfter: 3 });
  });

  it("is bounded by maxBatches", async () => {
    const rpc = vi.fn(async () => batch({}));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled", maxBatches: 3 });
    expect(s).toMatchObject({ batches: 3, stopReason: "max_batches" });
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("is bounded by wall-clock, always running at least one batch", async () => {
    const rpc = vi.fn(async () => batch({}));
    let t = 0;
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled", maxMs: 1_000, now: () => (t += 600) });
    expect(s.stopReason).toBe("time_budget");
    expect(s.batches).toBeGreaterThanOrEqual(1);
    expect(s.batches).toBeLessThan(5);
  });

  it("clamps absurd sizes", async () => {
    const rpc = vi.fn(async (..._a: unknown[]) => batch({ more: false }));
    await runBoundedDrain({ supabase: { rpc } as never, trigger: "manual", batchSize: 100000, maxBatches: -4 });
    expect((rpc.mock.calls[0][1] as { p_batch_size: number }).p_batch_size).toBe(100);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("backs off on busy without recording a failure", async () => {
    const rpc = vi.fn(async (..._a: unknown[]) => ({ data: { outcome: "busy" }, error: null }));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled" });
    expect(s).toMatchObject({ batches: 0, stopReason: "busy" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("stops after two consecutive batches that settle nothing", async () => {
    const rpc = vi.fn(async () => batch({ applied: 0, rejected: 0, failed: 25 }));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled", maxBatches: 20 });
    expect(s).toMatchObject({ batches: 2, failed: 50, stopReason: "no_progress" });
  });

  it("audits a database failure by code only and reports it", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "57014", message: "statement timeout with secret detail" } })
      .mockResolvedValueOnce({ data: { outcome: "recorded" }, error: null });
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "scheduled" });
    expect(s).toMatchObject({ stopReason: "error", errorCode: "57014", failureAudited: true });
    expect(rpc.mock.calls[1]).toEqual(["d24_record_drain_failure", { p_trigger: "scheduled", p_error_code: "57014" }]);
    expect(Object.keys(rpc.mock.calls[1][1]).sort()).toEqual([...paramsOf("d24_record_drain_failure")].sort());
    expect(JSON.stringify(s)).not.toContain("secret");
  });

  it("maps a non-SQLSTATE error to a fixed code and survives a failing audit call", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { code: "PGRST301", message: "x" } })
      .mockRejectedValueOnce(new Error("network"));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "manual" });
    expect(s).toMatchObject({ stopReason: "error", errorCode: "rpc_error", failureAudited: false });
  });

  it("treats an unexpected result shape as an error, not progress", async () => {
    const rpc = vi.fn(async (..._a: unknown[]) => ({ data: { weird: true }, error: null }));
    const s = await runBoundedDrain({ supabase: { rpc } as never, trigger: "manual" });
    expect(s).toMatchObject({ stopReason: "error", errorCode: "unexpected_result" });
  });
});
