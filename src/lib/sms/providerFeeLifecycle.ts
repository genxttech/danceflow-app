import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProviderFeeOpsRpc } from "./providerFeeAlerts/rpc";

/**
 * TW-4F recurring provider-fee lifecycle (migration 20261209090000): the application side.
 *
 *  - ProviderFeeLifecycleStore: typed service-role wrappers over the `tw4_rfl_*` functions. R2b registers each number / campaign in the SAME flow that records
 *    it (`register`), the platform panel (R2c) drives suspension, cancellation authorization / evidence and exposure dispositions. Errors carry the SQLSTATE,
 *    never the database message text. NOTHING here talks to Twilio, buys, cancels, releases, charges or extends an authorization: a cancellation is
 *    authorized and evidenced here, and the console step is a human's.
 *  - runProviderFeeLifecycleScan: one scheduled pass (heartbeat begin/finish, kill-switch aware; per legal business, under that business's account lock): exposure and upcoming-charge
 *    alerts, inventory gaps, then delivery of the alert outbox through an injected sink. Without a sink nothing is claimed (alerts stay pending and visible in the
 *    administrator overview). It returns counts only: no business, number, SID or amount.
 */

export class ProviderFeeError extends Error {
  constructor(readonly code: string) {
    super(`provider fee lifecycle: ${code}`);
    this.name = "ProviderFeeError";
  }
}

type Client = Pick<SupabaseClient, "rpc">;
type Resource = "messaging_service" | "campaign" | "number";

export type RegisterInput = {
  studioId: string;
  actorId: string;
  kind: Resource;
  providerSid: string;
  accountSid: string;
  e164?: string | null;
  source: "r2a" | "r2b" | "admin";
  sourceOperationId?: string | null;
  /** The reservation that already pays the registration period's fee (first month / first rent). */
  initialReservationId?: string | null;
};

export type CancelDecision = "owner_written" | "founder_written" | "policy_lapse";
export type CancelBegin = { action: "execute"; providerSid: string; resourceKind: Resource } | { action: "in_progress" } | { action: "reconcile" } | { action: "skip"; status: string };

export class ProviderFeeLifecycleStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new ProviderFeeError(String(error.code ?? "unknown"));
    return data as T;
  }

  async register(input: RegisterInput): Promise<{ resourceId: string; feeKind: string | null; replayed: boolean }> {
    const row = await this.call<{ resource_id: string; fee_kind?: string | null; replayed?: boolean }>("tw4_rfl_register", {
      p_studio_id: input.studioId, p_actor: input.actorId, p_kind: input.kind, p_provider_sid: input.providerSid, p_account_sid: input.accountSid, p_e164: input.e164 ?? null,
      p_source: input.source, p_source_operation: input.sourceOperationId ?? null, p_initial_reservation: input.initialReservationId ?? null,
    });
    return { resourceId: row.resource_id, feeKind: row.fee_kind ?? null, replayed: Boolean(row.replayed) };
  }

  async pilotCover(resourceId: string, periodKey: string, approvalRef: string, actorId: string): Promise<{ coverId: string; replayed: boolean }> {
    const row = await this.call<{ cover_id: string; replayed?: boolean }>("tw4_rfl_pilot_cover", { p_resource_id: resourceId, p_period_key: periodKey, p_approval_ref: approvalRef, p_actor: actorId });
    return { coverId: row.cover_id, replayed: Boolean(row.replayed) };
  }

  async observeProviderBill(resourceId: string, periodKey: string, providerRef: string, costCents: number, actorId: string): Promise<{ exposure: boolean; replayed: boolean }> {
    const row = await this.call<{ exposure_id?: string; exposure?: boolean; replayed?: boolean }>("tw4_rfl_observe_provider_bill", {
      p_resource_id: resourceId, p_period_key: periodKey, p_provider_ref: providerRef, p_cost_cents: costCents, p_actor: actorId,
    });
    return { exposure: row.exposure !== false, replayed: Boolean(row.replayed) };
  }

  async disposeExposure(resourceId: string, periodKey: string, disposition: "absorbed" | "not_billed_confirmed", note: string, actorId: string): Promise<{ replayed: boolean }> {
    const row = await this.call<{ replayed?: boolean }>("tw4_rfl_exposure_dispose", { p_resource_id: resourceId, p_period_key: periodKey, p_actor: actorId, p_disposition: disposition, p_note: note });
    return { replayed: Boolean(row.replayed) };
  }

  /** Stops DanceFlow's sending for a location. The provider resources are untouched and their fees continue (the result says how many). */
  async suspendDanceFlow(studioId: string, reason: string, hold: boolean, actorId: string): Promise<{ providerFeesContinueFor: number }> {
    const row = await this.call<{ provider_fees_continue_for?: number }>("tw4_rfl_suspend_df", { p_studio_id: studioId, p_actor: actorId, p_reason: reason, p_hold: hold });
    return { providerFeesContinueFor: Number(row.provider_fees_continue_for ?? 0) };
  }

  async authorizeCancel(resourceId: string, approvalRef: string, decidedBy: CancelDecision, reason: string, irreversibleAck: boolean, actorId: string): Promise<{ operationId: string; replayed: boolean }> {
    const row = await this.call<{ operation_id: string; replayed?: boolean }>("tw4_rfl_cancel_authorize", {
      p_resource_id: resourceId, p_actor: actorId, p_approval_ref: approvalRef, p_decided_by: decidedBy, p_reason: reason, p_irreversible_ack: irreversibleAck,
    });
    return { operationId: row.operation_id, replayed: Boolean(row.replayed) };
  }

  async withdrawCancel(operationId: string, note: string, actorId: string): Promise<void> {
    await this.call("tw4_rfl_cancel_withdraw", { p_operation_id: operationId, p_actor: actorId, p_note: note });
  }

  /** The single claim. Only `execute` permits the console step; `reconcile` means look the resource up first (an earlier outcome is unknown). */
  async beginCancel(operationId: string, actorId: string): Promise<CancelBegin> {
    const row = await this.call<{ action: string; provider_sid?: string; resource_kind?: Resource; status?: string }>("tw4_rfl_cancel_begin", { p_operation_id: operationId, p_actor: actorId });
    if (row.action === "execute" && row.provider_sid && row.resource_kind) return { action: "execute", providerSid: row.provider_sid, resourceKind: row.resource_kind };
    if (row.action === "in_progress" || row.action === "reconcile") return { action: row.action };
    return { action: "skip", status: String(row.status ?? "unknown") };
  }

  async finishCancel(operationId: string, outcome: "confirmed" | "refused" | "unknown", evidenceDigest: string | null, errorCode: string | null, actorId: string): Promise<{ status: string; replayed: boolean }> {
    const row = await this.call<{ status: string; replayed?: boolean }>("tw4_rfl_cancel_finish", {
      p_operation_id: operationId, p_actor: actorId, p_outcome: outcome, p_evidence_digest: evidenceDigest, p_error_code: errorCode,
    });
    return { status: row.status, replayed: Boolean(row.replayed) };
  }

  async resolveCancel(operationId: string, resolution: "cancelled" | "still_active", evidenceDigest: string | null, note: string, actorId: string): Promise<{ status: string; replayed: boolean }> {
    const row = await this.call<{ status: string; replayed?: boolean }>("tw4_rfl_cancel_resolve", {
      p_operation_id: operationId, p_actor: actorId, p_resolution: resolution, p_evidence_digest: evidenceDigest, p_note: note,
    });
    return { status: row.status, replayed: Boolean(row.replayed) };
  }

  /** Activation checklist input: blockers, never a pass by default. */
  async studioReady(studioId: string): Promise<{ ready: boolean; blockers: string[] }> {
    const row = await this.call<{ ready?: boolean; blockers?: unknown }>("tw4_rfl_studio_ready", { p_studio_id: studioId });
    return { ready: row.ready === true, blockers: Array.isArray(row.blockers) ? row.blockers.filter((b): b is string => typeof b === "string") : ["unreadable"] };
  }

  async scanEntities(): Promise<string[]> {
    const rows = await this.call<Array<{ legal_entity_id: string }> | null>("tw4_rfl_scan_entities", {});
    return (rows ?? []).map((r) => r.legal_entity_id).filter((id): id is string => typeof id === "string");
  }

  async scanEntity(entityId: string): Promise<{ opened: number; closed: number; alerts: number }> {
    const row = await this.call<{ opened?: number; closed?: number; alerts?: number }>("tw4_rfl_scan_entity", { p_entity_id: entityId });
    return { opened: Number(row.opened ?? 0), closed: Number(row.closed ?? 0), alerts: Number(row.alerts ?? 0) };
  }

  async inventoryGaps(): Promise<number> {
    const row = await this.call<{ gaps?: number }>("tw4_rfl_inventory_gaps", {});
    return Number(row.gaps ?? 0);
  }

  async claimAlerts(limit: number): Promise<ProviderFeeAlert[]> {
    const rows = await this.call<Array<Record<string, unknown>> | null>("tw4_rfl_alerts_claim", { p_limit: limit });
    return (rows ?? []).map((r) => ({
      id: String(r.alert_id), claimToken: String(r.claim_token), legalEntityId: String(r.legal_entity_id), studioId: typeof r.studio_id === "string" ? r.studio_id : null,
      kind: String(r.kind), audience: r.audience === "owner" || r.audience === "admin" ? r.audience : "both", severity: r.severity === "info" || r.severity === "critical" ? r.severity : "warning",
      summary: String(r.summary),
    }));
  }

  async finishAlert(alertId: string, claimToken: string, delivered: boolean, error: string | null): Promise<boolean> {
    const row = await this.call<{ updated?: boolean }>("tw4_rfl_alert_finish", { p_alert_id: alertId, p_claim_token: claimToken, p_delivered: delivered, p_error: error });
    return Boolean(row.updated);
  }
}

export type ProviderFeeAlert = {
  id: string;
  claimToken: string;
  legalEntityId: string;
  studioId: string | null;
  kind: string;
  audience: "owner" | "admin" | "both";
  severity: "info" | "warning" | "critical";
  summary: string;
};

/** Delivers one alert to its audience. Throwing marks the alert failed (retried, at most 5 attempts). The summary carries no amount, token or SID. */
export interface ProviderFeeAlertSink {
  deliver(alert: ProviderFeeAlert): Promise<void>;
}

export type ScanRanReason = "switched_off" | "busy" | "begin_failed" | "unknown";

export type ScanSummary = {
  /** false when the heartbeat refused the pass (scan switch off, another run holds the lease) or could not start it: nothing else was done */
  ran: boolean;
  ranReason: ScanRanReason | null;
  entities: number;
  opened: number;
  closed: number;
  alertsCreated: number;
  inventoryGaps: number;
  /** alerts newly raised for alert deliveries that exhausted their attempts (administrator audience) */
  escalated: number;
  delivered: number;
  failed: number;
  errors: number;
  deliveryEnabled: boolean;
  /** businesses beyond the per-run cap: counted as an error so a scan that cannot cover everyone is never silent */
  truncated: number;
  /** claimed alerts not started because the time budget was spent; RELEASED (back to pending, the attempt restored) for the next pass. Not an error. */
  deferred: number;
  /** 1 when the claim was skipped entirely because too little of the pass budget remained for delivery (nothing claimed, nothing burned), else 0 */
  deliverySkipped: number;
};

const MAX_ENTITIES = 500;
/** Per-pass alert cap: each alert can queue up to 15 emails, and the route has maxDuration 60. */
const MAX_ALERTS_PER_PASS = 20;
/** Delivery budget, measured from the START OF DELIVERY (not of the pass). Alerts not started within it are released; the run still finishes its heartbeat. */
export const DELIVERY_TIME_BUDGET_MS = 40_000;
/** Hard deadline for starting alert work, measured from the start of the pass (the route's maxDuration is 60 s). */
export const PASS_DEADLINE_MS = 50_000;
/** Below this much remaining time the claim is skipped entirely. */
export const MIN_DELIVERY_SLICE_MS = 10_000;
export type ScanRunOptions = { now?: () => number; budgetMs?: number; passDeadlineMs?: number; minSliceMs?: number; maxAlerts?: number };
export const SCAN_RUNNER_NAME = "sms-provider-fee-lifecycle";

type RunOps = Pick<ProviderFeeOpsRpc, "scanBegin" | "scanFinish" | "escalateDelivery" | "releaseAlert">;

/**
 * One scheduled pass, in contract order: heartbeat begin (stop when refused) -> business scans -> inventory gaps -> escalation of exhausted deliveries ->
 * alert delivery (ONLY when a sink is supplied; the route supplies one only with the strict env flag AND the database delivery switch) -> heartbeat finish
 * (always once a run began; `failed` on any error; counts only).
 */
export async function runProviderFeeLifecycleScan(store: ProviderFeeLifecycleStore, sink: ProviderFeeAlertSink | null, ops: RunOps, options: ScanRunOptions = {}): Promise<ScanSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const summary: ScanSummary = {
    ran: false, ranReason: null, entities: 0, opened: 0, closed: 0, alertsCreated: 0, inventoryGaps: 0, escalated: 0, delivered: 0, failed: 0, errors: 0,
    deliveryEnabled: sink !== null, truncated: 0, deferred: 0, deliverySkipped: 0,
  };
  let runId: string | null = null;
  try {
    const begin = await ops.scanBegin(SCAN_RUNNER_NAME);
    if (!begin.ran) {
      summary.ranReason = begin.reason === "switched_off" || begin.reason === "busy" ? begin.reason : "unknown";
      summary.deliveryEnabled = false;
      return summary;
    }
    if (!begin.runId) throw new Error("no_run_id");
    runId = begin.runId;
  } catch {
    summary.ranReason = "begin_failed";
    summary.deliveryEnabled = false;
    summary.errors += 1;
    return summary;
  }
  summary.ran = true;
  try {
    await scanAndDeliver(store, sink, ops, summary, { now, startedAt, budgetMs: options.budgetMs ?? DELIVERY_TIME_BUDGET_MS, passDeadlineMs: options.passDeadlineMs ?? PASS_DEADLINE_MS, minSliceMs: options.minSliceMs ?? MIN_DELIVERY_SLICE_MS, maxAlerts: options.maxAlerts ?? MAX_ALERTS_PER_PASS });
  } catch {
    summary.errors += 1;
  }
  try {
    // counts only: a flat object of finite numbers (the database refuses anything else); booleans become 0/1, strings are dropped
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
      else if (typeof value === "boolean") counts[key] = value ? 1 : 0;
    }
    await ops.scanFinish(runId, summary.errors > 0 ? "failed" : "completed", counts, summary.errors > 0 ? "scan_errors" : null);
  } catch {
    summary.errors += 1;
  }
  return summary;
}

type Budget = { now: () => number; startedAt: number; budgetMs: number; passDeadlineMs: number; minSliceMs: number; maxAlerts: number };

async function scanAndDeliver(store: ProviderFeeLifecycleStore, sink: ProviderFeeAlertSink | null, ops: RunOps, summary: ScanSummary, budget: Budget): Promise<void> {
  let entities: string[] = [];
  try {
    const all = await store.scanEntities();
    entities = all.slice(0, MAX_ENTITIES);
    summary.truncated = Math.max(0, all.length - entities.length);
    if (summary.truncated > 0) summary.errors += 1;
  } catch {
    summary.errors += 1;
  }
  for (const entityId of entities) {
    try {
      const out = await store.scanEntity(entityId);
      summary.entities += 1;
      summary.opened += out.opened;
      summary.closed += out.closed;
      summary.alertsCreated += out.alerts;
    } catch {
      summary.errors += 1;   // one business's failure never stops the others
    }
  }
  try {
    summary.inventoryGaps = await store.inventoryGaps();
  } catch {
    summary.errors += 1;
  }
  try {
    summary.escalated = await ops.escalateDelivery();   // every pass, whether or not delivery is on: exhausted alerts must surface
  } catch {
    summary.errors += 1;
  }
  if (!sink) return;
  // ONE claim per pass. tw4_rfl_alerts_claim counts an attempt at claim time and re-claims `failed` rows immediately (no backoff), so a second claim in the
  // same pass would burn the attempts of the alerts that just failed and starve newer ones. Each alert is therefore attempted AT MOST ONCE per pass (ids
  // already seen are skipped); retries happen on later passes. Claiming oldest-first, a pass covers up to maxAlerts alerts.
  // The deadline for starting work: the delivery budget from the start of delivery, bounded by the pass deadline. Too little left: do not claim at all
  // (a claim burns an attempt, and a slow scan must never make every pass claim and defer the same alerts).
  const deliveryStartedAt = budget.now();
  const deadline = Math.min(deliveryStartedAt + budget.budgetMs, budget.startedAt + budget.passDeadlineMs);
  if (deadline - deliveryStartedAt < budget.minSliceMs) {
    summary.deliverySkipped = 1;
    return;
  }
  let alerts: ProviderFeeAlert[] = [];
  try {
    alerts = await store.claimAlerts(budget.maxAlerts);
  } catch {
    summary.errors += 1;
    return;
  }
  const seen = new Set<string>();
  for (const alert of alerts) {
    if (seen.has(alert.id)) continue;
    seen.add(alert.id);
    if (budget.now() >= deadline) {
      // out of time before starting this alert: RELEASE it (pending again, attempt restored). If the release fails the alert stays 'sending' (re-claimable
      // after 15 minutes in the database) and is counted as an error; it is never marked failed.
      try {
        const released = await ops.releaseAlert(alert.id, alert.claimToken);
        if (released) summary.deferred += 1;
      } catch {
        summary.errors += 1;
      }
      continue;
    }
    let delivered = false;
    let error: string | null = null;
    try {
      await sink.deliver(alert);
      delivered = true;
    } catch (e) {
      error = e instanceof Error ? e.name.slice(0, 60) : "delivery_failed";
    }
    try {
      const updated = await store.finishAlert(alert.id, alert.claimToken, delivered, error);
      if (updated) {
        if (delivered) summary.delivered += 1;
        else summary.failed += 1;
      }
    } catch {
      summary.errors += 1;
    }
  }
}
