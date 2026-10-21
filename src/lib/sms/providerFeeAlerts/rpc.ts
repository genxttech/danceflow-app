import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ProviderFeeError } from "../providerFeeLifecycle";

/**
 * Typed service-role wrapper over the RFL operations contract (`tw4_rfl_alert_recipients`, `tw4_rfl_alert_delivery_record`, `tw4_rfl_scan_begin`,
 * `tw4_rfl_scan_finish`, `tw4_rfl_escalate_delivery`, `tw4_rfl_switch_enabled`, `tw4_rfl_health`). Errors carry the SQLSTATE only, never the database
 * message text. Every parser is conservative: anything unreadable becomes the safe value (no recipients, switch off, nothing recorded).
 * NOTHING here talks to Twilio.
 */
type Client = Pick<SupabaseClient, "rpc">;

export type AlertRecipientKind = "owner" | "admin";
export type AlertRecipient = {
  recipientKind: AlertRecipientKind;
  userId: string;
  /** The studio the database names for this recipient (an owner's location; may be null for a platform administrator). */
  studioId: string | null;
  email: string | null;
  emailVerified: boolean;
};
export type DeliveryOutcome = "queued" | "duplicate" | "invalid_recipient" | "no_recipient";
export type RflSwitch = "scan" | "delivery";
export type ScanBegin = { ran: boolean; reason: string | null; runId: string | null };
export type RflHealth = {
  scanSwitch: boolean;
  deliverySwitch: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: string | null;
  stale: boolean;
  runsFailed24h: number;
  alertsPending: number;
  alertsFailed: number;
  alertsExhausted: number;
  oldestPendingAlertAgeSeconds: number | null;
  openExposureCount: number;
  openCancelOperations: number;
};

const asNumber = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const asStringOrNull = (v: unknown) => (typeof v === "string" ? v : null);

export class ProviderFeeOpsRpc {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new ProviderFeeError(String(error.code ?? "unknown"));
    return data as T;
  }

  /** Verified, capped recipients as decided by the database (authorization lives there). Unreadable rows are dropped. */
  async alertRecipients(alertId: string): Promise<AlertRecipient[]> {
    const rows = await this.call<Array<Record<string, unknown>> | null>("tw4_rfl_alert_recipients", { p_alert_id: alertId });
    const out: AlertRecipient[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      if ((r.recipient_kind !== "owner" && r.recipient_kind !== "admin") || typeof r.user_id !== "string" || r.user_id.length === 0) continue;
      out.push({ recipientKind: r.recipient_kind, userId: r.user_id, studioId: asStringOrNull(r.studio_id), email: asStringOrNull(r.email), emailVerified: r.email_verified === true });
    }
    return out;
  }

  /** `recorded: false` means the claim token is not current (another worker owns the alert): the caller must stop. */
  async recordDelivery(alertId: string, claimToken: string, recipientRef: string, recipientKind: AlertRecipientKind, outcome: DeliveryOutcome): Promise<{ recorded: boolean; replayed: boolean }> {
    const row = await this.call<{ recorded?: boolean; replayed?: boolean } | null>("tw4_rfl_alert_delivery_record", {
      p_alert_id: alertId, p_claim_token: claimToken, p_recipient_ref: recipientRef, p_recipient_kind: recipientKind, p_outcome: outcome,
    });
    return { recorded: row?.recorded === true, replayed: row?.replayed === true };
  }

  async scanBegin(runner: string, leaseSeconds?: number): Promise<ScanBegin> {
    const row = await this.call<{ ran?: boolean; reason?: string | null; run_id?: string | null } | null>(
      "tw4_rfl_scan_begin",
      leaseSeconds === undefined ? { p_runner: runner } : { p_runner: runner, p_lease_seconds: leaseSeconds },
    );
    return { ran: row?.ran === true, reason: asStringOrNull(row?.reason), runId: asStringOrNull(row?.run_id) };
  }

  /** The summary is counts only. `error` is a short code, never a message. */
  async scanFinish(runId: string, status: "completed" | "failed", summary: Record<string, number | boolean | string | null>, error: string | null): Promise<boolean> {
    const row = await this.call<{ updated?: boolean } | null>("tw4_rfl_scan_finish", { p_run_id: runId, p_status: status, p_summary: summary, p_error: error });
    return row?.updated === true;
  }

  async escalateDelivery(): Promise<number> {
    const row = await this.call<{ escalated?: number } | null>("tw4_rfl_escalate_delivery", {});
    return asNumber(row?.escalated);
  }

  /** No row, an error or anything but `true` is OFF (fail closed). */
  async switchEnabled(name: RflSwitch): Promise<boolean> {
    const data = await this.call<unknown>("tw4_rfl_switch_enabled", { p_switch: name });
    return data === true;
  }

  async health(actorId: string): Promise<RflHealth> {
    const r = (await this.call<Record<string, unknown> | null>("tw4_rfl_health", { p_actor: actorId })) ?? {};
    return {
      scanSwitch: r.scan_switch === true,
      deliverySwitch: r.delivery_switch === true,
      lastRunAt: asStringOrNull(r.last_run_at),
      lastSuccessAt: asStringOrNull(r.last_success_at),
      lastStatus: asStringOrNull(r.last_status),
      stale: r.stale !== false,
      runsFailed24h: asNumber(r.runs_failed_24h),
      alertsPending: asNumber(r.alerts_pending),
      alertsFailed: asNumber(r.alerts_failed),
      alertsExhausted: asNumber(r.alerts_exhausted),
      oldestPendingAlertAgeSeconds: typeof r.oldest_pending_alert_age_seconds === "number" ? r.oldest_pending_alert_age_seconds : null,
      openExposureCount: asNumber(r.open_exposure_count),
      openCancelOperations: asNumber(r.open_cancel_operations),
    };
  }
}
