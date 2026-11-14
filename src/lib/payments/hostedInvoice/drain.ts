import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * D24 M2-C: bounded application-side loop around d24_run_drain (ONE database batch per call, its own transaction).
 * Service-role clients only. Nothing in the repository calls this yet: no route, no cron entry. Activation is a separate,
 * explicitly authorized step (docs/billing/D24-M2C-DRAIN.md).
 *
 * Bounds: batches per invocation, wall-clock budget, and a stop after two consecutive batches that settle nothing (a
 * transient fault must not turn into a hot loop). A database failure is audited by error code only (d24_record_drain_failure)
 * and reported to the caller; the loop never retries it in-process.
 */

export type DrainTrigger = "scheduled" | "manual";
export type DrainStopReason = "drained" | "pending_remaining" | "busy" | "max_batches" | "time_budget" | "no_progress" | "error";

export type DrainSummary = {
  batches: number;
  picked: number;
  applied: number;
  rejected: number;
  failed: number;
  pendingAfter: number | null;
  stopReason: DrainStopReason;
  errorCode?: string;
  failureAudited?: boolean;
};

type BatchResult = { outcome?: string; picked?: number; applied?: number; rejected?: number; failed?: number; pending_after?: number; more?: boolean };

const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? Math.trunc(value as number) : fallback));

export async function runBoundedDrain(input: {
  supabase: Pick<SupabaseClient, "rpc">;
  trigger: DrainTrigger;
  batchSize?: number;
  maxBatches?: number;
  maxMs?: number;
  now?: () => number;
}): Promise<DrainSummary> {
  const { supabase, trigger } = input;
  const now = input.now ?? Date.now;
  const batchSize = clamp(input.batchSize, 25, 1, 100);
  const maxBatches = clamp(input.maxBatches, 10, 1, 50);
  const maxMs = clamp(input.maxMs, 20_000, 1_000, 55_000);
  const startedAt = now();
  const summary: DrainSummary = { batches: 0, picked: 0, applied: 0, rejected: 0, failed: 0, pendingAfter: null, stopReason: "drained" };
  let idle = 0;

  for (;;) {
    if (summary.batches >= maxBatches) return { ...summary, stopReason: "max_batches" };
    if (summary.batches > 0 && now() - startedAt >= maxMs) return { ...summary, stopReason: "time_budget" };

    const { data, error } = await supabase.rpc("d24_run_drain", { p_batch_size: batchSize, p_trigger: trigger });
    if (error) {
      const errorCode = /^[0-9A-Z]{5}$/.test(error.code ?? "") ? (error.code as string) : "rpc_error";
      // Evidence of the failed run, code only. supabase-js reports failures as { error } and may reject on network faults;
      // either way the caller still gets the error summary, and is told when the audit row itself could not be written.
      let audited = true;
      try {
        const recorded = await supabase.rpc("d24_record_drain_failure", { p_trigger: trigger, p_error_code: errorCode });
        audited = !recorded.error;
      } catch {
        audited = false;
      }
      if (!audited) console.error("d24_drain_failure_not_audited", { errorCode });
      return { ...summary, stopReason: "error", errorCode, failureAudited: audited };
    }

    const result = (data ?? {}) as BatchResult;
    if (result.outcome === "busy") return { ...summary, stopReason: "busy" };
    if (result.outcome !== "completed") return { ...summary, stopReason: "error", errorCode: "unexpected_result" };

    summary.batches += 1;
    summary.picked += result.picked ?? 0;
    summary.applied += result.applied ?? 0;
    summary.rejected += result.rejected ?? 0;
    summary.failed += result.failed ?? 0;
    summary.pendingAfter = result.pending_after ?? null;

    if (!result.more) return { ...summary, stopReason: (result.pending_after ?? 0) > 0 ? "pending_remaining" : "drained" };
    idle = (result.applied ?? 0) + (result.rejected ?? 0) === 0 ? idle + 1 : 0;
    if (idle >= 2) return { ...summary, stopReason: "no_progress" };
  }
}
