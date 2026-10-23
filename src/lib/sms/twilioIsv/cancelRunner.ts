import { createHash } from "node:crypto";
import type { NumberReleaseAdapter, ProviderPresence, ProvisioningReleaseAdapter, ReleaseResult } from "./releaseTypes";
import { IsvApiError } from "./types";

/**
 * TW-4F F5: the controlled-cancellation runner. It drives ONE authorized cancellation operation through
 *
 *   preconditions (database read + one FREE provider read: the resource must be present) -> tw4_rfl_cancel_begin (the single claim) -> re-read of the target
 *   (unchanged, or recorded unknown with no call) -> ONE provider release -> a provider read -> tw4_rfl_cancel_finish
 *
 * and nothing else. Rules, in order of importance:
 *  1. No RELEASE reaches the provider unless the database answered `execute` to THIS call (the only earlier provider call is one free presence read). `in_progress`, `reconcile` and `skip` are reported, never acted on.
 *  2. The release is attempted at most once per claim and is NEVER repeated by this code: a lost response, a timeout, a 429/5xx or a read-back that still
 *     shows the resource is recorded as `unknown` (the database then answers `reconcile` to every later begin, and only an administrator's provider lookup
 *     resolves it through tw4_rfl_cancel_resolve).
 *  3. A phone number is released only when the operation carries a CONSUMED dual-control approval by two DISTINCT platform administrators; this is
 *     checked from the target read BEFORE the claim, so a refusal leaves the operation untouched and nothing is called.
 *  4. `confirmed` is recorded only with the digest of a provider READ showing the resource absent; `refused` only for a definite provider refusal (a
 *     parseable 4xx other than 404/408/429) and always with the code `api`, as tw4_rfl_cancel_finish requires.
 *  5. If the provider acted but the database write failed, the outcome and digest are returned (`record_failed`) so the operator records them by hand;
 *     the operation stays claimed and nothing is retried.
 *
 * This module does no I/O of its own: the ledger, the target source and the adapters are injected (`buildCancelRunner`). It never builds a real adapter.
 */

export type CancelKind = "messaging_service" | "campaign" | "number";

/** The dual-control approval the database consumed when it authorized THIS operation (numbers only). */
export type CancelDualControl = { requestId: string; resourceId: string; requestedBy: string; decidedBy: string; status: string };

/** What the database knows about the operation and its resource. Read-only; produced by the target source. */
export type CancelTarget = {
  operationId: string;
  resourceId: string;
  operationStatus: string;
  kind: CancelKind;
  providerSid: string;
  /** The business's subaccount the resource lives in (immutable on the resource row). */
  accountSid: string;
  /** Campaign only: the Messaging Service the campaign is registered on (Twilio's delete path needs it). */
  messagingServiceSid: string | null;
  /** Messaging Service only: other LIVE resources of the location that deleting the service would take down with it (its campaign). */
  liveDependents: number;
  dualControl: CancelDualControl | null;
};

export interface CancelTargetSource {
  /** null = the target cannot be read (not installed, unknown operation, not allowed): the runner then refuses without claiming anything. */
  target(operationId: string, actorId: string): Promise<CancelTarget | null>;
}

export type CancelBeginResult = { action: "execute"; providerSid: string; resourceKind: CancelKind } | { action: "in_progress" } | { action: "reconcile" } | { action: "skip"; status: string };

/** The tw4_rfl_cancel_begin / _finish wrappers (ProviderFeeLifecycleStore satisfies this). */
export interface CancelLedger {
  beginCancel(operationId: string, actorId: string): Promise<CancelBeginResult>;
  finishCancel(operationId: string, outcome: "confirmed" | "refused" | "unknown", evidenceDigest: string | null, errorCode: string | null, actorId: string): Promise<{ status: string; replayed: boolean }>;
}

export type ReleaseAdapters = { numbers: NumberReleaseAdapter | null; provisioning: ProvisioningReleaseAdapter | null };

export type CancelRunnerDeps = {
  ledger: CancelLedger;
  targets: CancelTargetSource;
  /** Release adapters for ONE subaccount. The caller builds them behind their gates (real) or from the local fakes; the runner never constructs one. */
  adaptersFor(accountSid: string): Promise<ReleaseAdapters>;
  now?: () => Date;
};

export type CancelRunOutcome =
  /** Nothing was claimed and nothing was called. */
  | { result: "precondition_refused"; reason: string }
  | { result: "in_progress" }
  | { result: "reconcile" }
  | { result: "skip"; status: string }
  | { result: "confirmed"; status: string; release: ReleaseResult; evidenceDigest: string }
  | { result: "refused"; status: string }
  | { result: "unknown"; status: string; errorCode: string }
  /** The provider step happened (or may have) but recording it failed: the operation stays claimed; record this by hand. */
  | { result: "record_failed"; outcome: "confirmed" | "refused" | "unknown"; evidenceDigest: string | null; errorCode: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^AC[0-9a-fA-F]{32}$/;
const MG = /^MG[0-9a-fA-F]{32}$/;
const SID_BY_KIND: Record<CancelKind, RegExp> = { messaging_service: MG, campaign: /^QE[0-9a-fA-F]{32}$/, number: /^PN[0-9a-fA-F]{32}$/ };

export const CANCEL_EVIDENCE_SCHEMA = "tw4f-f5-cancel-evidence/1";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The digest recorded with a confirmed cancellation: what was released, in which account, what the provider read showed, and when. */
export function cancelEvidenceDigest(evidence: {
  operationId: string; resourceId: string; kind: CancelKind; providerSid: string; accountSid: string; release: ReleaseResult; readback: ProviderPresence;
  evidenceSource: "provider_read" | "fake"; observedAt: string;
}): string {
  return createHash("sha256").update(canonical({ schema: CANCEL_EVIDENCE_SCHEMA, ...evidence })).digest("hex");
}

/** Is a thrown provider error a DEFINITE refusal (Twilio answered and did nothing)? Anything else is an unknown outcome. */
export function isDefiniteRefusal(error: unknown): boolean {
  if (!(error instanceof IsvApiError)) return false;
  if (error.kind !== "validation" && error.kind !== "account") return false;
  const status = error.httpStatus;
  // a 404 that is not Twilio's 20404 (handled by the adapter as already_absent) is not an answer about this resource; 408/429 are not answers at all
  return status !== null && status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 429;
}

/** A short, value-free error code for the ledger (never request data). */
function errorCodeFor(error: unknown, stage: "release" | "readback"): string {
  if (error instanceof IsvApiError) return `${stage}_${error.kind}${error.httpStatus ? `_${error.httpStatus}` : ""}`.slice(0, 64);
  return `${stage}_unexpected`;
}

/** Why a target is not safe to act on, or null. Pure; exported for tests. */
export function targetRefusal(target: CancelTarget): string | null {
  if (!UUID.test(target.operationId) || !UUID.test(target.resourceId)) return "The cancellation target is malformed.";
  if (!(target.kind in SID_BY_KIND) || !SID_BY_KIND[target.kind].test(target.providerSid)) return "The resource's provider id does not match its kind.";
  if (!ACCOUNT.test(target.accountSid)) return "The resource's Twilio account is not recorded.";
  if (target.operationStatus !== "authorized") return `The operation is ${target.operationStatus}, not authorized: nothing is released.`;
  if (target.kind === "campaign" && !(target.messagingServiceSid && MG.test(target.messagingServiceSid))) return "The campaign's Messaging Service is not recorded.";
  if (target.kind === "messaging_service" && target.liveDependents !== 0) return "Deleting this Messaging Service would also delete a live campaign: cancel the campaign first.";
  if (target.kind === "number") {
    const dual = target.dualControl;
    // two DISTINCT platform administrators, and the approval already consumed by this operation's authorization
    if (!dual || dual.status !== "consumed" || dual.resourceId !== target.resourceId || !UUID.test(dual.requestId) || !UUID.test(dual.requestedBy) || !UUID.test(dual.decidedBy)
      || dual.requestedBy.toLowerCase() === dual.decidedBy.toLowerCase()) {
      return "A number is released only with a consumed dual-control approval by two different platform administrators.";
    }
  }
  return null;
}

export class CancelRunner {
  constructor(private readonly deps: CancelRunnerDeps) {}

  async run(rawOperationId: string, rawActorId: string): Promise<CancelRunOutcome> {
    const { ledger, targets } = this.deps;
    // the database returns lowercase ids: compare like with like
    const operationId = rawOperationId.toLowerCase();
    const actorId = rawActorId.toLowerCase();
    if (!UUID.test(operationId) || !UUID.test(actorId)) return { result: "precondition_refused", reason: "Malformed operation or administrator id." };

    // ---- preconditions: read only; a refusal here claims nothing and calls nothing ----
    let target: CancelTarget | null;
    try {
      target = await targets.target(operationId, actorId);
    } catch {
      target = null;
    }
    if (!target || target.operationId !== operationId) return { result: "precondition_refused", reason: "The cancellation target could not be read." };
    if (target.operationStatus === "in_flight") return { result: "in_progress" };
    if (target.operationStatus === "unknown_outcome") return { result: "reconcile" };
    const refusal = targetRefusal(target);
    if (refusal) return { result: "precondition_refused", reason: refusal };

    let adapters: ReleaseAdapters;
    try {
      adapters = await this.deps.adaptersFor(target.accountSid);
    } catch {
      return { result: "precondition_refused", reason: "No provider release adapter is available for this account." };
    }
    const adapter = target.kind === "number" ? adapters.numbers : adapters.provisioning;
    if (!adapter) return { result: "precondition_refused", reason: "No provider release adapter is available for this kind of resource." };
    if (adapter.accountSid !== target.accountSid) return { result: "precondition_refused", reason: "The release adapter is not for the resource's account." };

    // ---- a FREE pre-claim read: the resource must be visible to these credentials, in this account, at this path ----
    // (a stale Messaging Service SID or another subaccount's credentials answer 20404 everywhere: without this, "already gone" + "absent" would confirm a
    // cancellation that never happened while the provider keeps billing; it also keeps a rejected credential from consuming the written authorization)
    try {
      if ((await this.presence(target, adapters)) !== "present") {
        return { result: "precondition_refused", reason: "The provider does not show this resource in its account: look it up in the Twilio console and resolve by hand." };
      }
      // deleting a service deletes every campaign on it, including ones the inventory does not know (an unknown-outcome create, a console campaign)
      if (target.kind === "messaging_service" && (await adapters.provisioning!.findCampaigns(target.providerSid)).length !== 0) {
        return { result: "precondition_refused", reason: "The provider shows a campaign on this Messaging Service: cancel the campaign first." };
      }
    } catch {
      return { result: "precondition_refused", reason: "The provider could not be read before the release." };
    }

    // ---- the single claim ----
    const begin = await ledger.beginCancel(operationId, actorId);   // a database refusal propagates: nothing was called
    if (begin.action === "in_progress") return { result: "in_progress" };
    if (begin.action === "reconcile") return { result: "reconcile" };
    if (begin.action === "skip") return { result: "skip", status: begin.status };
    if (begin.providerSid !== target.providerSid || begin.resourceKind !== target.kind) {
      // claimed, but not about what was checked: nothing is called; the operator looks it up and resolves
      return this.record(operationId, actorId, "unknown", null, "no_call_target_mismatch");
    }
    // the facts checked before the claim must still hold after it (a campaign registered meanwhile would be deleted with its service)
    let after: CancelTarget | null;
    try {
      after = await targets.target(operationId, actorId);
    } catch {
      after = null;
    }
    const recheck = after ? targetRefusal({ ...after, operationStatus: "authorized" }) : "unreadable";
    if (!after || recheck || after.kind !== target.kind || after.providerSid !== target.providerSid || after.accountSid !== target.accountSid
      || after.messagingServiceSid !== target.messagingServiceSid || after.operationStatus !== "in_flight") {
      return this.record(operationId, actorId, "unknown", null, "no_call_recheck_failed");
    }
    if (target.kind === "messaging_service") {
      let campaigns: string[] | null;
      try {
        campaigns = await adapters.provisioning!.findCampaigns(target.providerSid);
      } catch {
        campaigns = null;
      }
      if (campaigns === null || campaigns.length !== 0) return this.record(operationId, actorId, "unknown", null, "no_call_recheck_failed");
    }

    // ---- ONE provider release (never repeated here) ----
    let release: ReleaseResult;
    try {
      release = await this.release(target, adapters);
    } catch (error) {
      if (isDefiniteRefusal(error)) return this.record(operationId, actorId, "refused", null, "api");
      return this.record(operationId, actorId, "unknown", null, errorCodeFor(error, "release"));
    }

    // ---- the provider read that the evidence is made of ----
    let presence: ProviderPresence;
    try {
      presence = await this.presence(target, adapters);
    } catch (error) {
      return this.record(operationId, actorId, "unknown", null, errorCodeFor(error, "readback"));
    }
    if (presence !== "absent") return this.record(operationId, actorId, "unknown", null, "readback_present");
    const digest = cancelEvidenceDigest({
      operationId, resourceId: target.resourceId, kind: target.kind, providerSid: target.providerSid, accountSid: target.accountSid, release, readback: presence,
      evidenceSource: adapter.evidenceSource, observedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
    const recorded = await this.record(operationId, actorId, "confirmed", digest, null);
    return recorded.result === "confirmed" ? { ...recorded, release } : recorded;
  }

  private release(target: CancelTarget, adapters: ReleaseAdapters): Promise<ReleaseResult> {
    if (target.kind === "number") return adapters.numbers!.releaseNumber(target.providerSid);
    if (target.kind === "campaign") return adapters.provisioning!.deleteCampaign({ messagingServiceSid: target.messagingServiceSid!, campaignSid: target.providerSid });
    return adapters.provisioning!.deleteMessagingService(target.providerSid);
  }

  private presence(target: CancelTarget, adapters: ReleaseAdapters): Promise<ProviderPresence> {
    if (target.kind === "number") return adapters.numbers!.numberPresence(target.providerSid);
    if (target.kind === "campaign") return adapters.provisioning!.campaignPresence({ messagingServiceSid: target.messagingServiceSid!, campaignSid: target.providerSid });
    return adapters.provisioning!.servicePresence(target.providerSid);
  }

  private async record(operationId: string, actorId: string, outcome: "confirmed" | "refused" | "unknown", digest: string | null, errorCode: string | null): Promise<CancelRunOutcome> {
    let status: string;
    try {
      status = (await this.deps.ledger.finishCancel(operationId, outcome, digest, errorCode, actorId)).status;
    } catch {
      return { result: "record_failed", outcome, evidenceDigest: digest, errorCode };
    }
    if (outcome === "confirmed") return { result: "confirmed", status, release: "released", evidenceDigest: digest! };
    if (outcome === "refused") return { result: "refused", status };
    return { result: "unknown", status, errorCode: errorCode ?? "unknown" };
  }
}

/**
 * THE BUILDER (for J1's factory): `buildCancelRunner({ ledger, targets, adaptersFor })`.
 *  - ledger:      new ProviderFeeLifecycleStore(createAdminClient())  (tw4_rfl_cancel_begin / _finish)
 *  - targets:     a CancelTargetSource (see cancelRuntime.ts)
 *  - adaptersFor: (accountSid) => ({ numbers: createScopedNumberAdapter(...) | null, provisioning: createScopedProvisioningAdapter(...) | null }),
 *                 built with that subaccount's own credentials behind numberCallsAllowed / provisioningCallsAllowed. Return null for a kind that is gated off.
 */
export function buildCancelRunner(deps: CancelRunnerDeps): CancelRunner {
  return new CancelRunner(deps);
}
