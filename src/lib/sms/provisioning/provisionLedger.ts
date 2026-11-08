import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ProvisioningOperationView } from "./adminView";

/**
 * TW-4F R2c-I1: a thin, typed, SERVER-ONLY wrapper around R2a's platform-admin ledger functions (`tw4_prov_status`, `tw4_prov_resolve`,
 * `tw4_prov_reopen`). It adds no authorization of its own and no financial logic: the database re-checks the platform-admin actor in every function and
 * owns the reservation, capture and release rules. The CALLER (a server action or page that has already run `requirePlatformAdmin`) supplies the actor id
 * it derived from the session; nothing here reads an identity from a browser. It takes a service-role client, so it must never be imported by client code.
 *
 * Parsing is strict and fail-closed: an answer that is not the documented shape throws, and an unrecognized operation status is kept as such (never mapped
 * to a friendly "failed" or "succeeded").
 */

type Client = Pick<SupabaseClient, "rpc">;

export class LedgerError extends Error {
  constructor(public readonly code: string) {
    super(`provisioning ledger call failed (${code})`);
    this.name = "LedgerError";
  }
}

export type LedgerSnapshot = {
  onboardingId: string;
  state: string;
  step: string | null;
  lastErrorCode: string | null;
  leased: boolean;
  windowOpen: boolean;
  operations: ProvisioningOperationView[];
  /** TW-4F F4: evidence status of each unresolved fee-bearing campaign attempt, by operation id ("unavailable" when it could not be read). Absent when not loaded. */
  evidence?: Record<string, EvidenceStatus> | "unavailable";
};

/** What the recorded provider listings prove for one unresolved fee-bearing campaign attempt (tw4_admin_prov_proof). Read only: it releases nothing. */
export type EvidenceStatus = {
  operationId: string;
  listings: number;
  latestVerdict: string | null;
  latestObservedAt: string | null;
  latestSource: string | null;
  proofOk: boolean;
  proofReason: string;
  pilot: boolean;
  /** The database's evidence rule would accept a "not created" resolution. Release still stays off in the application while FEE_RELEASE_ENABLED is false. */
  releasePermittedByEvidence: boolean;
};

export type LedgerResolution = "created" | "not_created";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** null = the studio has no live onboarding. Anything else that is not the documented shape throws. */
export function parseLedger(raw: unknown): LedgerSnapshot | null {
  if (raw === null || raw === undefined) return null;
  const o = obj(raw);
  const id = o ? str(o.onboarding_id) : null;
  const state = o ? str(o.state) : null;
  if (!o || !id || !state || !Array.isArray(o.operations)) throw new LedgerError("unexpected_shape");
  const operations = o.operations.map((entry): ProvisioningOperationView => {
    const p = obj(entry);
    const opId = p ? str(p.id) : null;
    const kind = p ? str(p.kind) : null;
    const status = p ? str(p.status) : null;
    if (!p || !opId || !kind || !status) throw new LedgerError("unexpected_shape");
    const resource = obj(p.resource);
    return {
      id: opId,
      kind,
      status,
      feeBearing: p.fee_bearing === true,
      attemptedAt: str(p.started_at),
      errorCode: str(p.error_code),
      attempt: typeof p.attempt === "number" ? p.attempt : null,
      providerSid: str(p.provider_sid),
      feeKinds: Array.isArray(p.fee_kinds) ? p.fee_kinds.filter((k): k is string => typeof k === "string") : [],
      errorDetail: str(p.error_detail),
      finishedAt: str(p.finished_at),
      superseded: p.superseded === true,
      resolutionNote: str(p.resolution_note),
      resolved: str(p.resolved_by) !== null,
      resource: resource
        ? { status: str(resource.status), mismatchCode: str(resource.mismatch_code), providerStatus: str(resource.provider_status), failureReasons: str(resource.failure_reasons), observedAt: str(resource.observed_at), source: str(resource.source) }
        : null,
    };
  });
  return { onboardingId: id, state, step: str(o.step), lastErrorCode: str(o.last_error_code), leased: o.leased === true, windowOpen: o.window_open === true, operations };
}

/** Fail-closed: anything but the documented shape throws; a proof the database did not explicitly accept is never reported as accepted. */
export function parseEvidence(raw: unknown): Record<string, EvidenceStatus> {
  if (!Array.isArray(raw)) throw new LedgerError("unexpected_shape");
  const out: Record<string, EvidenceStatus> = {};
  for (const entry of raw) {
    const p = obj(entry);
    const operationId = p ? str(p.operation_id) : null;
    const proof = p ? obj(p.proof) : null;
    if (!p || !operationId || !proof) throw new LedgerError("unexpected_shape");
    const latest = obj(p.latest);
    const pilot = p.pilot !== false;
    const proofOk = proof.ok === true;
    out[operationId] = {
      operationId,
      listings: typeof p.listings === "number" ? p.listings : 0,
      latestVerdict: latest ? str(latest.verdict) : null,
      latestObservedAt: latest ? str(latest.observed_at) : null,
      latestSource: latest ? str(latest.source) : null,
      proofOk,
      proofReason: str(proof.reason) ?? "unknown",
      pilot,
      releasePermittedByEvidence: p.release_permitted_by_evidence === true && proofOk && !pilot,
    };
  }
  return out;
}

/**
 * Releasing a held fee by declaring a fee-bearing operation "not created". The backend now refuses it without provider-backed proof of absence (two spaced,
 * complete listings, 20261212), and the evidence console (F4) records and shows that proof; lifting this switch is still the owner's decision (U-1). Until
 * then it stays OFF. Typed as boolean so the guard is a real runtime check, not dead code.
 */
export const FEE_RELEASE_ENABLED: boolean = false;

export class ProvisioningLedgerStore {
  constructor(private readonly admin: Client) {}

  private async call(fn: string, args: Record<string, unknown>): Promise<unknown> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new LedgerError(String(error.code ?? "unknown"));
    return data;
  }

  async status(studioId: string, actorId: string): Promise<LedgerSnapshot | null> {
    return parseLedger(await this.call("tw4_prov_status", { p_studio_id: studioId, p_actor: actorId }));
  }

  /**
   * Closes an unknown outcome. The database owns every rule (time windows, SID shape, lease, reservations); this forwards, after TWO server-side checks that
   * do not depend on any UI or on the calling command: the operation must be in the named studio's ledger as the database reports it now, and while
   * `FEE_RELEASE_ENABLED` is false a FEE-BEARING operation can never be resolved as "not created". That choice releases a held fee on an administrator's word
   * alone (R2a has no provider-backed proof of absence), so it stays off here until a separate backend hardening slice supplies one.
   */
  async resolve(args: { studioId: string; operationId: string; actorId: string; resolution: LedgerResolution; providerSid: string | null; note: string }): Promise<void> {
    const ledger = await this.status(args.studioId, args.actorId);
    const op = ledger?.operations.find((o) => o.id === args.operationId);
    if (!ledger || !op) throw new LedgerError("not_in_ledger");
    if (op.feeBearing && args.resolution === "not_created" && !FEE_RELEASE_ENABLED) throw new LedgerError("fee_release_disabled");
    await this.call("tw4_prov_resolve", { p_operation_id: args.operationId, p_actor: args.actorId, p_resolution: args.resolution, p_provider_sid: args.providerSid, p_note: args.note });
  }

  async reopen(studioId: string, actorId: string, reason: string): Promise<void> {
    await this.call("tw4_prov_reopen", { p_studio_id: studioId, p_actor: actorId, p_reason: reason });
  }

  /** TW-4F F4: evidence status of the studio's unresolved fee-bearing campaign attempts (platform admin; read only). */
  async evidence(studioId: string, actorId: string): Promise<Record<string, EvidenceStatus>> {
    return parseEvidence(await this.call("tw4_admin_prov_proof", { p_studio_id: studioId, p_actor: actorId }));
  }
}

const needsEvidence = (snap: LedgerSnapshot) => snap.operations.some((o) => o.kind === "campaign" && o.feeBearing && !o.superseded && (o.status === "unknown_outcome" || o.status === "in_flight"));

/** Ledger for many studios. "none" = the studio has no live onboarding; a read that fails is "unreadable", never an empty list: an unreadable ledger must not look like "no operations". A studio that was not queried has no key. */
export async function loadLedgers(store: ProvisioningLedgerStore, actorId: string, studioIds: string[]): Promise<Record<string, LedgerSnapshot | "unreadable" | "none">> {
  const out: Record<string, LedgerSnapshot | "unreadable" | "none"> = {};
  await Promise.all(
    studioIds.map(async (studioId) => {
      try {
        const snap = await store.status(studioId, actorId);
        if (snap && needsEvidence(snap)) {
          // the evidence read is optional: if it fails, the ledger still shows and the console says the evidence is unavailable (never "no evidence")
          snap.evidence = await store.evidence(studioId, actorId).catch((): "unavailable" => "unavailable");
        }
        out[studioId] = snap ?? "none";
      } catch {
        out[studioId] = "unreadable";
      }
    }),
  );
  return out;
}
