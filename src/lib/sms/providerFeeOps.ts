import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F recurring provider fees: platform-administrator operations, application side. A thin, typed, SERVER-ONLY wrapper over the operations SQL contract
 * (`tw4_rfl_health`, `tw4_rfl_exposure_report`, `tw4_rfl_variance_report`, `tw4_rfl_variance_ack`, `tw4_rfl_dual_*`, `tw4_rfl_set_switch`) plus the merged
 * `tw4_rfl_admin_overview`. It adds no authorization of its own: the CALLER (a server action or page that already ran `requirePlatformAdmin`) passes the
 * actor it derived from the session, and the database checks the platform-admin actor again in every function.
 *
 * READS never throw: a function that is not installed in this environment, a caller that is not an administrator, any error or any answer that is not the
 * documented shape reads as `null` = "not available". Parsing is defensive: unknown enum values are dropped, malformed entries are skipped. WRITES throw
 * `ProviderFeeOpsError` carrying the SQLSTATE only, never the database message text. Nothing here talks to Twilio, charges, renews or extends anything.
 */

type Client = Pick<SupabaseClient, "rpc">;

/** The result banner travels in this short-lived httpOnly cookie (see panelFlash.ts), never in the URL. */
export const RFL_FLASH_COOKIE = "tw4_rfl_flash";

export class ProviderFeeOpsError extends Error {
  constructor(readonly code: string) {
    super(`provider fee ops: ${code}`);
    this.name = "ProviderFeeOpsError";
  }
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : null);
const nonNeg = (v: unknown): number => Math.max(0, int(v) ?? 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: unknown): string | null => (typeof v === "string" && UUID.test(v) ? v : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[]): T | null => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null);

// ---------------------------------------------------------------------------------------------------------------
// view types
// ---------------------------------------------------------------------------------------------------------------
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

export const CANCEL_STATUSES = ["authorized", "in_flight", "unknown_outcome"] as const;
export type CancelStatus = (typeof CANCEL_STATUSES)[number];
export const RESOURCE_KINDS = ["messaging_service", "campaign", "number"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export type RflResource = {
  resourceId: string;
  legalEntityId: string;
  studioId: string;
  kind: ResourceKind;
  feeKind: string | null;
  providerState: "active" | "cancelled";
  dfSending: boolean | null;
  currentPeriod: string | null;
  nextPeriod: string | null;
  openCancelOperation: CancelStatus | null;
  /** The business is the pilot business (it has no standing authorization: every period needs its own written approval). Derived from the cover states. */
  pilot: boolean;
};

export type RflOverview = {
  resources: RflResource[];
  alertsWaiting: number;
  cancelOperationsOpen: number;
};

export const AGING_BUCKETS = ["0-7", "8-30", "31-90", "90+"] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];
export type DualAction = "absorb_exposure" | "cancel_number";
export type DualStatus = "pending" | "approved";

export type RflExposure = {
  legalEntityId: string;
  studioId: string | null;
  resourceId: string;
  resourceKind: ResourceKind | null;
  feeKind: string | null;
  periodKey: string;
  reason: string;
  state: string | null;
  firstDetectedAt: string | null;
  ageDays: number | null;
  agingBucket: AgingBucket | null;
  expectedProviderCents: number | null;
  providerBilledCents: number | null;
  dualRequestStatus: DualStatus | null;
};

export type RflVariance = {
  chargeId: string;
  legalEntityId: string | null;
  studioId: string | null;
  kind: string | null;
  expectedCostCents: number | null;
  providerCostCents: number | null;
  varianceCents: number | null;
  acknowledged: boolean;
  acknowledgedAt: string | null;
  note: string | null;
};

export type RflDualRequest = {
  requestId: string;
  action: DualAction;
  legalEntityId: string | null;
  studioId: string | null;
  resourceId: string;
  periodKey: string | null;
  reason: string;
  expectedProviderCents: number | null;
  providerBilledCents: number | null;
  requestedBy: string;
  requestedAt: string | null;
  expiresAt: string | null;
  status: DualStatus;
};

export type RflOps = {
  health: RflHealth | null;
  overview: RflOverview | null;
  exposures: RflExposure[] | null;
  variances: RflVariance[] | null;
  dual: RflDualRequest[] | null;
};

// ---------------------------------------------------------------------------------------------------------------
// parsers (null = not the documented shape)
// ---------------------------------------------------------------------------------------------------------------
export function parseHealth(raw: unknown): RflHealth | null {
  const o = obj(raw);
  if (!o) return null;
  return {
    scanSwitch: o.scan_switch === true,   // fail closed: anything but true is OFF
    deliverySwitch: o.delivery_switch === true,
    lastRunAt: str(o.last_run_at),
    lastSuccessAt: str(o.last_success_at),
    lastStatus: str(o.last_status),
    stale: o.stale !== false,   // an unreadable freshness reads as stale, never as healthy
    runsFailed24h: nonNeg(o.runs_failed_24h),
    alertsPending: nonNeg(o.alerts_pending),
    alertsFailed: nonNeg(o.alerts_failed),
    alertsExhausted: nonNeg(o.alerts_exhausted),
    oldestPendingAlertAgeSeconds: int(o.oldest_pending_alert_age_seconds),
    openExposureCount: nonNeg(o.open_exposure_count),
    openCancelOperations: nonNeg(o.open_cancel_operations),
  };
}

const PILOT_COVER = new Set(["uncovered:no_pilot_approval", "covered:pilot_approval"]);

export function parseOverview(raw: unknown): RflOverview | null {
  const o = obj(raw);
  if (!o || !Array.isArray(o.resources)) return null;
  const resources: RflResource[] = [];
  for (const entry of o.resources) {
    const r = obj(entry);
    const resourceId = r ? uuid(r.resource_id) : null;
    const legalEntityId = r ? uuid(r.legal_entity_id) : null;
    const studioId = r ? uuid(r.studio_id) : null;
    const kind = r ? pick(r.kind, RESOURCE_KINDS) : null;
    const providerState = r ? pick(r.provider_state, ["active", "cancelled"] as const) : null;
    if (!r || !resourceId || !legalEntityId || !studioId || !kind || !providerState) continue;
    const current = str(r.current_period);
    const next = str(r.next_period);
    resources.push({
      resourceId, legalEntityId, studioId, kind, providerState,
      feeKind: str(r.fee_kind),
      dfSending: typeof r.df_sending === "boolean" ? r.df_sending : null,
      currentPeriod: current,
      nextPeriod: next,
      openCancelOperation: pick(r.open_cancel_operation, CANCEL_STATUSES),
      pilot: (current !== null && PILOT_COVER.has(current)) || (next !== null && PILOT_COVER.has(next)),
    });
  }
  return { resources, alertsWaiting: nonNeg(o.alerts_waiting), cancelOperationsOpen: nonNeg(o.cancel_operations_open) };
}

export function parseExposures(raw: unknown): RflExposure[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RflExposure[] = [];
  for (const entry of raw) {
    const e = obj(entry);
    const resourceId = e ? uuid(e.resource_id) : null;
    const legalEntityId = e ? uuid(e.legal_entity_id) : null;
    const periodKey = e ? str(e.period_key) : null;
    if (!e || !resourceId || !legalEntityId || !periodKey || !/^\d{4}-(0[1-9]|1[0-2])$/.test(periodKey)) continue;
    out.push({
      legalEntityId, resourceId, periodKey,
      studioId: uuid(e.studio_id),
      resourceKind: pick(e.resource_kind, RESOURCE_KINDS),
      feeKind: str(e.fee_kind),
      reason: str(e.reason) ?? "unknown",
      state: str(e.state),
      firstDetectedAt: str(e.first_detected_at),
      ageDays: int(e.age_days),
      agingBucket: pick(e.aging_bucket, AGING_BUCKETS),
      expectedProviderCents: int(e.expected_provider_cents),
      providerBilledCents: int(e.provider_billed_cents),
      dualRequestStatus: pick(e.dual_request_status, ["pending", "approved"] as const),
    });
  }
  return out;
}

export function parseVariances(raw: unknown): RflVariance[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RflVariance[] = [];
  for (const entry of raw) {
    const v = obj(entry);
    const chargeId = v ? uuid(v.charge_id) : null;
    if (!v || !chargeId) continue;
    out.push({
      chargeId,
      legalEntityId: uuid(v.legal_entity_id),
      studioId: uuid(v.studio_id),
      kind: str(v.kind),
      expectedCostCents: int(v.expected_cost_cents),
      providerCostCents: int(v.provider_cost_cents),
      varianceCents: int(v.variance_cents),
      acknowledged: v.acknowledged === true,
      acknowledgedAt: str(v.acknowledged_at),
      note: str(v.note),
      // provider_ref and acknowledged_by are deliberately not carried: the panel needs neither
    });
  }
  return out;
}

export function parseDual(raw: unknown): RflDualRequest[] | null {
  if (!Array.isArray(raw)) return null;
  const out: RflDualRequest[] = [];
  for (const entry of raw) {
    const d = obj(entry);
    const requestId = d ? uuid(d.request_id) : null;
    const resourceId = d ? uuid(d.resource_id) : null;
    const requestedBy = d ? uuid(d.requested_by) : null;
    const action = d ? pick(d.action, ["absorb_exposure", "cancel_number"] as const) : null;
    const status = d ? pick(d.status, ["pending", "approved"] as const) : null;
    if (!d || !requestId || !resourceId || !requestedBy || !action || !status) continue;
    out.push({
      requestId, action, resourceId, requestedBy, status,
      legalEntityId: uuid(d.legal_entity_id),
      studioId: uuid(d.studio_id),
      periodKey: str(d.period_key),
      reason: str(d.reason) ?? "",
      expectedProviderCents: int(d.expected_provider_cents),
      providerBilledCents: int(d.provider_billed_cents),
      requestedAt: str(d.requested_at),
      expiresAt: str(d.expires_at),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// loader
// ---------------------------------------------------------------------------------------------------------------
async function read<T>(admin: Client, fn: string, args: Record<string, unknown>, parse: (raw: unknown) => T | null): Promise<T | null> {
  try {
    const { data, error } = (await admin.rpc(fn, args)) as { data: unknown; error: unknown };
    if (error || data === null || data === undefined) return null;
    return parse(data);
  } catch {
    return null;
  }
}

/** Every read is independent: one missing function never hides the others. */
export async function loadRecurringFeeOps(admin: Client, actorId: string): Promise<RflOps> {
  const args = { p_actor: actorId };
  const [health, overview, exposures, variances, dual] = await Promise.all([
    read(admin, "tw4_rfl_health", args, parseHealth),
    read(admin, "tw4_rfl_admin_overview", args, parseOverview),
    read(admin, "tw4_rfl_exposure_report", args, parseExposures),
    read(admin, "tw4_rfl_variance_report", args, parseVariances),
    read(admin, "tw4_rfl_dual_list", args, parseDual),
  ]);
  return { health, overview, exposures, variances, dual };
}

// ---------------------------------------------------------------------------------------------------------------
// store (writes)
// ---------------------------------------------------------------------------------------------------------------
export class ProviderFeeOpsStore {
  constructor(private readonly admin: Client) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: { data: unknown; error: { code?: string } | null };
    try {
      res = (await this.admin.rpc(fn, args)) as typeof res;
    } catch {
      throw new ProviderFeeOpsError("unknown");
    }
    if (res.error) throw new ProviderFeeOpsError(String(res.error.code ?? "unknown"));
    return obj(res.data) ?? {};
  }

  async setSwitch(sw: "scan" | "delivery", enabled: boolean, reason: string, actorId: string): Promise<{ enabled: boolean }> {
    const row = await this.call("tw4_rfl_set_switch", { p_switch: sw, p_enabled: enabled, p_actor: actorId, p_reason: reason });
    return { enabled: row.enabled === true };
  }

  async varianceAck(chargeId: string, note: string, actorId: string): Promise<{ replayed: boolean }> {
    const row = await this.call("tw4_rfl_variance_ack", { p_charge_id: chargeId, p_actor: actorId, p_note: note });
    return { replayed: row.replayed === true };
  }

  async dualRequest(args: { action: DualAction; resourceId: string; periodKey: string | null; reason: string; approvalRef: string | null }, actorId: string): Promise<{ requestId: string | null }> {
    const row = await this.call("tw4_rfl_dual_request", {
      p_actor: actorId, p_action: args.action, p_resource_id: args.resourceId, p_period_key: args.periodKey, p_reason: args.reason, p_approval_ref: args.approvalRef,
    });
    return { requestId: uuid(row.request_id) };
  }

  async dualApprove(requestId: string, note: string, actorId: string): Promise<{ status: string | null }> {
    const row = await this.call("tw4_rfl_dual_approve", { p_request_id: requestId, p_actor: actorId, p_note: note });
    return { status: str(row.status) };
  }

  async dualReject(requestId: string, note: string, actorId: string): Promise<{ status: string | null }> {
    const row = await this.call("tw4_rfl_dual_reject", { p_request_id: requestId, p_actor: actorId, p_note: note });
    return { status: str(row.status) };
  }
}
