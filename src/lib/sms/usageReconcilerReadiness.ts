import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F F3 (20261218090000 `_tw4usage_reconciler_ready`): whether billed texting may run. The database refuses to switch billed texting on, and refuses every
 * new billed text (TW024), unless a completed usage reconcile run that read provider evidence and proved it can settle finished within 30 minutes and no expired lease is stuck.
 * Read-only; a missing function or any error reads as "not available" (null).
 */

export type ReconcilerReadinessDetail = "ready" | "no_completed_run" | "no_evidence_reads" | "evidence_failing" | "stale" | "stuck_lease" | "unknown";
export type ReconcilerReadiness = { ok: boolean; detail: ReconcilerReadinessDetail; lastSuccessAt: string | null };

const DETAILS = new Set<ReconcilerReadinessDetail>(["ready", "no_completed_run", "no_evidence_reads", "evidence_failing", "stale", "stuck_lease"]);

export function parseReconcilerReadiness(raw: unknown): ReconcilerReadiness | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.ok !== "boolean") return null;
  const detail = typeof r.detail === "string" && DETAILS.has(r.detail as ReconcilerReadinessDetail) ? (r.detail as ReconcilerReadinessDetail) : "unknown";
  // ready only when the database says so with a known detail (fail closed on anything unexpected)
  return { ok: r.ok && detail === "ready", detail, lastSuccessAt: typeof r.last_success_at === "string" && r.last_success_at !== "" ? r.last_success_at : null };
}

export async function loadReconcilerReadiness(admin: Pick<SupabaseClient, "rpc">): Promise<ReconcilerReadiness | null> {
  try {
    const { data, error } = await admin.rpc("_tw4usage_reconciler_ready");
    if (error) return null;
    return parseReconcilerReadiness(data);
  } catch {
    return null;
  }
}
