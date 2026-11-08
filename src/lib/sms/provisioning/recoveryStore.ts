import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * TW-4F F4: a thin, typed, SERVER-ONLY wrapper around the platform-administrator recovery functions of 20261221090000 (consolidated exposure, registration
 * gaps and the audited retry, deferred number retirements) and R2b's number-ledger read (`tw4_num_status`). It adds no authorization and no financial logic:
 * every function re-checks the platform-admin actor and owns its rules. The CALLER (a page or server action that already ran `requirePlatformAdmin`) supplies
 * the actor id from the session. It takes a service-role client, so it must never be imported by client code.
 *
 * Parsing is strict and fail-closed: an answer that is not the documented shape throws. A cost the database reports as unknown stays `null`; nothing here
 * turns a missing amount into zero.
 */

type Client = Pick<SupabaseClient, "rpc">;

export class RecoveryError extends Error {
  constructor(public readonly code: string) {
    super(`recovery call failed (${code})`);
    this.name = "RecoveryError";
  }
}

export const RECOVERY_FLASH_COOKIE = "tw4_recovery_flash";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
/** A cents amount the database reported, or null when it did not (unknown is never zero). */
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const arr = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new RecoveryError("unexpected_shape");
  return v;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// consolidated exposure
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type ExposureCost = {
  basis: "unknown" | "recorded" | "none_open" | string;
  known: boolean;
  providerBilledCents: number | null;
  expectedProviderCentsEstimate: number | null;
  openExposurePeriods: number | null;
  inRflExposureReport: boolean;
};

export type ExposureResource = {
  providerSid: string;
  resourceKind: string;
  legalEntityId: string | null;
  studioId: string | null;
  since: string | null;
  ageDays: number;
  findings: { finding: string; status: string | null; since: string | null }[];
  rflProviderState: string | null;
  /** "danceflow" unless the database says the resource is a studio's own lifecycle-billed resource. */
  costBearer: "danceflow" | "lifecycle";
  cost: ExposureCost;
};

export type ExposureView = {
  resources: ExposureResource[];
  aggregate: {
    resources: number;
    campaigns: number;
    numbers: number;
    costUnknown: number;
    costRecorded: number;
    inRflExposureReport: number;
    providerBilledCents: number | null;
    expectedProviderCentsEstimate: number | null;
  };
};

export function parseExposure(raw: unknown): ExposureView {
  const o = obj(raw);
  const agg = o ? obj(o.aggregate) : null;
  if (!o || !agg) throw new RecoveryError("unexpected_shape");
  const resources = arr(o.resources).map((entry): ExposureResource => {
    const r = obj(entry);
    const providerSid = r ? str(r.provider_sid) : null;
    const resourceKind = r ? str(r.resource_kind) : null;
    const cost = r ? obj(r.cost) : null;
    if (!r || !providerSid || !resourceKind || !cost || typeof cost.known !== "boolean") throw new RecoveryError("unexpected_shape");
    const known = cost.known === true;
    return {
      providerSid,
      resourceKind,
      legalEntityId: str(r.legal_entity_id),
      studioId: str(r.studio_id),
      since: str(r.since),
      ageDays: int(r.age_days),
      findings: arr(r.findings).map((f) => {
        const x = obj(f);
        const finding = x ? str(x.finding) : null;
        if (!x || !finding) throw new RecoveryError("unexpected_shape");
        return { finding, status: str(x.status), since: str(x.since) };
      }),
      rflProviderState: str(r.rfl_provider_state),
      costBearer: r.cost_bearer === "lifecycle" ? "lifecycle" : "danceflow",
      cost: {
        basis: str(cost.basis) ?? "unknown",
        known,
        // an amount is shown only when the database says the cost is known
        providerBilledCents: known ? cents(cost.provider_billed_cents) : null,
        expectedProviderCentsEstimate: known ? cents(cost.expected_provider_cents_estimate) : null,
        openExposurePeriods: known ? cents(cost.open_exposure_periods) : null,
        inRflExposureReport: cost.in_rfl_exposure_report === true,
      },
    };
  });
  return {
    resources,
    aggregate: {
      resources: int(agg.resources),
      campaigns: int(agg.campaigns),
      numbers: int(agg.numbers),
      costUnknown: int(agg.cost_unknown),
      costRecorded: int(agg.cost_recorded),
      inRflExposureReport: int(agg.in_rfl_exposure_report),
      providerBilledCents: cents(agg.provider_billed_cents),
      expectedProviderCentsEstimate: cents(agg.expected_provider_cents_estimate),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// registration gaps
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type RegistrationKind = "number" | "campaign";

export type RegistrationGap = {
  kind: RegistrationKind;
  studioId: string;
  legalEntityId: string | null;
  operationId: string;
  providerSid: string | null;
  e164: string | null;
  observedAt: string | null;
  lastFailureAt: string | null;
  lastRetry: { at: string | null; by: string | null; outcome: string | null; code: string | null } | null;
};

export function parseGaps(raw: unknown): RegistrationGap[] {
  return arr(raw).map((entry): RegistrationGap => {
    const g = obj(entry);
    const kind = g ? str(g.kind) : null;
    const studioId = g ? str(g.studio_id) : null;
    const operationId = g ? str(g.operation_id) : null;
    if (!g || (kind !== "number" && kind !== "campaign") || !studioId || !operationId) throw new RecoveryError("unexpected_shape");
    const retry = obj(g.last_retry);
    return {
      kind,
      studioId,
      legalEntityId: str(g.legal_entity_id),
      operationId,
      providerSid: str(g.provider_sid),
      e164: str(g.e164),
      observedAt: str(g.observed_at),
      lastFailureAt: str(g.last_failure_at),
      lastRetry: retry ? { at: str(retry.at), by: str(retry.by), outcome: str(retry.outcome), code: str(retry.code) } : null,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// deferred retirements
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type DeferredRetirement = {
  studioId: string;
  legalEntityId: string | null;
  phoneNumberSid: string;
  e164: string | null;
  cancelledAt: string | null;
  operations: number;
  senderStatus: string | null;
  blockers: { leaseHeld: boolean; operationUnresolved: boolean; senderReleaseRequired: boolean };
  ready: boolean;
};

export function parseDeferred(raw: unknown): DeferredRetirement[] {
  return arr(raw).map((entry): DeferredRetirement => {
    const d = obj(entry);
    const studioId = d ? str(d.studio_id) : null;
    const phoneNumberSid = d ? str(d.phone_number_sid) : null;
    const b = d ? obj(d.blockers) : null;
    if (!d || !studioId || !phoneNumberSid || !b) throw new RecoveryError("unexpected_shape");
    const blockers = { leaseHeld: b.lease_held !== false, operationUnresolved: b.operation_unresolved !== false, senderReleaseRequired: b.sender_release_required !== false };
    return {
      studioId,
      legalEntityId: str(d.legal_entity_id),
      phoneNumberSid,
      e164: str(d.e164),
      cancelledAt: str(d.cancelled_at),
      operations: Array.isArray(d.operations) ? d.operations.length : 0,
      senderStatus: str(d.sender_status),
      blockers,
      // ready only when the database says so AND no blocker is reported (an unreadable blocker counts as present)
      ready: d.ready === true && !blockers.leaseHeld && !blockers.operationUnresolved && !blockers.senderReleaseRequired,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// number ledger (R2b tw4_num_status)
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type NumberOperationView = {
  id: string;
  kind: string;
  status: string;
  attempt: number | null;
  providerSid: string | null;
  e164: string | null;
  feeBearing: boolean;
  errorCode: string | null;
  errorDetail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  superseded: boolean;
  resolved: boolean;
  resolutionNote: string | null;
  resource: { status: string | null; mismatchCode: string | null; observedAt: string | null; source: string | null } | null;
};

export type NumberLedgerSnapshot = { onboardingId: string; state: string; step: string | null; lastErrorCode: string | null; leased: boolean; operations: NumberOperationView[] };

/** null = the studio has no live onboarding. Anything else that is not the documented shape throws. */
export function parseNumberLedger(raw: unknown): NumberLedgerSnapshot | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw);
  const onboardingId = o ? str(o.onboarding_id) : null;
  const state = o ? str(o.state) : null;
  if (!o || !onboardingId || !state) throw new RecoveryError("unexpected_shape");
  const operations = arr(o.operations).map((entry): NumberOperationView => {
    const p = obj(entry);
    const id = p ? str(p.id) : null;
    const kind = p ? str(p.kind) : null;
    const status = p ? str(p.status) : null;
    if (!p || !id || !kind || !status) throw new RecoveryError("unexpected_shape");
    const r = obj(p.resource);
    return {
      id,
      kind,
      status,
      attempt: typeof p.attempt === "number" ? p.attempt : null,
      providerSid: str(p.provider_sid),
      e164: str(p.e164),
      feeBearing: p.fee_bearing === true,
      errorCode: str(p.error_code),
      errorDetail: str(p.error_detail),
      startedAt: str(p.started_at),
      finishedAt: str(p.finished_at),
      superseded: p.superseded === true,
      resolved: str(p.resolved_by) !== null,
      resolutionNote: str(p.resolution_note),
      resource: r ? { status: str(r.status), mismatchCode: str(r.mismatch_code), observedAt: str(r.observed_at), source: str(r.source) } : null,
    };
  });
  return { onboardingId, state, step: str(o.step), lastErrorCode: str(o.last_error_code), leased: o.leased === true, operations };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------------------------------------------------------
export type RetryOutcome = { outcome: "registered" | "already_registered" | "refused"; code: string | null };

export class RecoveryStore {
  constructor(private readonly admin: Client) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RecoveryError(String(error.code ?? "unknown"));
    return data;
  }

  async exposure(actorId: string): Promise<ExposureView> {
    return parseExposure(await this.call("tw4_admin_exposure", { p_actor: actorId, p_legal_entity_id: null }));
  }

  async gaps(actorId: string): Promise<RegistrationGap[]> {
    return parseGaps(await this.call("tw4_admin_registration_gaps", { p_actor: actorId }));
  }

  async deferred(actorId: string): Promise<DeferredRetirement[]> {
    return parseDeferred(await this.call("tw4_admin_deferred_retirements", { p_actor: actorId }));
  }

  async numberLedger(studioId: string, actorId: string): Promise<NumberLedgerSnapshot | null> {
    return parseNumberLedger(await this.call("tw4_num_status", { p_studio_id: studioId, p_actor: actorId }));
  }

  async retryRegistration(studioId: string, actorId: string, kind: RegistrationKind, note: string): Promise<RetryOutcome> {
    const o = obj(await this.call("tw4_admin_registration_retry", { p_studio_id: studioId, p_actor: actorId, p_kind: kind, p_note: note }));
    const outcome = o ? str(o.outcome) : null;
    if (!o || (outcome !== "registered" && outcome !== "already_registered" && outcome !== "refused")) throw new RecoveryError("unexpected_shape");
    return { outcome, code: str(o.code) };
  }

  async retireDeferred(studioId: string, phoneNumberSid: string, actorId: string, note: string): Promise<{ retired: boolean }> {
    const o = obj(await this.call("tw4_admin_deferred_retire", { p_studio_id: studioId, p_phone_number_sid: phoneNumberSid, p_actor: actorId, p_note: note }));
    if (!o || typeof o.retired !== "boolean") throw new RecoveryError("unexpected_shape");
    return { retired: o.retired };
  }
}

export type Loaded<T> = T | "unavailable";

export type RecoveryOverview = {
  exposure: Loaded<ExposureView>;
  gaps: Loaded<RegistrationGap[]>;
  deferred: Loaded<DeferredRetirement[]>;
  numberLedgers: Record<string, NumberLedgerSnapshot | "unreadable" | "none">;
};

/** Every read degrades on its own to "unavailable" (never to an empty list: an unreadable gap list must not look like "no gaps"). */
export async function loadRecoveryOverview(store: RecoveryStore, actorId: string, numberLedgerStudioIds: string[]): Promise<RecoveryOverview> {
  const settle = async <T,>(work: () => Promise<T>): Promise<Loaded<T>> => {
    try {
      return await work();
    } catch {
      return "unavailable";
    }
  };
  const [exposure, gaps, deferred] = await Promise.all([settle(() => store.exposure(actorId)), settle(() => store.gaps(actorId)), settle(() => store.deferred(actorId))]);
  const numberLedgers: RecoveryOverview["numberLedgers"] = {};
  await Promise.all(
    numberLedgerStudioIds.map(async (studioId) => {
      try {
        numberLedgers[studioId] = (await store.numberLedger(studioId, actorId)) ?? "none";
      } catch {
        numberLedgers[studioId] = "unreadable";
      }
    }),
  );
  return { exposure, gaps, deferred, numberLedgers };
}
