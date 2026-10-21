import { randomUUID } from "node:crypto";
import { requestDigest } from "./campaignPayload";
import type { IsvNumberAdapter } from "./numberTypes";
import type { NumContext, NumKind, NumOperationView, NumRequirements, NumberStore } from "./numberStore";
import { RunnerStoreError } from "./store";
import { IsvApiError } from "./types";

/**
 * TW-4F R2b: number search, purchase and attachment for ONE studio's verified campaign, inside the studio's legal business SUBACCOUNT. Builds on the brand and R2a
 * runners' lease, ledger and fee-gate model. It never sends SMS and never touches the sender registry (that is `activation.ts`).
 *
 *   N0 search (free)        -> an OFFER (nothing bought, nothing reserved)
 *   N1 owner approval       -> a SELECTION of exactly one number (made through tw4_num_select, not by this runner)
 *   N2 purchase (FEE)       -> observe (a provider read of THIS account must show the number, SMS-capable, with the approved E.164)
 *   N3 attach to the service-> observe (the service's sender pool must contain the number)
 *
 * Safety properties (each is a test):
 *  - Every operation is recorded BEFORE the provider call (`begin`) and closed after it (`finish`); a succeeded operation is never repeated.
 *  - The purchase needs the admin's confirmation for THIS run AND the database's gate (verified campaign, owner approval of the exact number, published price,
 *    funding, release-before-replacement) in the same transaction as the attempt record. Failing any of them calls nothing and reserves nothing.
 *  - A number the account already owns that the ledger never recorded is NEVER adopted (whether it was paid for is unknown): a human decides.
 *  - A fee operation is NEVER repeated after an ambiguous outcome: it stays `unknown_outcome` until a platform admin resolves it.
 *  - Ownership and attachment come only from provider reads judged by the database.
 *  - The adapter must belong to the account recorded for the studio's legal business (never the parent, never another business).
 */

export type NumberOutcome =
  | "offered"
  | "no_numbers"
  | "number_ready"
  | "purchase_confirmed"
  | "waiting_fee_confirmation"
  | "no_selection"
  | "prerequisite_missing"
  | "release_current_number_first"
  | "number_taken"
  | "unknown_outcome"
  | "exception"
  | "retry_later"
  | "lease_busy"
  | "lease_lost"
  | "runner_closed"
  | "not_runnable"
  | "needs_subaccount"
  | "account_mismatch"
  | "spend_blocked"
  | "insufficient_credit"
  | "recurring_missing"
  | "price_unavailable"
  | "pilot_conflict"
  | "suspended"
  | "record_failed"
  | "search_refused"
  | "inventory_clean"
  | "identity_recorded"
  | "inventory_unknown"
  | "nothing_to_check";

export type NumberResult = { outcome: NumberOutcome; steps: NumKind[]; detail?: string; state?: string; offer?: { offerId: string; count: number; expiresAt: string; candidates: { e164: string; locality: string | null; region: string | null }[] } };

export type NumberInput = {
  store: NumberStore;
  adapter: IsvNumberAdapter;
  studioId: string;
  actorId: string;
  envName: string;
  /** The platform admin explicitly confirmed the number purchase for THIS run. Never stored or reused. */
  confirmFee: boolean;
};

const sanitized = (error: unknown): string => {
  if (error instanceof IsvApiError) return `${error.kind}${error.twilioCode ? `:${error.twilioCode}` : ""}${error.httpStatus ? `:http${error.httpStatus}` : ""}`;
  if (error instanceof RunnerStoreError) return `store:${error.code}`;
  return "unexpected";
};
const storeCode = (error: unknown): string => (error instanceof RunnerStoreError ? error.code : "unknown");
/**
 * A definite refusal is Twilio saying NO to the request itself. For a FEE call it must be a 4xx that carries Twilio's own error code and is not a status a proxy or
 * timeout produces (408/409/425/499): anything else may have been applied, and is an unknown outcome. A free call keeps the broader rule.
 */
const definiteRefusal = (error: unknown, fee: boolean): boolean => {
  if (!(error instanceof IsvApiError) || (error.kind !== "validation" && error.kind !== "account")) return false;
  if (!fee) return true;
  if (error.kind === "account") return true; // 401/403: refused before anything was done (the rotation proxy already retried a stale token once)
  return Boolean(error.twilioCode) && ![408, 409, 425, 499].includes(error.httpStatus ?? 0);
};

export function numberFriendlyName(envName: string, studioId: string, submissionSeq: number): string {
  return `df:${envName}:${studioId}:pn:${submissionSeq}`.slice(0, 128);
}

function isLive(op: NumOperationView, kind: NumKind): boolean {
  return op.kind === kind && !op.superseded && (op.status === "in_flight" || op.status === "unknown_outcome" || op.status === "succeeded");
}

/** A requirements blocker is the database's cheap, side-effect-free preview of begin()'s refusal: nothing is called or reserved. */
function blockerOutcome(blocker: NonNullable<NumRequirements["blocker"]>): { outcome: NumberOutcome; detail: string } {
  switch (blocker) {
    case "suspended": return { outcome: "suspended", detail: blocker };
    case "campaign_not_verified": return { outcome: "prerequisite_missing", detail: blocker };
    case "unpriced":
    case "price_changed": return { outcome: "price_unavailable", detail: blocker };
    case "release_current_number_first": return { outcome: "release_current_number_first", detail: blocker };
    case "no_selection":
    case "selection_expired":
    case "selection_stale": return { outcome: "no_selection", detail: blocker };
    case "number_taken": return { outcome: "number_taken", detail: blocker };
    case "pilot_recurring": return { outcome: "pilot_conflict", detail: blocker };
    case "awaiting_recurring": return { outcome: "recurring_missing", detail: blocker };
    case "awaiting_authorization": return { outcome: "spend_blocked", detail: blocker };
    default: return { outcome: "insufficient_credit", detail: blocker };
  }
}

function beginRefusal(error: unknown, kind: NumKind): { outcome: NumberOutcome; detail: string } {
  const code = storeCode(error);
  const detail = `${kind}:${code}`;
  switch (code) {
    case "55P03": return { outcome: "lease_lost", detail };
    case "TW001": return { outcome: "runner_closed", detail };
    case "TW004": return { outcome: "spend_blocked", detail };
    case "TW005": return { outcome: "suspended", detail };
    case "TW007": return { outcome: "insufficient_credit", detail };
    case "TW008": return { outcome: "price_unavailable", detail };
    case "TW011": return { outcome: "pilot_conflict", detail };
    case "TW022": return { outcome: "release_current_number_first", detail };
    case "TW030": return { outcome: "not_runnable", detail };
    case "TW032": return { outcome: "prerequisite_missing", detail };
    case "TW033": return { outcome: "recurring_missing", detail };
    case "TW040": return { outcome: "no_selection", detail };
    case "TW046": return { outcome: "prerequisite_missing", detail: `${kind}:lifecycle_inventory` };
    case "TW045": return { outcome: "prerequisite_missing", detail: `${kind}:inventory_not_reconciled` };
    case "23505": return { outcome: "number_taken", detail };
    default: return { outcome: "exception", detail: `begin:${detail}` };
  }
}

type Done = { done: true; operationId: string; sid: string; created: boolean };
type Stop = { done: false; result: NumberResult };
type Spec = {
  kind: NumKind;
  fee: boolean;
  friendlyName: string;
  digest: string;
  params: Record<string, unknown>;
  find: () => Promise<string[]>;
  create: () => Promise<string>;
  live: NumOperationView | undefined;
};

async function accountRefusal(store: NumberStore, adapter: IsvNumberAdapter, onboardingId: string, leaseOwner: string, state: string): Promise<NumberResult | null> {
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

/**
 * N0: search for numbers. FREE and read-only: nothing is bought or reserved. The database re-filters what the provider returned (SMS-capable, no address
 * requirement, not already spoken for) and refuses a search that ran in an account other than the studio's active subaccount.
 */
export async function offerNumbers(input: { store: NumberStore; adapter: IsvNumberAdapter; studioId: string; actorId: string; areaCode?: string; limit?: number }): Promise<NumberResult> {
  const { store, adapter } = input;
  const limit = Math.max(1, Math.min(25, input.limit ?? 20));
  let found;
  try {
    found = await adapter.searchAvailableNumbers({ areaCode: input.areaCode, limit });
  } catch (error) {
    return { outcome: "search_refused", steps: [], detail: `search:${sanitized(error)}` };
  }
  if (found.length === 0) return { outcome: "no_numbers", steps: [] };
  try {
    const offer = await store.recordOffer(input.studioId, input.actorId, adapter.accountSid, { area_code: input.areaCode ?? null, limit }, found, adapter.evidenceSource, requestDigest(found));
    return { outcome: "offered", steps: [], offer: { offerId: offer.offer_id, count: offer.count, expiresAt: offer.expires_at, candidates: offer.candidates } };
  } catch (error) {
    const code = storeCode(error);
    if (code === "TW005") return { outcome: "account_mismatch", steps: [], detail: "offer:account" };
    if (code === "TW043") return { outcome: "no_numbers", steps: [], detail: "none_eligible" };
    if (code === "TW032") return { outcome: "prerequisite_missing", steps: [], detail: "offer:campaign_not_verified" };
    if (code === "TW030") return { outcome: "not_runnable", steps: [], detail: "offer:state" };
    return { outcome: "exception", steps: [], detail: `offer:${code}` };
  }
}

/** N2 + N3: purchase the approved number and attach it to the verified Messaging Service. */
export async function runNumberAcquisition(input: NumberInput): Promise<NumberResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `num-${randomUUID().slice(0, 8)}`;
  const steps: NumKind[] = [];

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

    let ctx: NumContext;
    try {
      ctx = await store.context(onboardingId, leaseOwner);
    } catch (error) {
      return { outcome: "exception", steps, detail: `context:${storeCode(error)}`, state };
    }
    if (!ctx.messaging_service_sid || !ctx.campaign_sid) return { outcome: "prerequisite_missing", steps, detail: "campaign_not_verified", state };

    const toException = async (code: string) => {
      try {
        state = await store.transition(onboardingId, leaseOwner, "exception", "number", code);
      } catch {
        /* the operation row already records what happened; the state change is best-effort */
      }
    };

    const perform = async (spec: Spec): Promise<Done | Stop> => {
      const { kind } = spec;
      const stop = (result: NumberResult): Stop => ({ done: false, result: { ...result, steps, state: result.state ?? state } });
      let adoptSid: string | null = null;

      // 1. Look BEFORE recording anything: a resource the ledger does not know about must never be duplicated (or paid for twice).
      if (!spec.live) {
        let existing: string[];
        try {
          existing = await spec.find();
        } catch (error) {
          return stop({ outcome: "retry_later", steps, detail: `lookup:${kind}:${sanitized(error)}` });
        }
        if (existing.length > 1) {
          await toException("num_ambiguous");
          return stop({ outcome: "exception", steps, detail: `${kind}:ambiguous_match` });
        }
        if (existing.length === 1) {
          if (spec.fee) {
            // a number the account already owns that the ledger does not know: whether we paid for it is unknown, so nothing is reserved or bought; a human decides
            await toException("num_unrecorded");
            return stop({ outcome: "exception", steps, detail: `${kind}:exists_unrecorded` });
          }
          adoptSid = existing[0];
        }
      }

      // 2. Record the attempt (and, for the purchase, pass the fee gate) atomically.
      let begun;
      try {
        begun = await store.begin(onboardingId, leaseOwner, { kind, friendlyName: spec.friendlyName, digest: spec.digest, params: spec.params, actorId });
      } catch (error) {
        return stop({ ...beginRefusal(error, kind), steps });
      }
      if (begun.action === "skip") return { done: true, operationId: begun.operation_id, sid: begun.provider_sid, created: false };
      const operationId = begun.operation_id;
      // the account the ledger stamped on the attempt must be the adapter's: nothing is created in any other account
      if (begun.action === "execute" && begun.account_sid !== adapter.accountSid) {
        try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "account_changed", errorDetail: "ledger account differs from adapter" }); } catch { /* stays open */ }
        return stop({ outcome: "account_mismatch", steps, detail: `${kind}:ledger_account_differs` });
      }

      // 3. An open attempt from an earlier run: its outcome is reconciled against the provider, never guessed.
      if (begun.action === "reconcile") {
        let found: string[];
        try {
          found = await spec.find();
        } catch (error) {
          try {
            await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "reconcile_failed", errorDetail: sanitized(error) });
          } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `reconcile:${kind}` });
        }
        if (found.length === 1) {
          try {
            await store.finish(onboardingId, leaseOwner, operationId, { status: "succeeded", providerSid: found[0] });
          } catch (error) {
            return stop({ outcome: "record_failed", steps, detail: `${kind}:adopt:${storeCode(error)}` });
          }
          steps.push(kind);
          return { done: true, operationId, sid: found[0], created: false };
        }
        if (found.length > 1) {
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "ambiguous_match", errorDetail: `candidates:${found.length}` }); } catch { /* stays open */ }
          await toException("num_ambiguous");
          return stop({ outcome: "exception", steps, detail: `${kind}:ambiguous_match` });
        }
        if (spec.fee) {
          // never repeated: only a platform admin may declare a fee operation not created (tw4_num_resolve, 20 minutes, written reason)
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "fee_outcome_unknown", errorDetail: "lookup_empty" }); } catch { /* stays open */ }
          if (begun.age_seconds >= 120) await toException("num_unknown_fee");
          return stop({ outcome: "unknown_outcome", steps, detail: `${kind}:needs_admin` });
        }
        // a free operation that a lookup cannot find: wait out the provider's list lag, then run it again as a new attempt
        if (begun.age_seconds < 120) {
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "reconcile_wait", errorDetail: "lookup_empty" }); } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `${kind}:reconcile_wait` });
        }
        try {
          await store.finish(onboardingId, leaseOwner, operationId, { status: "failed", errorCode: "reconciled_absent", errorDetail: "lookup_empty" });
        } catch (error) {
          return stop({ outcome: "retry_later", steps, detail: `${kind}:reopen:${storeCode(error)}` });
        }
        return stop({ outcome: "retry_later", steps, detail: `${kind}:reopened_run_again` });
      }

      // 4. Execute: adopt the resource a previous (unrecorded) free attempt left, or create it.
      let sid: string;
      if (adoptSid) {
        sid = adoptSid;
      } else {
        try {
          sid = await spec.create();
        } catch (error) {
          const detail = sanitized(error);
          if (definiteRefusal(error, spec.fee)) {
            // Twilio refused the request itself: nothing was created, any reservation is released. Another attempt needs a NEW owner approval.
            try {
              await store.finish(onboardingId, leaseOwner, operationId, { status: "failed", errorCode: "api", errorDetail: detail });
            } catch (finishError) {
              return stop({ outcome: "record_failed", steps, detail: `${kind}:refused:${storeCode(finishError)}` });
            }
            await toException("num_refused");
            return stop({ outcome: "exception", steps, detail: `${kind}:${detail}` });
          }
          // network, timeout, 429/5xx, unreadable or SID-less success: the resource may exist. Record it as such; the next run reconciles by lookup.
          try { await store.finish(onboardingId, leaseOwner, operationId, { status: "unknown_outcome", errorCode: "unclear_outcome", errorDetail: detail }); } catch { /* stays open */ }
          return stop({ outcome: "retry_later", steps, detail: `${kind}:${detail}` });
        }
      }
      try {
        await store.finish(onboardingId, leaseOwner, operationId, { status: "succeeded", providerSid: sid });
      } catch (error) {
        return stop({ outcome: "record_failed", steps, detail: `${kind}:${storeCode(error)}` });
      }
      steps.push(kind);
      return { done: true, operationId, sid, created: !adoptSid };
    };

    // ---- N2: the purchase ---------------------------------------------------------------------------------------------------------------------
    const livePurchase = ctx.operations.find((op) => isLive(op, "number_purchase"));
    if (!livePurchase) {
      // Not started: every cheap, side-effect-free refusal comes before the fee confirmation, which comes before anything is reserved.
      const blocker = ctx.requirements.blocker;
      if (blocker) return { ...blockerOutcome(blocker), steps, state };
      if (!input.confirmFee) return { outcome: "waiting_fee_confirmation", steps, detail: ctx.requirements.selection_e164 ?? undefined, state };
    }
    const e164 = livePurchase?.e164 ?? ctx.requirements.selection_e164;
    if (!livePurchase) {
      // INVENTORY RECONCILIATION before anything is recorded or bought: every number the provider shows in this subaccount must be one the system accounts for. A number it
      // does not know (bought by hand, a hung purchase an admin declared not created) may be billed to DanceFlow forever: a human acknowledges it, nothing proceeds.
      let inventory;
      let listedAt = new Date().toISOString();
      try {
        listedAt = new Date().toISOString();
        inventory = await adapter.listIncomingNumbers();
      } catch (error) {
        return { outcome: "retry_later", steps, detail: `inventory:${sanitized(error)}`, state };
      }
      let seen;
      try {
        // the DATABASE compares the provider's inventory with the numbers it accounts for, and its stamp (this lease, a moment ago, nothing unknown) is what the purchase requires
        seen = await store.inventoryObserve(onboardingId, leaseOwner, inventory, adapter.evidenceSource, listedAt);
      } catch (error) {
        return { outcome: "retry_later", steps, detail: `inventory_record:${storeCode(error)}`, state };
      }
      if (seen.unknown > 0 || seen.missing > 0) {
        await toException("num_inventory_unknown");
        return { outcome: "exception", steps, detail: seen.unknown > 0 ? `inventory_unrecorded:${seen.unknown}` : `inventory_missing:${seen.missing}`, state };
      }
    }
    if (!e164 || (!livePurchase && !ctx.requirements.selection_id)) return { outcome: "no_selection", steps, state };
    const name = numberFriendlyName(input.envName, studioId, ctx.submission_seq);
    const purchase = await perform({
      kind: "number_purchase", fee: true, friendlyName: name, digest: requestDigest({ kind: "pn", e164, selection: ctx.requirements.selection_id ?? livePurchase?.id }),
      params: { selection_id: ctx.requirements.selection_id, e164 },
      find: () => adapter.findOwnedNumbers(e164),
      create: () => adapter.purchaseNumber({ e164, friendlyName: name }),
      live: livePurchase,
    });
    if (!purchase.done) return purchase.result;

    const owned = await observeNumber(input, onboardingId, leaseOwner, purchase.operationId, "number_purchase", purchase.sid, ctx.messaging_service_sid);
    if (owned.kind === "retry") return { outcome: "retry_later", steps, detail: owned.detail, state };
    if (owned.kind === "error") return { outcome: "record_failed", steps, detail: owned.detail, state };
    state = owned.state || state;
    if (owned.status !== "owned") return { outcome: "exception", steps, detail: `number:${owned.code ?? owned.status}`, state };

    // ---- N3: attach to the verified Messaging Service --------------------------------------------------------------------------------------------
    const mg = ctx.messaging_service_sid;
    const attach = await perform({
      kind: "number_attach", fee: false, friendlyName: name, digest: requestDigest({ kind: "attach", mg, pn: purchase.sid }),
      params: { messaging_service_sid: mg, phone_number_sid: purchase.sid },
      find: async () => (await adapter.listServiceNumbers(mg)).filter((sid) => sid === purchase.sid),
      create: () => adapter.attachNumber({ messagingServiceSid: mg, phoneNumberSid: purchase.sid }),
      live: ctx.operations.find((op) => isLive(op, "number_attach")),
    });
    if (!attach.done) return attach.result;
    const attached = await observeNumber(input, onboardingId, leaseOwner, attach.operationId, "number_attach", attach.sid, mg);
    if (attached.kind === "retry") return { outcome: "retry_later", steps, detail: attached.detail, state };
    if (attached.kind === "error") return { outcome: "record_failed", steps, detail: attached.detail, state };
    state = attached.state || state;
    if (attached.status !== "attached") return { outcome: "exception", steps, detail: `service_number:${attached.code ?? attached.status}`, state };
    return { outcome: "number_ready", steps, state };
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

type Seen =
  | { kind: "ok"; status: "owned" | "attached" | "mismatch"; code: string | null; state: string }
  | { kind: "retry"; detail: string }
  | { kind: "error"; detail: string };

/** Reads the resource from the provider and lets the DATABASE judge it. The provider read is the only evidence; a failed read changes nothing. */
async function observeNumber(input: NumberInput, onboardingId: string, leaseOwner: string, operationId: string, kind: NumKind, sid: string, messagingServiceSid: string): Promise<Seen> {
  const { adapter, store } = input;
  let facts: Record<string, unknown>;
  try {
    facts = kind === "number_purchase" ? { ...(await adapter.getNumber(sid)) } : { ...(await adapter.getServiceNumbers(messagingServiceSid)) };
  } catch (error) {
    // the provider says the number / service is not there (released at the console, moved, or never existed in this account): that IS evidence, judged as a mismatch
    if (error instanceof IsvApiError && error.httpStatus === 404) {
      facts = { sid: null, account_sid: null, phone_number: null, sms_capable: null, service_sid: null, number_sids: [], not_found: true };
    } else {
      return { kind: "retry", detail: `observe:${kind}:${sanitized(error)}` };
    }
  }
  try {
    const result = await store.observe(onboardingId, leaseOwner, operationId, facts, adapter.evidenceSource, requestDigest(facts));
    return { kind: "ok", status: result.status, code: result.code, state: result.state };
  } catch (error) {
    return { kind: "error", detail: `observe:${kind}:${storeCode(error)}` };
  }
}

/**
 * "Check status": GET-only. Re-reads the purchased number and its attachment from the provider and lets the database judge them. Buys and attaches nothing.
 */
export async function refreshNumber(input: Omit<NumberInput, "confirmFee">): Promise<NumberResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `num-refresh-${randomUUID().slice(0, 8)}`;
  const steps: NumKind[] = [];
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
    let ctx: NumContext;
    try {
      ctx = await store.context(onboardingId, leaseOwner);
    } catch (error) {
      return { outcome: "exception", steps, detail: `context:${storeCode(error)}`, state: claim.state };
    }
    const purchase = ctx.operations.find((op) => op.kind === "number_purchase" && !op.superseded && op.status === "succeeded" && op.provider_sid);
    const attach = ctx.operations.find((op) => op.kind === "number_attach" && !op.superseded && op.status === "succeeded" && op.provider_sid);
    if (!purchase) return { outcome: "nothing_to_check", steps, state: claim.state };
    const fullInput = { ...input, confirmFee: false };
    let state = claim.state;
    const owned = await observeNumber(fullInput, onboardingId, leaseOwner, purchase.id, "number_purchase", purchase.provider_sid as string, ctx.messaging_service_sid ?? "");
    if (owned.kind === "retry") return { outcome: "retry_later", steps, detail: owned.detail, state };
    if (owned.kind === "error") return { outcome: "record_failed", steps, detail: owned.detail, state };
    state = owned.state || state;
    if (owned.status !== "owned") return { outcome: "exception", steps, detail: `number:${owned.code ?? owned.status}`, state };
    if (!attach || !ctx.messaging_service_sid) return { outcome: "purchase_confirmed", steps, state };
    const attached = await observeNumber(fullInput, onboardingId, leaseOwner, attach.id, "number_attach", attach.provider_sid as string, ctx.messaging_service_sid);
    if (attached.kind === "retry") return { outcome: "retry_later", steps, detail: attached.detail, state };
    if (attached.kind === "error") return { outcome: "record_failed", steps, detail: attached.detail, state };
    state = attached.state || state;
    if (attached.status !== "attached") return { outcome: "exception", steps, detail: `service_number:${attached.code ?? attached.status}`, state };
    return { outcome: "number_ready", steps, state };
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

/**
 * Reconciles the provider's inventory of this business's subaccount with the ledger WITHOUT buying anything (a refresh lease: GET-only). The database judges it and stamps the
 * result; the activation checklist (`inventory_reconciled`) needs a clean stamp from the last 24 hours. Until a scheduled reconciliation exists this is the manual path.
 */
export async function refreshInventory(input: { store: NumberStore; adapter: IsvNumberAdapter; studioId: string; actorId: string; scheduled?: boolean }): Promise<NumberResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `num-inv-${randomUUID().slice(0, 8)}`;
  const steps: NumKind[] = [];
  let claim;
  try {
    claim = input.scheduled ? await store.claimRecon(studioId, leaseOwner, 120) : await store.claim(studioId, actorId, leaseOwner, 120, "refresh");
  } catch (error) {
    const code = storeCode(error);
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", steps, detail: code };
  }
  try {
    const refused = await accountRefusal(store, adapter, claim.onboarding_id, leaseOwner, claim.state);
    if (refused) return refused;
    let inventory;
    let listedAt = new Date().toISOString();
    try {
      listedAt = new Date().toISOString();
      inventory = await adapter.listIncomingNumbers();
    } catch (error) {
      return { outcome: "retry_later", steps, detail: `inventory:${sanitized(error)}`, state: claim.state };
    }
    try {
      const seen = await store.inventoryObserve(claim.onboarding_id, leaseOwner, inventory, adapter.evidenceSource, listedAt);
      return seen.unknown > 0 || seen.missing > 0
        ? { outcome: "inventory_unknown", steps, detail: seen.unknown > 0 ? `inventory_unrecorded:${seen.unknown}` : `inventory_missing:${seen.missing}`, state: claim.state }
        : { outcome: "inventory_clean", steps, state: claim.state };
    } catch (error) {
      return { outcome: "retry_later", steps, detail: `inventory_record:${storeCode(error)}`, state: claim.state };
    }
  } finally {
    try {
      await store.release(claim.onboarding_id, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

/**
 * R2b-P1 (L1): ask the PROVIDER what one number is. FREE and read-only (a GET with the subaccount's own credentials). The E.164 an acknowledgement later uses is the one
 * recorded here, never one an administrator typed; the database refuses an answer about any account other than the business's active subaccount.
 */
export async function observeNumberIdentity(input: { store: NumberStore; adapter: IsvNumberAdapter; studioId: string; actorId: string; phoneNumberSid: string }): Promise<NumberResult> {
  const { store, adapter, studioId, actorId, phoneNumberSid } = input;
  const leaseOwner = `num-id-${randomUUID().slice(0, 8)}`;
  const steps: NumKind[] = [];
  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner, 120, "refresh");
  } catch (error) {
    const code = storeCode(error);
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", steps, detail: code };
  }
  try {
    const refused = await accountRefusal(store, adapter, claim.onboarding_id, leaseOwner, claim.state);
    if (refused) return refused;
    let facts;
    try {
      facts = { ...(await adapter.getNumber(phoneNumberSid)) };
    } catch (error) {
      return { outcome: "retry_later", steps, detail: `identity:${sanitized(error)}`, state: claim.state };
    }
    try {
      await store.identityObserve(claim.onboarding_id, leaseOwner, facts, adapter.evidenceSource, requestDigest(facts));
      return { outcome: "identity_recorded", steps, state: claim.state };
    } catch (error) {
      return { outcome: "exception", steps, detail: `identity_record:${storeCode(error)}`, state: claim.state };
    }
  } finally {
    try {
      await store.release(claim.onboarding_id, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

export type ReconcileSummary = {
  checked: number;
  clean: number;
  findings: number;
  skipped: { studioId: string; reason: string }[];
  escalation: { outbox: boolean; raised: number; deferred?: number } | { error: string };
};

/**
 * R2b-P2 (L4): one pass of the scheduled per-subaccount inventory reconciliation. FREE and read-only (listings only): for each business whose inventory is due it lists the subaccount,
 * lets the database judge the listing (unknown numbers, ownership mismatches, duplicates, ledger numbers missing from a complete listing), and then escalates open findings.
 * A subaccount whose adapter cannot be built, a busy lease or a failed listing is SKIPPED AND REPORTED (it stays due), never treated as clean. Nothing here registers a scheduler.
 */
export async function reconcileInventories(input: {
  store: NumberStore;
  adapterFor: (accountSid: string) => IsvNumberAdapter | null;
  limit?: number;
  maxAgeSeconds?: number;
}): Promise<ReconcileSummary> {
  const { store, adapterFor } = input;
  const summary: ReconcileSummary = { checked: 0, clean: 0, findings: 0, skipped: [], escalation: { outbox: false, raised: 0 } };
  let targets;
  try {
    targets = await store.reconTargets(Math.max(1, Math.min(100, input.limit ?? 25)), input.maxAgeSeconds ?? 6 * 3600);
  } catch (error) {
    summary.escalation = { error: `targets:${storeCode(error)}` };
    return summary;
  }
  for (const target of targets) {
    const adapter = adapterFor(target.twilio_account_sid);
    if (!adapter) {
      summary.skipped.push({ studioId: target.studio_id, reason: "adapter_unavailable" });
      continue;
    }
    const result = await refreshInventory({ store, adapter, studioId: target.studio_id, actorId: "scheduled", scheduled: true });
    if (result.outcome === "inventory_clean") {
      summary.checked += 1;
      summary.clean += 1;
    } else if (result.outcome === "inventory_unknown") {
      summary.checked += 1;
      summary.findings += 1;
    } else {
      summary.skipped.push({ studioId: target.studio_id, reason: result.detail ? `${result.outcome}:${result.detail}` : result.outcome });
    }
  }
  try {
    const escalated = await store.escalateOrphans(100);
    summary.escalation = { outbox: escalated.outbox, raised: escalated.raised, deferred: escalated.deferred };
  } catch (error) {
    summary.escalation = { error: `escalate:${storeCode(error)}` };
  }
  return summary;
}
