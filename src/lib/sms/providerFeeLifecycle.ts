import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F recurring provider-fee lifecycle (migration 20261209090000): the application side.
 *
 *  - ProviderFeeLifecycleStore: typed service-role wrappers over the `tw4_rfl_*` functions. R2b registers each number / campaign in the SAME flow that records
 *    it (`register`), the platform panel (R2c) drives suspension, cancellation authorization / evidence and exposure dispositions. Errors carry the SQLSTATE,
 *    never the database message text. NOTHING here talks to Twilio, buys, cancels, releases, charges or extends an authorization: a cancellation is
 *    authorized and evidenced here, and the console step is a human's.
 *  - runProviderFeeLifecycleScan: one scheduled pass (per legal business, under that business's account lock in the database): exposure and upcoming-charge
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

export type ScanSummary = {
  entities: number;
  opened: number;
  closed: number;
  alertsCreated: number;
  inventoryGaps: number;
  delivered: number;
  failed: number;
  errors: number;
  deliveryEnabled: boolean;
  /** businesses beyond the per-run cap: counted as an error so a scan that cannot cover everyone is never silent */
  truncated: number;
};

const MAX_ENTITIES = 500;
const ALERT_BATCH = 25;
const MAX_ALERT_BATCHES = 8;

export async function runProviderFeeLifecycleScan(store: ProviderFeeLifecycleStore, sink: ProviderFeeAlertSink | null): Promise<ScanSummary> {
  const summary: ScanSummary = { entities: 0, opened: 0, closed: 0, alertsCreated: 0, inventoryGaps: 0, delivered: 0, failed: 0, errors: 0, deliveryEnabled: sink !== null, truncated: 0 };
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
  if (!sink) return summary;
  for (let batch = 0; batch < MAX_ALERT_BATCHES; batch += 1) {
    let alerts: ProviderFeeAlert[] = [];
    try {
      alerts = await store.claimAlerts(ALERT_BATCH);
    } catch {
      summary.errors += 1;
      break;
    }
    if (alerts.length === 0) break;
    for (const alert of alerts) {
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
    if (alerts.length < ALERT_BATCH) break;
  }
  return summary;
}
