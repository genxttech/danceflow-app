import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Platform-admin read side of the billed-text reconciliation (20261205090000 `tw4_usage_reconcile_overview`). Defensive parsing: unknown values are
 * dropped, nothing here carries a message body or a client phone number. A missing function or any error reads as "not available" (null).
 */

type Client = SupabaseClient;

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const SUMMARY_KEYS = [
  "released_unsent", "settled", "charged_cents", "pending", "review", "retrying", "errors", "escalated",
  "inbound_recovered", "inbound_unrouted", "inbound_keywords_unseen", "inbound_refused", "inbound_stalled", "truncated", "evidence_read",
] as const;
export type ReconcileSummaryKey = (typeof SUMMARY_KEYS)[number];

export type ReconcileRun = {
  runId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Partial<Record<ReconcileSummaryKey, number>>;
  hasError: boolean;
};
export type ReconcileException = {
  attemptId: string;
  studioId: string | null;
  state: string;
  createdAt: string | null;
  submittingAt: string | null;
  escalatedAt: string | null;
  hasProviderMessage: boolean;
  reservedCents: number;
  estimatedSegments: number;
  reviewReason: string | null;
  submitErrorCode: string | null;
  evidenceStatus: string | null;
  evidenceErrorCode: string | null;
  evidenceFailures: number;
  callbackStatus: string | null;
};
export type InboundCursor = { accountSid: string; scannedThrough: string | null; lagMinutes: number };
export type KeywordUnseen = { providerSid: string; studioId: string | null; recoveredAt: string | null; webhookSeen: boolean };
export type InboundUnresolved = { providerSid: string; accountSid: string | null; reason: string; code: string | null; notedAt: string | null };
export type ReconcileOverview = {
  switchOn: boolean;
  lastCompletedAt: string | null;
  stale: boolean;
  running: { runId: string; runner: string | null; startedAt: string | null; leaseExpiresAt: string | null } | null;
  runs: ReconcileRun[];
  byState: Record<string, number>;
  staleReserved: number;
  evidenceRetrying: number;
  escalatedOpen: number;
  reservedOpenCents: number;
  usageGaps: number;
  inboundGaps: number;
  exceptions: ReconcileException[];
  inbound: { cursors: InboundCursor[]; unscannedAccounts: number; recovered7d: Record<string, number>; keywordsUnseen: KeywordUnseen[]; unresolved7d: Record<string, number>; unresolved: InboundUnresolved[] };
};

const counts = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(obj(v)).filter(([, n]) => typeof n === "number" || typeof n === "string").map(([k, n]) => [k, num(n)]));

export function parseReconcileOverview(data: unknown): ReconcileOverview {
  const o = obj(data);
  const inbound = obj(o.inbound);
  const running = obj(o.running);
  return {
    switchOn: o.switch_on === true,
    lastCompletedAt: str(o.last_completed_at),
    stale: o.stale === true,
    running: typeof running.run_id === "string"
      ? { runId: running.run_id, runner: str(running.runner), startedAt: str(running.started_at), leaseExpiresAt: str(running.lease_expires_at) }
      : null,
    runs: list(o.runs).flatMap((row) => {
      const r = obj(row);
      if (typeof r.run_id !== "string") return [];
      const s = obj(r.summary);
      const summary: ReconcileRun["summary"] = {};
      for (const k of SUMMARY_KEYS) if (s[k] !== undefined && s[k] !== null) summary[k] = num(s[k]);
      return [{ runId: r.run_id, status: str(r.status) ?? "unknown", startedAt: str(r.started_at), finishedAt: str(r.finished_at), summary, hasError: str(r.error) !== null }];
    }),
    byState: counts(o.by_state),
    staleReserved: num(o.stale_reserved),
    evidenceRetrying: num(o.evidence_retrying),
    escalatedOpen: num(o.escalated_open),
    reservedOpenCents: num(o.reserved_open_cents),
    usageGaps: num(o.usage_gaps),
    inboundGaps: num(o.inbound_gaps),
    exceptions: list(o.exceptions).flatMap((row) => {
      const x = obj(row);
      if (typeof x.attempt_id !== "string") return [];
      return [{
        attemptId: x.attempt_id,
        studioId: str(x.studio_id),
        state: str(x.state) ?? "unknown",
        createdAt: str(x.created_at),
        submittingAt: str(x.submitting_at),
        escalatedAt: str(x.escalated_at),
        hasProviderMessage: x.has_provider_message === true,
        reservedCents: num(x.reserved_cents),
        estimatedSegments: Math.min(10, Math.max(1, Math.trunc(num(x.estimated_segments)) || 1)),
        reviewReason: str(x.review_reason),
        submitErrorCode: str(x.submit_error_code),
        evidenceStatus: str(x.evidence_status),
        evidenceErrorCode: str(x.evidence_error_code),
        evidenceFailures: num(x.evidence_failures),
        callbackStatus: str(x.callback_status),
      }];
    }),
    inbound: {
      cursors: list(inbound.cursors).flatMap((row) => {
        const c = obj(row);
        return typeof c.account_sid === "string" ? [{ accountSid: c.account_sid, scannedThrough: str(c.scanned_through), lagMinutes: num(c.lag_minutes) }] : [];
      }),
      unscannedAccounts: num(inbound.unscanned_accounts),
      recovered7d: counts(inbound.recovered_7d),
      keywordsUnseen: list(inbound.keywords_unseen).flatMap((row) => {
        const k = obj(row);
        return typeof k.provider_sid === "string" ? [{ providerSid: k.provider_sid, studioId: str(k.studio_id), recoveredAt: str(k.recovered_at), webhookSeen: k.webhook_seen === true }] : [];
      }),
      unresolved7d: counts(inbound.unresolved_7d),
      unresolved: list(inbound.unresolved).flatMap((row) => {
        const u = obj(row);
        return typeof u.provider_sid === "string" ? [{ providerSid: u.provider_sid, accountSid: str(u.account_sid), reason: str(u.reason) ?? "unknown", code: str(u.code), notedAt: str(u.noted_at) }] : [];
      }),
    },
  };
}

/** Null when the function is not installed in this environment, the caller is not a platform admin, or anything else fails: the panel is then hidden. */
export async function loadReconcileOverview(admin: Client, actorId: string): Promise<ReconcileOverview | null> {
  try {
    const { data, error } = await admin.rpc("tw4_usage_reconcile_overview", { p_actor: actorId, p_limit: 50 });
    if (error || !data || typeof data !== "object") return null;
    return parseReconcileOverview(data);
  } catch {
    return null;
  }
}
