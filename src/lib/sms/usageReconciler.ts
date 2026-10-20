import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BilledSmsProvider } from "./usageProvider";

/**
 * TW-4F usage financials: one reconciliation pass. Releases reservations of texts that were never sent, then reads provider evidence for
 * submitted texts that are due and settles each through the database (which decides charge / pending / review). One item's failure never
 * stops the others. Nothing here schedules anything.
 */

export type UsageReconcileSummary = {
  releasedUnsent: number;
  due: number;
  settled: number;
  chargedCents: number;
  pending: number;
  review: number;
  errors: number;
};

type DueRow = { attempt_id: string; account_sid: string; provider_sid: string };

function isDueRow(value: unknown): value is DueRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return [row.attempt_id, row.account_sid, row.provider_sid].every((v) => typeof v === "string" && v !== "");
}

function errorCode(error: { code?: string } | null | undefined): string {
  return String(error?.code ?? "unknown");
}

export async function reconcileSmsUsage(
  admin: Pick<SupabaseClient, "rpc">,
  provider: BilledSmsProvider,
  options: { limit?: number } = {},
): Promise<UsageReconcileSummary> {
  const summary: UsageReconcileSummary = { releasedUnsent: 0, due: 0, settled: 0, chargedCents: 0, pending: 0, review: 0, errors: 0 };

  const released = await admin.rpc("tw4_usage_release_unsent");
  if (released.error) throw new Error(`usage reconcile: release_unsent failed (${errorCode(released.error)})`);
  const releasedCount = (released.data as { released?: unknown } | null)?.released;
  summary.releasedUnsent = typeof releasedCount === "number" ? releasedCount : 0;

  const due = await admin.rpc("tw4_usage_due", { p_limit: options.limit ?? 100 });
  if (due.error) throw new Error(`usage reconcile: due failed (${errorCode(due.error)})`);
  const rows = Array.isArray(due.data) ? (due.data as unknown[]).filter(isDueRow) : [];
  summary.due = rows.length;

  // a text that could not be read or settled goes to the back of the queue, so a few failing ones never block the rest (best effort)
  const touch = async (attemptId: string) => {
    try {
      await admin.rpc("tw4_usage_touch", { p_attempt_id: attemptId });
    } catch {
      // the next run simply sees it again first
    }
  };

  for (const row of rows) {
    let evidence;
    try {
      evidence = await provider.fetchMessage(row.account_sid, row.provider_sid);
    } catch {
      summary.errors += 1;
      await touch(row.attempt_id);
      continue;
    }
    let settled;
    try {
      settled = await admin.rpc("tw4_usage_settle", { p_attempt_id: row.attempt_id, p_evidence: evidence });
    } catch {
      summary.errors += 1;
      await touch(row.attempt_id);
      continue;
    }
    if (settled.error) {
      summary.errors += 1;
      await touch(row.attempt_id);
      continue;
    }
    const result = (settled.data ?? {}) as { outcome?: unknown; charged_cents?: unknown; replayed?: unknown };
    if (result.outcome === "settled") {
      summary.settled += 1;
      if (result.replayed !== true && typeof result.charged_cents === "number") summary.chargedCents += result.charged_cents;
    } else if (result.outcome === "pending") summary.pending += 1;
    else if (result.outcome === "review") summary.review += 1;
    else summary.errors += 1;
  }
  return summary;
}
