import { randomUUID } from "node:crypto";
import { buildCampaignRequest, requestDigest } from "./campaignPayload";
import type { IsvProvisioningAdapter } from "./provisioningTypes";
import type { ProvKind, ProvOperationView, ProvisionContext, ProvisionStore } from "./provisionStore";
import { RunnerStoreError } from "./store";
import { IsvApiError } from "./types";

/**
 * TW-4F R2a: the provisioning runner for ONE studio's Messaging Service and A2P campaign, inside the studio's legal business SUBACCOUNT. It builds on the
 * brand runner's lease, ledger and fee-gate model and adds nothing that can buy a number or send SMS.
 *
 *   M1 Messaging Service (free)  ->  observe (right account, routed to DanceFlow's inbound route)
 *   C1 campaign (FEE-BEARING)    ->  observe (provider status decides; a submission is never an approval)
 *
 * Safety properties (each is a test):
 *  - Every operation is recorded BEFORE the provider call (`begin`) and closed after it (`finish`); a succeeded operation is never repeated.
 *  - Nothing is created when a matching resource already exists at the provider: lookups come first (a lost response is adopted, not duplicated).
 *  - A fee operation is NEVER repeated after an ambiguous outcome: it stays `unknown_outcome` until a platform admin resolves it.
 *  - The campaign needs the admin's explicit fee confirmation for THIS run, the database's fee gate (owner approval, price, funds, verified path) in the
 *    same transaction as the attempt record, and a package that passed review. Failing any of them calls nothing and reserves nothing.
 *  - Provider approval comes only from provider reads judged by the database.
 *  - The adapter must belong to the account recorded for the studio's legal business (never the parent, never another business).
 */

export type ProvisionOutcome =
  | "service_ready"
  | "campaign_submitted"
  | "campaign_pending"
  | "campaign_verified"
  | "campaign_rejected"
  | "waiting_fee_confirmation"
  | "package_invalid"
  | "prerequisite_missing"
  | "entity_resource_exists"
  | "unknown_outcome"
  | "exception"
  | "retry_later"
  | "lease_busy"
  | "lease_lost"
  | "runner_closed"
  | "not_runnable"
  | "config_missing"
  | "needs_subaccount"
  | "account_mismatch"
  | "spend_blocked"
  | "insufficient_credit"
  | "recurring_missing"
  | "tier_unpriced"
  | "tier_ineligible"
  /** The pilot business has a standing recurring authorization, which the pilot rule forbids. Nothing was reserved or called. */
  | "pilot_conflict"
  | "record_failed"
  | "nothing_to_check";

export type ProvisionResult = { outcome: ProvisionOutcome; steps: ProvKind[]; detail?: string; state?: string };

export type ProvisionInput = {
  store: ProvisionStore;
  adapter: IsvProvisioningAdapter;
  studioId: string;
  actorId: string;
  envName: string;
  /** The platform admin explicitly confirmed the campaign fees for THIS run. Never stored or reused. */
  confirmFee: boolean;
  /** DanceFlow's canonical inbound route (`<origin>/api/sms/twilio/inbound`). Null = not configured: nothing is called. */
  inboundUrl: string | null;
  /** Public origin for the opt-in / Terms / Privacy links of the campaign package. */
  origin: string;
  /** Stop once the Messaging Service is verified ready (the campaign is not begun). */
  stopAfterService?: boolean;
};

/** A quiet period before a free resource that a lookup cannot find is treated as never created (mirrors the database rule). */
export const RECONCILE_QUIET_SECONDS = 120;

const sanitized = (error: unknown): string => {
  if (error instanceof IsvApiError) return `${error.kind}${error.twilioCode ? `:${error.twilioCode}` : ""}${error.httpStatus ? `:http${error.httpStatus}` : ""}`;
  if (error instanceof RunnerStoreError) return `store:${error.code}`;
  return "unexpected";
};
const storeCode = (error: unknown): string => (error instanceof RunnerStoreError ? error.code : "unknown");
const definiteRefusal = (error: unknown): boolean => error instanceof IsvApiError && (error.kind === "validation" || error.kind === "account");

export function serviceFriendlyName(envName: string, studioId: string, submissionSeq: number): string {
  return `df:${envName}:${studioId}:ms:${submissionSeq}`.slice(0, 128);
}

function isLive(op: ProvOperationView, kind: ProvKind): boolean {
  if (op.kind !== kind || op.superseded) return false;
  if (op.status === "in_flight" || op.status === "unknown_outcome") return true;
  return op.status === "succeeded" && !(kind === "campaign" && op.resource_status === "failed");
}

/** begin() errors that mean "the gate said no": nothing was reserved or recorded. */
function beginRefusal(error: unknown, kind: ProvKind): ProvisionResult {
  const code = storeCode(error);
  const detail = `${kind}:${code}`;
  switch (code) {
    case "55P03": return { outcome: "lease_lost", steps: [], detail };
    case "TW001": return { outcome: "runner_closed", steps: [] };
    case "TW004": return { outcome: "spend_blocked", steps: [], detail: `${kind}:no_authorized_spend` };
    case "TW005": return { outcome: "needs_subaccount", steps: [], detail };
    case "TW007": return { outcome: "insufficient_credit", steps: [], detail: `${kind}:insufficient_credit` };
    case "TW008": return { outcome: "tier_unpriced", steps: [], detail };
    case "TW020": return { outcome: "tier_ineligible", steps: [], detail };
    case "TW030": return { outcome: "not_runnable", steps: [], detail: `${kind}:state` };
    case "TW031": return { outcome: "entity_resource_exists", steps: [], detail };
    case "TW032": return { outcome: "prerequisite_missing", steps: [], detail };
    case "TW033": return { outcome: "recurring_missing", steps: [], detail };
    case "TW011": return { outcome: "pilot_conflict", steps: [], detail };
    default: return { outcome: "exception", steps: [], detail: `begin:${detail}` };
  }
}

async function accountRefusal(store: ProvisionStore, adapter: IsvProvisioningAdapter, onboardingId: string, leaseOwner: string, state: string): Promise<ProvisionResult | null> {
  let account;
  try {
    account = await store.getAccount(onboardingId, leaseOwner);
  } catch (error) {
    return { outcome: "exception", steps: [], detail: `account:${storeCode(error)}`, state };
  }
  if (!account.legalEntityId) return { outcome: "needs_subaccount", steps: [], detail: "no_legal_entity", state };
  if (!account.accountSid) return { outcome: "needs_subaccount", steps: [], detail: "no_subaccount", state };
  if (adapter.accountSid !== account.accountSid) return { outcome: "account_mismatch", steps: [], detail: "adapter_account_differs", state };
  return null;
}

type Done = { done: true; operationId: string; sid: string; created: boolean };
type Stop = { done: false; result: ProvisionResult };

type Spec = {
  kind: ProvKind;
  fee: boolean;
  friendlyName: string;
  digest: string;
  params: Record<string, unknown>;
  find: () => Promise<string[]>;
  create: () => Promise<string>;
  /** Provider resources the ledger already accounts for in earlier attempts (a rejected campaign still exists at the provider; it is not "unrecorded"). */
  known: ReadonlySet<string>;
  /** The operation already known to the ledger (from the run's context), if any. */
  live: ProvOperationView | undefined;
};

export async function runProvisioning(input: ProvisionInput): Promise<ProvisionResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `prov-${randomUUID().slice(0, 8)}`;
  const steps: ProvKind[] = [];

  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner);
  } catch (error) {
    const code = storeCode(error);
    if (code === "55P03") return { outcome: "lease_busy", steps };
    if (code === "TW001") return { outcome: "runner_closed", steps };
    return { outcome: "not_runnable", steps, detail: code };
  }
  const onboardingId = claim.onboarding_id;
  let state = claim.state;

  try {
    const refused = await accountRefusal(store, adapter, onboardingId, leaseOwner, state);
    if (refused) return refused;
    if (!input.inboundUrl) return { outcome: "config_missing", steps, detail: "app_url_not_configured", state };

    let ctx: ProvisionContext;
    let names;
    try {
      ctx = await store.context(onboardingId, leaseOwner);
      names = await store.getInputs(onboardingId, leaseOwner);
    } catch (error) {
      return { outcome: "exception", steps, detail: `context:${storeCode(error)}`, state };
    }

    const stopWith = async (stop: Stop): Promise<ProvisionResult> => ({ ...stop.result, steps, state: stop.result.state ?? state });

    // The ledger-stop transitions: a provisioning exception sends the onboarding to a human (reopened by a platform admin after it is understood).
    const toException = async (code: string) => {
      try {
        state = await store.transition(onboardingId, leaseOwner, "exception", "provisioning", code);
      } catch {
        /* the operation row already records what happened; the state change is best-effort */
      }
    };

    const perform = async (spec: Spec): Promise<Done | Stop> => {
      const { kind } = spec;
      const stop = (result: ProvisionResult): Stop => ({ done: false, result });
      let adoptSid: string | null = null;

      // 1. Look BEFORE recording anything: a resource the ledger does not know about must never be duplicated (or paid for twice).
      if (!spec.live) {
        let existing: string[];
        let all: string[];
        try {
          all = await spec.find();
          existing = all.filter((sid) => !spec.known.has(sid));
        } catch (error) {
          return stop({ outcome: "retry_later", steps, detail: `lookup:${kind}:${sanitized(error)}`, state });
        }
        if (spec.fee && all.length > 0 && existing.length === 0) {
          // Twilio allows one campaign per Messaging Service: a (rejected) campaign that is still there must be removed at the provider first.
          // Stopping here reserves nothing, so no approval is burned on a create the provider will refuse.
          return stop({ outcome: "prerequisite_missing", steps, detail: `${kind}:provider_campaign_exists_remove_first`, state });
        }
        if (existing.length > 1) {
          await toException("prov_ambiguous");
          return stop({ outcome: "exception", steps, detail: `${kind}:ambiguous_match`, state });
        }
        if (existing.length === 1) {
          if (spec.fee) {
            // a fee resource that exists but is not in the ledger: whether we paid for it is unknown, so nothing is reserved or created; a human decides
            await toException("prov_unrecorded");
            return stop({ outcome: "exception", steps, detail: `${kind}:exists_unrecorded`, state });
          }
          adoptSid = existing[0];
        }
      }

      // 2. Record the attempt (and, for the campaign, pass the fee gate) atomically.
      let begun;
      try {
        begun = await store.begin(onboardingId, leaseOwner, { kind, friendlyName: spec.friendlyName, digest: spec.digest, params: spec.params, actorId });
      } catch (error) {
        return stop({ ...beginRefusal(error, kind), steps, state });
      }
      if (begun.action === "skip") return { done: true, operationId: begun.operation_id, sid: begun.provider_sid, created: false };

      let operationId = begun.operation_id;

      // 3. An open attempt from an earlier run: its outcome is reconciled against the provider, never guessed.
      if (begun.action === "reconcile") {
        let found: string[];
        try {
          found = (await spec.find()).filter((sid) => !spec.known.has(sid));
        } catch (error) {
          try {
            await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "reconcile_failed", errorDetail: sanitized(error) });
          } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `reconcile:${kind}`, state });
        }
        if (found.length === 1) {
          try {
            await store.finish(onboardingId, leaseOwner, operationId, { status: "succeeded", providerSid: found[0] });
          } catch (error) {
            return stop({ outcome: "record_failed", steps, detail: `${kind}:adopt:${storeCode(error)}`, state });
          }
          steps.push(kind);
          return { done: true, operationId, sid: found[0], created: false };
        }
        if (found.length > 1) {
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "ambiguous_match", errorDetail: `candidates:${found.length}` }); } catch { /* stays open */ }
          await toException("prov_ambiguous");
          return stop({ outcome: "exception", steps, detail: `${kind}:ambiguous_match`, state });
        }
        // nothing found
        if (spec.fee) {
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "fee_outcome_unknown", errorDetail: "lookup_empty" }); } catch { /* stays open */ }
          if (begun.age_seconds >= RECONCILE_QUIET_SECONDS) await toException("prov_unknown_fee");
          return stop({ outcome: "unknown_outcome", steps, detail: `${kind}:needs_admin`, state });
        }
        if (begun.age_seconds < RECONCILE_QUIET_SECONDS) {
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "reconcile_wait", errorDetail: "lookup_empty" }); } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `${kind}:reconcile_wait`, state });
        }
        try {
          await store.finish(onboardingId, leaseOwner, operationId, { status: "failed", errorCode: "reconciled_absent", errorDetail: "lookup_empty" });
          begun = await store.begin(onboardingId, leaseOwner, { kind, friendlyName: spec.friendlyName, digest: spec.digest, params: spec.params, actorId });
        } catch (error) {
          return stop({ outcome: "retry_later", steps, detail: `${kind}:reopen:${storeCode(error)}`, state });
        }
        if (begun.action !== "execute") return stop({ outcome: "retry_later", steps, detail: `${kind}:reopen_${begun.action}`, state });
        operationId = begun.operation_id;
      }

      // 4. Execute: adopt the resource a previous (unrecorded) attempt left, or create it.
      let sid: string;
      if (adoptSid) {
        sid = adoptSid;
      } else {
        try {
          sid = await spec.create();
        } catch (error) {
          const detail = sanitized(error);
          if (definiteRefusal(error)) {
            // Twilio refused the request itself: nothing was created, any reservation is released. Another attempt needs a fresh authorization.
            try {
              await store.finish(onboardingId, leaseOwner, operationId, { status: "failed", errorCode: "api", errorDetail: detail });
            } catch (finishError) {
              return stop({ outcome: "record_failed", steps, detail: `${kind}:refused:${storeCode(finishError)}`, state });
            }
            await toException("prov_refused");
            return stop({ outcome: "exception", steps, detail: `${kind}:${detail}`, state });
          }
          // network, timeout, 429/5xx, unreadable or SID-less success: the resource may exist. Record it as such; the next run reconciles by lookup.
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "unclear_outcome", errorDetail: detail }); } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `${kind}:${detail}`, state });
        }
      }
      try {
        await store.finish(onboardingId, leaseOwner, operationId, { status: "succeeded", providerSid: sid });
      } catch (error) {
        // The resource exists at the provider but could not be recorded (the attempt stays open): the next run adopts it by lookup. Say so plainly.
        return stop({ outcome: "record_failed", steps, detail: `${kind}:${storeCode(error)}`, state });
      }
      steps.push(kind);
      return { done: true, operationId, sid, created: !adoptSid };
    };

    // ---- M1: the Messaging Service ------------------------------------------------------------------------------------------------------------
    const serviceName = serviceFriendlyName(input.envName, studioId, ctx.submission_seq);
    const servicePrefix = `df:${input.envName}:${studioId}:ms:`;
    const service = await perform({
      kind: "messaging_service", fee: false, friendlyName: serviceName, digest: digestOf({ kind: "ms", name: serviceName, inbound: input.inboundUrl }), params: { inbound_url: input.inboundUrl },
      find: () => adapter.findMessagingServices(servicePrefix),
      create: () => adapter.createMessagingService({ friendlyName: serviceName, inboundRequestUrl: input.inboundUrl as string }),
      live: ctx.operations.find((op) => isLive(op, "messaging_service")),
      known: knownSids(ctx.operations, "messaging_service"),
    });
    if (!service.done) return stopWith(service);

    const serviceSeen = await observeOne({ ...input, onboardingId, leaseOwner, operationId: service.operationId, kind: "messaging_service", sid: service.sid, parentSid: null });
    if (serviceSeen.kind === "retry") return { outcome: "retry_later", steps, detail: serviceSeen.detail, state };
    if (serviceSeen.kind === "error") return { outcome: "record_failed", steps, detail: serviceSeen.detail, state };
    state = serviceSeen.state || state;
    if (serviceSeen.status !== "ready") {
      await toException("prov_service_mismatch");
      return { outcome: "exception", steps, detail: `messaging_service:${serviceSeen.code ?? serviceSeen.status}`, state };
    }
    if (input.stopAfterService) return { outcome: "service_ready", steps, state };

    // ---- C1: the campaign ---------------------------------------------------------------------------------------------------------------------
    const liveCampaign = ctx.operations.find((op) => isLive(op, "campaign"));
    if (!liveCampaign) {
      // Not started: every cheap, side-effect-free refusal comes before the fee confirmation, which comes before anything is reserved.
      if (!ctx.brand_sid) return { outcome: "prerequisite_missing", steps, detail: "campaign:brand_not_approved", state };
      if (!ctx.requirements.use_case) return { outcome: "tier_ineligible", steps, detail: "campaign:no_verified_path", state };
      if (ctx.entity_live_elsewhere.includes("campaign")) return { outcome: "entity_resource_exists", steps, detail: "campaign", state };
    }
    const displayName = String(names.studio_public_name || names.studio_name || "").trim();
    const request = liveCampaign || !ctx.requirements.use_case || !ctx.brand_sid
      ? null
      : buildCampaignRequest({ messagingServiceSid: service.sid, brandSid: ctx.brand_sid, useCase: ctx.requirements.use_case, displayName, slug: String(names.studio_slug ?? ""), origin: input.origin });
    if (request && !request.review.ok) {
      return { outcome: "package_invalid", steps, detail: request.review.checks.filter((check) => !check.ok).map((check) => check.id).join(","), state };
    }
    if (!liveCampaign && !input.confirmFee) {
      return { outcome: "waiting_fee_confirmation", steps, detail: ctx.requirements.blocker ? `blocked:${ctx.requirements.blocker}` : undefined, state };
    }
    const campaign = await perform({
      kind: "campaign", fee: true, friendlyName: `df:${input.envName}:${studioId}:c1:${ctx.submission_seq}`.slice(0, 128),
      digest: request?.digest ?? (digestOf({ kind: "campaign", service: service.sid })),
      params: { messaging_service_sid: service.sid, brand_sid: ctx.brand_sid, use_case: ctx.requirements.use_case, tier: ctx.requirements.path, template_version: request?.templateVersion ?? null },
      find: () => adapter.findCampaigns(service.sid),
      create: () => {
        if (!request) throw new Error("internal: campaign request missing");
        return adapter.createCampaign(request.input);
      },
      live: liveCampaign,
      known: knownSids(ctx.operations, "campaign"),
    });
    if (!campaign.done) return stopWith(campaign);

    const seen = await observeOne({ ...input, onboardingId, leaseOwner, operationId: campaign.operationId, kind: "campaign", sid: campaign.sid, parentSid: service.sid });
    if (seen.kind === "retry") return { outcome: campaign.created ? "campaign_submitted" : "retry_later", steps, detail: seen.detail, state };
    if (seen.kind === "error") return { outcome: "record_failed", steps, detail: seen.detail, state };
    state = seen.state || state;
    if (seen.status === "mismatch") {
      await toException("prov_campaign_mismatch");
      return { outcome: "exception", steps, detail: `campaign:${seen.code ?? "mismatch"}`, state };
    }
    if (seen.status === "failed") return { outcome: "campaign_rejected", steps, state };
    if (seen.status === "verified") return { outcome: "campaign_verified", steps, state };
    return { outcome: campaign.created ? "campaign_submitted" : "campaign_pending", steps, detail: seen.code ?? undefined, state };
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

type Seen =
  | { kind: "ok"; status: "pending" | "ready" | "verified" | "failed" | "mismatch"; code: string | null; state: string }
  | { kind: "retry"; detail: string }
  | { kind: "error"; detail: string };

/** Reads the resource from the provider and lets the DATABASE judge it. The provider read is the only evidence; a failed read changes nothing. */
async function observeOne(args: ProvisionInput & { onboardingId: string; leaseOwner: string; operationId: string; kind: ProvKind; sid: string; parentSid: string | null }): Promise<Seen> {
  const { adapter, store } = args;
  let facts: Record<string, unknown>;
  try {
    if (args.kind === "messaging_service") facts = { ...(await adapter.getMessagingService(args.sid)) };
    else facts = { ...(await adapter.getCampaign(args.parentSid as string, args.sid)) };
  } catch (error) {
    return { kind: "retry", detail: `observe:${args.kind}:${sanitized(error)}` };
  }
  try {
    const result = await store.observe(args.onboardingId, args.leaseOwner, args.operationId, facts, args.inboundUrl as string, adapter.evidenceSource, digestOf(facts));
    return { kind: "ok", status: result.status, code: result.code, state: result.state };
  } catch (error) {
    return { kind: "error", detail: `observe:${args.kind}:${storeCode(error)}` };
  }
}

function digestOf(value: unknown): string {
  return requestDigest(value);
}

/**
 * "Check status": GET-only. Re-reads the Messaging Service and the campaign from the provider and lets the database judge them. Creates, reserves and
 * pays for nothing. The way a pending campaign becomes verified or rejected, asynchronously from any submission.
 */
export async function refreshProvisioning(input: Omit<ProvisionInput, "confirmFee" | "stopAfterService">): Promise<ProvisionResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `prov-refresh-${randomUUID().slice(0, 8)}`;
  const steps: ProvKind[] = [];
  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner, 120, "refresh");
  } catch (error) {
    const code = storeCode(error);
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", steps, detail: code };
  }
  const onboardingId = claim.onboarding_id;
  try {
    const refused = await accountRefusal(store, adapter, onboardingId, leaseOwner, claim.state);
    if (refused) return refused;
    if (!input.inboundUrl) return { outcome: "config_missing", steps, detail: "app_url_not_configured", state: claim.state };
    let ctx: ProvisionContext;
    try {
      ctx = await store.context(onboardingId, leaseOwner);
    } catch (error) {
      return { outcome: "exception", steps, detail: `context:${storeCode(error)}`, state: claim.state };
    }
    const service = ctx.operations.find((op) => op.kind === "messaging_service" && !op.superseded && op.status === "succeeded" && op.provider_sid);
    const campaign = ctx.operations.find((op) => op.kind === "campaign" && !op.superseded && op.status === "succeeded" && op.provider_sid);
    if (!service && !campaign) return { outcome: "nothing_to_check", steps, state: claim.state };
    let state = claim.state;
    if (service?.provider_sid) {
      const seen = await observeOne({ ...input, confirmFee: false, onboardingId, leaseOwner, operationId: service.id, kind: "messaging_service", sid: service.provider_sid, parentSid: null });
      if (seen.kind === "retry") return { outcome: "retry_later", steps, detail: seen.detail, state };
      if (seen.kind === "error") return { outcome: "record_failed", steps, detail: seen.detail, state };
      state = seen.state || state;
      if (seen.status !== "ready") return { outcome: "exception", steps, detail: `messaging_service:${seen.code ?? seen.status}`, state };
    }
    if (campaign?.provider_sid && service?.provider_sid) {
      const seen = await observeOne({ ...input, confirmFee: false, onboardingId, leaseOwner, operationId: campaign.id, kind: "campaign", sid: campaign.provider_sid, parentSid: service.provider_sid });
      if (seen.kind === "retry") return { outcome: "retry_later", steps, detail: seen.detail, state };
      if (seen.kind === "error") return { outcome: "record_failed", steps, detail: seen.detail, state };
      state = seen.state || state;
      if (seen.status === "mismatch") return { outcome: "exception", steps, detail: `campaign:${seen.code ?? "mismatch"}`, state };
      if (seen.status === "failed") return { outcome: "campaign_rejected", steps, state };
      if (seen.status === "verified") return { outcome: "campaign_verified", steps, state };
      return { outcome: "campaign_pending", steps, detail: seen.code ?? undefined, state };
    }
    return { outcome: "service_ready", steps, state };
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

/** Provider SIDs the ledger already accounts for (earlier attempts, rejected or superseded), except the live operation's own. */
function knownSids(operations: ProvOperationView[], kind: ProvKind): ReadonlySet<string> {
  return new Set(operations.filter((op) => op.kind === kind && op.provider_sid && !isLive(op, kind)).map((op) => String(op.provider_sid)));
}
