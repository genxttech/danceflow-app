import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { ProviderFeeLifecycleStore } from "@/lib/sms/providerFeeLifecycle";
import { buildCancelRunner, type CancelKind, type CancelRunner, type CancelTarget, type CancelTargetSource, type ReleaseAdapters } from "./cancelRunner";
import { fakeAdapterAllowed, numberCallsAllowed, provisioningCallsAllowed } from "./config";
import type { NumberReleaseAdapter, ProvisioningReleaseAdapter } from "./releaseTypes";
import { buildSubaccountAdaptersFor } from "./factory";

/**
 * TW-4F F5: decides whether the platform panel may offer "Release at Twilio now" for an authorized cancellation, and builds the runner when it may.
 * SERVER ONLY. Provider release is available only when ALL of these hold; otherwise the panel keeps the manual path (the administrator performs the
 * console step and records the evidence), exactly as before F5:
 *   1. TW4_CANCEL_RELEASE=on (an explicit switch for an IRREVERSIBLE provider action; off by default everywhere);
 *   2. a cancellation target source (tw4_rfl_cancel_target, migration 20261224090000: the operation's subaccount, Messaging Service and consumed dual-control approval);
 *      where that read is not applied every target reads as missing, and the runner refuses before any claim;
 *   3. an adapter path: on a LOCAL QA database with TW4_ISV_FAKE=on, the platform runtime's fakes (`buildSubaccountAdaptersFor`, factory.ts: the same
 *      process-wide fakes that provisioned the resources); the REAL adapters only when a caller supplies them (`realAdaptersFor`, e.g. J1's
 *      `buildSubaccountAdaptersFor(env)`) and provisioningCallsAllowed holds, so production stays manual until that wiring is switched on.
 */

type Env = Record<string, string | undefined>;

export type CancelReleaseRuntime = { ok: true; mode: "fake" | "real"; runner: CancelRunner } | { ok: false; reason: string };

/** What a subaccount builder hands out (J1's `buildSubaccountAdaptersFor` returns the provisioning interfaces; the same objects carry the release methods). */
export type SubaccountAdapters = { numbers: unknown; provisioning: unknown };

const isFn = (o: Record<string, unknown>, name: string) => typeof o[name] === "function";
const NUMBER_RELEASE = ["releaseNumber", "detachNumber", "numberPresence"];
const PROVISIONING_RELEASE = ["deleteCampaign", "deleteMessagingService", "campaignPresence", "servicePresence", "findCampaigns"];

function releaseCapable(adapter: unknown, methods: string[]): boolean {
  if (!adapter || typeof adapter !== "object") return false;
  // property reads, not `in`: the rotation wrapper (rotation.ts) is a Proxy with a get trap only, and answers `in` with false
  const o = adapter as Record<string, unknown>;
  return typeof o.accountSid === "string" && (o.evidenceSource === "provider_read" || o.evidenceSource === "fake") && methods.every((m) => isFn(o, m));
}

/** Narrows a subaccount builder's adapters to the release interfaces; anything that cannot release reads as null (fail closed: the runner refuses). */
export function asReleaseAdapters(built: SubaccountAdapters): ReleaseAdapters {
  return {
    numbers: releaseCapable(built.numbers, NUMBER_RELEASE) ? (built.numbers as NumberReleaseAdapter) : null,
    provisioning: releaseCapable(built.provisioning, PROVISIONING_RELEASE) ? (built.provisioning as ProvisioningReleaseAdapter) : null,
  };
}

export type CancelRuntimeOptions = {
  /** The installed target source, or null when the database read is not installed (the default). */
  targets?: CancelTargetSource | null;
  /** Real adapters for one subaccount, supplied by the platform runtime (e.g. factory.ts `buildSubaccountAdaptersFor(env)`). Absent = no real path. */
  realAdaptersFor?: ((accountSid: string) => Promise<SubaccountAdapters>) | null;
};

type Rpc = { rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };

const KINDS = new Set(["messaging_service", "campaign", "number"]);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Strict parse of tw4_rfl_cancel_target's reply; anything unexpected is "no target" (the runner then claims nothing). Exported for tests. */
export function parseCancelTarget(raw: unknown): CancelTarget | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const kind = str(o.kind);
  const operationId = str(o.operation_id);
  const resourceId = str(o.resource_id);
  const operationStatus = str(o.operation_status);
  const providerSid = str(o.provider_sid);
  const accountSid = str(o.account_sid);
  if (!kind || !KINDS.has(kind) || !operationId || !resourceId || !operationStatus || !providerSid || !accountSid || str(o.provider_state) !== "active") return null;
  if (typeof o.live_dependents !== "number" || !Number.isInteger(o.live_dependents)) return null;
  let dualControl: CancelTarget["dualControl"] = null;
  if (o.dual_control !== null && o.dual_control !== undefined) {
    const d = o.dual_control as Record<string, unknown>;
    const fields = [str(d.request_id), str(d.resource_id), str(d.requested_by), str(d.decided_by), str(d.status)];
    if (fields.some((f) => f === null)) return null;
    const [requestId, dualResource, requestedBy, decidedBy, status] = fields as string[];
    dualControl = { requestId, resourceId: dualResource, requestedBy, decidedBy, status };
  }
  return {
    operationId, resourceId, operationStatus, kind: kind as CancelKind, providerSid, accountSid, messagingServiceSid: str(o.messaging_service_sid),
    liveDependents: o.live_dependents, dualControl,
  };
}

/** The database read (20261224090000). Missing function, a refusal, or an unexpected shape all read as "no target"; error text is never surfaced or logged. */
export class SupabaseCancelTargetSource implements CancelTargetSource {
  constructor(private readonly admin: Rpc) {}

  async target(operationId: string, actorId: string): Promise<CancelTarget | null> {
    const { data, error } = await this.admin.rpc("tw4_rfl_cancel_target", { p_operation_id: operationId, p_actor: actorId });
    if (error) return null;
    return parseCancelTarget(data);
  }
}

/** The target source this deployment uses: the tw4_rfl_cancel_target read. Where it is not applied, every target reads as missing and nothing is claimed. */
export function installedCancelTargets(): CancelTargetSource | null {
  return new SupabaseCancelTargetSource(createAdminClient());
}

export function cancelReleaseRuntime(env: Env = process.env, options: CancelRuntimeOptions = {}): CancelReleaseRuntime {
  if (String(env.TW4_CANCEL_RELEASE ?? "") !== "on") return { ok: false, reason: "Provider release is switched off (TW4_CANCEL_RELEASE)." };
  const targets = options.targets === undefined ? installedCancelTargets() : options.targets;
  if (!targets) return { ok: false, reason: "Provider release is not installed in this environment (the cancellation target read is missing)." };
  const ledger = new ProviderFeeLifecycleStore(createAdminClient());
  if (fakeAdapterAllowed(env)) {
    const built = buildSubaccountAdaptersFor(env);
    return { ok: true, mode: "fake", runner: buildCancelRunner({ ledger, targets, adaptersFor: async (accountSid) => asReleaseAdapters(await built(accountSid)) }) };
  }
  // defense in depth: the supplied real adapters are gated where they are built, and the release path also needs the provisioning gate here
  if (options.realAdaptersFor && provisioningCallsAllowed(env).allowed) {
    const supplied = options.realAdaptersFor;
    // a number is released only where the number gate is on as well
    const adaptersFor = async (accountSid: string): Promise<ReleaseAdapters> => {
      const built = asReleaseAdapters(await supplied(accountSid));
      return { numbers: numberCallsAllowed(env).allowed ? built.numbers : null, provisioning: built.provisioning };
    };
    return { ok: true, mode: "real", runner: buildCancelRunner({ ledger, targets, adaptersFor }) };
  }
  return { ok: false, reason: "No provider release adapter is wired in this environment." };
}

/** For the panel: offer the release button only when the runtime would build. Cheap; builds a client only when every switch is on. */
export function cancelReleaseAvailable(env: Env = process.env, options: CancelRuntimeOptions = {}): boolean {
  if (String(env.TW4_CANCEL_RELEASE ?? "") !== "on") return false;
  return cancelReleaseRuntime(env, options).ok;
}
