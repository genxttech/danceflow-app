import type { SupabaseClient } from "@supabase/supabase-js";
import type { IsvNumberAdapter } from "./numberTypes";
import type { NumberStore } from "./numberStore";
import { reconcileInventories } from "./numberRunner";

/**
 * TW-4F A9: one scheduled pass of the per-subaccount number-inventory reconciliation (numberRunner.reconcileInventories), under the shared reconciliation run lease
 * (job 'inventory_reconcile', 20261223090000). It lists each due subaccount with ITS OWN credentials (read-only, free) and lets the database judge the listing; a pass
 * that cannot read anything is recorded as a FAILED run, never as a completed one, so inventory health stays visibly stale and sending stays held where it must.
 * Between subaccounts it checks the time budget and that this run still holds the lease; once either fails, the rest are reported as skipped (they stay due).
 * Counts only: no studio, account, number or provider text leaves this function.
 */

export const INVENTORY_RECONCILE_LEASE_SECONDS = 120;
/** No new subaccount is started after this: one subaccount (credentials, a listing with its 20-second provider timeout, the database writes) must still fit in maxDuration 60. */
export const INVENTORY_RECONCILE_BUDGET_MS = 30_000;
const JOB = "inventory_reconcile";

export type NumberReadRuntime = { ok: true; store: NumberStore; adapterFor(accountSid: string): Promise<IsvNumberAdapter> } | { ok: false; reason: string };

export type ScheduledInventoryOutcome =
  | { ran: false; reason: "busy" | "unavailable" }
  | { ran: true; runId: string; failed: boolean; summary: Record<string, number | boolean> };

export async function runScheduledInventoryReconcile(
  admin: Pick<SupabaseClient, "rpc">,
  runtime: NumberReadRuntime,
  options: { runner: string; budgetMs?: number; limit?: number; now?: () => number },
): Promise<ScheduledInventoryOutcome> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  const begin = await admin.rpc("tw4_reconcile_run_begin", { p_job: JOB, p_runner: options.runner, p_lease_seconds: INVENTORY_RECONCILE_LEASE_SECONDS });
  if (begin.error) return { ran: false, reason: "unavailable" };
  const lease = (begin.data ?? {}) as { acquired?: unknown; run_id?: unknown };
  if (lease.acquired !== true || typeof lease.run_id !== "string") return { ran: false, reason: "busy" };
  const runId = lease.run_id;
  const deadline = started + (options.budgetMs ?? INVENTORY_RECONCILE_BUDGET_MS);

  let failure: string | null = null;
  let leaseLost = false;
  let outOfTime = false;
  let counts = { checked: 0, clean: 0, findings: 0, skipped: 0, manual: 0, stopped: 0, escalation_raised: 0, escalation_failed: 0, escalation_error: false, work_list_failed: false };
  try {
    if (!runtime.ok) {
      // the real-call gates are off (or the configuration is incomplete): nothing is read, nothing is called, and the run says so
      failure = "inventory reconcile: number reads unavailable";
    } else {
      const shouldContinue = async () => {
        if (now() >= deadline) {
          outOfTime = true;
          return false;
        }
        const alive = await admin.rpc("tw4_reconcile_run_alive", { p_run_id: runId, p_job: JOB });
        if (alive.error || alive.data !== true) {
          leaseLost = true;
          return false;
        }
        return true;
      };
      const summary = await reconcileInventories({ store: runtime.store, adapterFor: runtime.adapterFor, limit: options.limit, shouldContinue });
      const escalation = summary.escalation;
      const workListFailed = "error" in escalation && escalation.error.startsWith("targets:");
      counts = {
        checked: summary.checked,
        clean: summary.clean,
        findings: summary.findings,
        skipped: summary.skipped.filter((s) => s.reason !== "stopped" && s.reason !== "manual_required").length,
        manual: summary.manual.length,
        stopped: summary.skipped.filter((s) => s.reason === "stopped").length,
        escalation_raised: "error" in escalation ? 0 : escalation.raised,
        escalation_failed: "error" in escalation ? 0 : escalation.failed ?? 0,
        escalation_error: "error" in escalation && !workListFailed,
        work_list_failed: workListFailed,
      };
      if (leaseLost) failure = "inventory reconcile: run lease lost";
      else if (workListFailed) failure = "inventory reconcile: work list unavailable";
    }
  } catch {
    failure = "inventory reconcile: unexpected failure";
  }
  const summary: Record<string, number | boolean> = {
    ...counts,
    // subaccounts left for the next pass (time, lease) count too: a run with a backlog is never reported as a clean success
    errors: counts.skipped + counts.stopped + counts.escalation_failed + (counts.escalation_error ? 1 : 0),
    out_of_time: outOfTime,
    reads_available: runtime.ok,
    duration_ms: now() - started,
  };
  try {
    await admin.rpc("tw4_reconcile_run_finish", { p_run_id: runId, p_status: failure ? "failed" : "completed", p_summary: summary, p_error: failure });
  } catch {
    // an unfinished run's lease expires and the next begin closes it as failed
  }
  return { ran: true, runId, failed: failure !== null, summary };
}
