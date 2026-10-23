import type { NumberRuntime, ProvisioningRuntime } from "@/lib/sms/twilioIsv/factory";
import type { NumberStore } from "@/lib/sms/twilioIsv/numberStore";
import { offerNumbers, refreshNumber, runNumberAcquisition } from "@/lib/sms/twilioIsv/numberRunner";
import { refreshProvisioning, runProvisioning } from "@/lib/sms/twilioIsv/provisionRunner";
import { RunnerStoreError } from "@/lib/sms/twilioIsv/store";
import { describeNumberOutcome, describeProvisioningOutcome } from "./adminView";

/**
 * TW-4F J1: platform-admin orchestration of the R2a provisioning runner (Messaging Service, campaign) and the R2b number runner (offers, purchase,
 * attachment) for ONE studio. The caller (a server action) has already run `requirePlatformAdmin` and passes that admin's id; the browser supplies only
 * a studio id, an intent and the admin's confirmations. This module adds no authority of its own:
 *  - the provider account is read from the database for that studio's legal business, never from the request;
 *  - a runtime is built only when the real-call switches allow it (or the local fake), otherwise the action refuses before anything is constructed;
 *  - the fee gates (published price, owner approval, spend cap, credit, the pilot business's cumulative ceiling) stay in the runners and the database;
 *  - the purchase runs only for the selection the owner already approved, and only when the admin typed that same number on this run (a resumed purchase
 *    must match the number already in the ledger);
 *  - it never records an owner approval (that is the owner's own path) and never stores a confirmation.
 * Replays are safe because the runners are: every provider operation is in the ledger before it is called, a succeeded one is skipped, an ambiguous fee
 * operation is never repeated, and one lease per studio serializes runs.
 */

export type RunCommandResult = { ok: boolean; message: string; studioId: string | null; outcome: string | null };
export type RunDeps = { provisioning: () => ProvisioningRuntime; numbers: () => NumberRuntime };
/** Optional structured trail for the fee-bearing intents (who confirmed what, for which studio, and what came of it). Never carries secrets. */
export type RunAudit = (event: Record<string, unknown>) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_US = /^\+1[2-9][0-9]{9}$/;
const AREA_CODE = /^[2-9][0-9]{2}$/;
export const CAMPAIGN_PHRASE = "SUBMIT";

const field = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};
const refuse = (studioId: string | null, message: string, outcome: string | null = null): RunCommandResult => ({ ok: false, message, studioId, outcome });

function studioOf(form: FormData): string | null {
  const raw = field(form, "studioId").trim();
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

/** The studio's active subaccount, read from the database for its legal business (re-checks the platform-admin actor). Null with a reason otherwise. */
async function accountFor(entities: { entityForStudio(studioId: string, actorId: string): Promise<{ legal_entity_id?: string | null; account_status?: string | null; account_sid?: string | null }> }, studioId: string, actorId: string): Promise<{ sid: string } | { reason: string }> {
  let entity;
  try {
    entity = await entities.entityForStudio(studioId, actorId);
  } catch {
    return { reason: "The studio's Twilio account could not be looked up. Nothing was run." };
  }
  if (entity?.legal_entity_id && entity.account_status === "active" && entity.account_sid) return { sid: entity.account_sid };
  return { reason: "This studio has no active Twilio subaccount for its legal business. Nothing was called." };
}

export async function provisioningCommand(deps: RunDeps, actorId: string, form: FormData, audit?: RunAudit): Promise<RunCommandResult> {
  const studioId = studioOf(form);
  if (!studioId) return refuse(null, "Choose a studio. Nothing was run.");
  const intent = field(form, "intent");
  if (intent !== "service" && intent !== "campaign" && intent !== "refresh") return refuse(studioId, "Unknown provisioning action. Nothing was run.");
  // the fee-bearing campaign needs two deliberate acts on THIS run, checked before any runtime exists
  const confirmFee = intent === "campaign" && field(form, "confirmFee") === "on";
  if (intent === "campaign" && (!confirmFee || field(form, "confirmPhrase").trim() !== CAMPAIGN_PHRASE)) {
    return refuse(studioId, `To submit the fee-bearing campaign, tick the fee confirmation and type ${CAMPAIGN_PHRASE} exactly. Nothing was run.`);
  }

  const runtime = deps.provisioning();
  if (!runtime.ok) return refuse(studioId, `${runtime.reason} Nothing was run.`);
  const account = await accountFor(runtime.entities, studioId, actorId);
  if ("reason" in account) return refuse(studioId, account.reason, "needs_subaccount");

  try {
    const adapter = await runtime.adapterFor(account.sid);
    const base = { store: runtime.store, adapter, studioId, actorId, envName: runtime.envName, inboundUrl: runtime.inboundUrl, origin: runtime.origin };
    const result = intent === "refresh"
      ? await refreshProvisioning(base)
      : await runProvisioning({ ...base, confirmFee, stopAfterService: intent === "service" });
    if (intent === "campaign") audit?.({ event: "sms_provisioning_campaign_run", studioId, actorId, mode: runtime.mode, outcome: result.outcome, steps: result.steps });
    const described = describeProvisioningOutcome(result.outcome, result.detail);
    return { ...described, studioId, outcome: result.outcome };
  } catch {
    return refuse(studioId, "The run failed unexpectedly. Nothing was repeated; check the ledger before running again.");
  }
}

/** Raised from the decorated context read when a purchase already in the ledger is for another number than the one typed: the runner stops there (lease released). */
class TypedNumberMismatch extends RunnerStoreError {
  constructor() {
    super("J1001");
  }
}

/**
 * A view of the number store that refuses a purchase unless the number the admin typed is the one in play: the owner's approved selection for a new purchase, or
 * the purchase already in the ledger when one is resumed. Every other method is the store's own, bound to it (a Proxy, so private state stays intact).
 */
function boundToTypedNumber(store: NumberStore, typed: string, onMismatch: () => void): NumberStore {
  const context: NumberStore["context"] = async (onboardingId, leaseOwner) => {
    const ctx = await store.context(onboardingId, leaseOwner);
    const live = ctx.operations.find((op) => op.kind === "number_purchase" && !op.superseded && ["in_flight", "unknown_outcome", "succeeded"].includes(op.status));
    if (live) {
      if (live.e164 !== typed) {
        onMismatch();
        throw new TypedNumberMismatch();
      }
      return ctx;
    }
    if (!ctx.requirements.blocker && ctx.requirements.selection_e164 !== typed) {
      onMismatch();
      return { ...ctx, requirements: { ...ctx.requirements, blocker: "selection_stale" } };
    }
    return ctx;
  };
  return new Proxy(store, {
    get(target, property) {
      if (property === "context") return context;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function numberCommand(deps: RunDeps, actorId: string, form: FormData, audit?: RunAudit): Promise<RunCommandResult> {
  const studioId = studioOf(form);
  if (!studioId) return refuse(null, "Choose a studio. Nothing was run.");
  const intent = field(form, "intent");
  if (intent !== "offer" && intent !== "acquire" && intent !== "refresh") return refuse(studioId, "Unknown number action. Nothing was run.");
  const areaCode = field(form, "areaCode").trim();
  if (intent === "offer" && areaCode && !AREA_CODE.test(areaCode)) return refuse(studioId, "An area code is three digits and does not start with 0 or 1. Nothing was searched.");
  const typed = field(form, "approvedE164").replace(/[\s().-]/g, "");
  const confirmFee = intent === "acquire" && field(form, "confirmFee") === "on";
  if (intent === "acquire" && (!confirmFee || !E164_US.test(typed))) {
    return refuse(studioId, "To buy the number, tick the fee confirmation and type the owner-approved number (+1 and ten digits). Nothing was run.");
  }

  const runtime = deps.numbers();
  if (!runtime.ok) return refuse(studioId, `${runtime.reason} Nothing was run.`);
  const account = await accountFor(runtime.entities, studioId, actorId);
  if ("reason" in account) return refuse(studioId, account.reason, "needs_subaccount");

  try {
    const adapter = await runtime.adapterFor(account.sid);
    if (intent === "offer") {
      const result = await offerNumbers({ store: runtime.store, adapter, studioId, actorId, areaCode: areaCode || undefined });
      const described = describeNumberOutcome(result.outcome, result.detail);
      const list = result.offer ? ` ${result.offer.count} offered until ${result.offer.expiresAt}: ${result.offer.candidates.map((c) => c.e164).join(", ")}.` : "";
      return { ok: described.ok, message: `${described.message}${list}`, studioId, outcome: result.outcome };
    }
    if (intent === "refresh") {
      const result = await refreshNumber({ store: runtime.store, adapter, studioId, actorId, envName: runtime.envName });
      return { ...describeNumberOutcome(result.outcome, result.detail), studioId, outcome: result.outcome };
    }
    let mismatch = false;
    const store = boundToTypedNumber(runtime.store, typed, () => { mismatch = true; });
    const result = await runNumberAcquisition({ store, adapter, studioId, actorId, envName: runtime.envName, confirmFee });
    // a mismatch stops the run before anything is reserved, recorded or called, whatever the runner then reports
    const outcome = mismatch ? "selection_mismatch" : result.outcome;
    audit?.({ event: "sms_number_purchase_run", studioId, actorId, mode: runtime.mode, typedLast4: typed.slice(-4), outcome, steps: result.steps });
    return { ...describeNumberOutcome(outcome, outcome === "selection_mismatch" ? null : result.detail), studioId, outcome };
  } catch {
    return refuse(studioId, "The run failed unexpectedly. Nothing was repeated; check the ledger before running again.");
  }
}
