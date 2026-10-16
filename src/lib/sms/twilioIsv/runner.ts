import { decryptEin, EinCryptoError } from "@/lib/sms/onboarding/ein";
import { randomUUID } from "node:crypto";
import type { IsvConfig } from "./config";
import {
  PayloadError, a2pEndUserAttributes, addressInput, businessEndUserAttributes, firstWizardField, representativeEndUserAttributes, safeField, stepFriendlyName,
  type RunnerInputs,
} from "./payloads";
import { RunnerStoreError, type RunnerStore, type RunnerTransitionState } from "./store";
import { IsvApiError, ISV_STEP_KEYS, type IsvAdapter, type IsvStepKey } from "./types";

/**
 * TW-4 R1: the brand submission runner. Executes the approved Twilio sequence for ONE studio, one ledger-protected step at a
 * time (design section 3 and 7), up to and including the Brand, then follows the brand's status.
 *
 *   S1 profile | S2 business EndUser (the ONLY place the EIN is decrypted) | S3 representative EndUser | S4 address | S5 document
 *   S6-S9 assignments (business, representative, document, ISV primary profile) | S10 evaluate | S11 submit
 *   T1 A2P TrustProduct | T2 A2P EndUser | T3-T4 assignments | T5 evaluate | T6 submit | B1 Brand (FEE-BEARING)
 *
 * Safety properties (each is a test):
 *  - A step marked succeeded is never executed again; an in-flight or unknown-outcome step is reconciled against Twilio first.
 *  - The fee-bearing Brand needs an explicit platform-admin confirmation on every attempt and is NEVER re-created after an
 *    ambiguous outcome: it ends in `exception` for a human.
 *  - A transient failure leaves the step `unknown_outcome` and stops; nothing is retried automatically (no cron in R1).
 *  - Twilio evaluation failures never reach submission: they become `needs_info` (field mapped) or `exception`.
 *  - The EIN is decrypted inside S2 only, handed to the adapter, and never logged, stored or put in an error.
 *  - The runner never sends SMS, buys a number, creates a Messaging Service or a campaign (R2).
 */

export type RunOutcome =
  | "brand_submitted"
  | "brand_in_review"
  | "brand_approved"
  | "waiting_fee_confirmation"
  | "needs_info"
  | "exception"
  | "retry_later"
  | "lease_busy"
  | "runner_closed"
  | "not_runnable"
  | "config_missing";

export type RunResult = { outcome: RunOutcome; stepsRun: IsvStepKey[]; detail?: string; state?: string };

export type RunInput = {
  store: RunnerStore;
  adapter: IsvAdapter;
  config: IsvConfig;
  studioId: string;
  actorId: string;
  /** The platform admin explicitly confirmed the brand fee for THIS run. */
  confirmFee: boolean;
  decrypt?: (studioId: string, ciphertext: string) => string;
  maxSteps?: number;
};

type Ctx = {
  adapter: IsvAdapter;
  config: IsvConfig;
  inputs: RunnerInputs;
  sids: Partial<Record<IsvStepKey, string>>;
  readEin: () => Promise<string>;
};

type StepResult = { sid: string; failedFields?: string[] };

type StepDef = {
  key: IsvStepKey;
  fee: boolean;
  requires: IsvStepKey[];
  /** Existing resources matching this step (for reconciliation). Only steps whose resource Twilio lets us look up have one. */
  find?: (ctx: Ctx, friendlyName: string) => Promise<string[]>;
  run: (ctx: Ctx, friendlyName: string) => Promise<StepResult>;
};

const need = (ctx: Ctx, key: IsvStepKey): string => {
  const sid = ctx.sids[key];
  if (!sid) throw new Error(`internal: step ${key} has no sid`);
  return sid;
};

export const STEPS: readonly StepDef[] = [
  {
    key: "S1", fee: false, requires: [],
    find: (ctx, friendly) => ctx.adapter.findCustomerProfile(friendly),
    run: async (ctx, friendly) => ({ sid: await ctx.adapter.createCustomerProfile({ friendlyName: friendly, email: ctx.config.complianceEmail }) }),
  },
  {
    key: "S2", fee: false, requires: [],
    run: async (ctx, friendly) => {
      const digits = await ctx.readEin();
      const payload = businessEndUserAttributes(ctx.inputs, digits);
      return { sid: await ctx.adapter.createEndUser({ friendlyName: friendly, type: payload.type, attributes: payload.attributes }) };
    },
  },
  {
    key: "S3", fee: false, requires: [],
    run: async (ctx, friendly) => {
      const payload = representativeEndUserAttributes(ctx.inputs);
      return { sid: await ctx.adapter.createEndUser({ friendlyName: friendly, type: payload.type, attributes: payload.attributes }) };
    },
  },
  { key: "S4", fee: false, requires: [], run: async (ctx) => ({ sid: await ctx.adapter.createAddress(addressInput(ctx.inputs)) }) },
  {
    key: "S5", fee: false, requires: ["S4"],
    run: async (ctx, friendly) => ({ sid: await ctx.adapter.createSupportingDocument({ friendlyName: friendly, addressSid: need(ctx, "S4") }) }),
  },
  { key: "S6", fee: false, requires: ["S1", "S2"], run: async (ctx) => ({ sid: await ctx.adapter.assignToCustomerProfile(need(ctx, "S1"), need(ctx, "S2")) }) },
  { key: "S7", fee: false, requires: ["S1", "S3"], run: async (ctx) => ({ sid: await ctx.adapter.assignToCustomerProfile(need(ctx, "S1"), need(ctx, "S3")) }) },
  { key: "S8", fee: false, requires: ["S1", "S5"], run: async (ctx) => ({ sid: await ctx.adapter.assignToCustomerProfile(need(ctx, "S1"), need(ctx, "S5")) }) },
  { key: "S9", fee: false, requires: ["S1"], run: async (ctx) => ({ sid: await ctx.adapter.assignToCustomerProfile(need(ctx, "S1"), ctx.config.primaryProfileSid) }) },
  {
    key: "S10", fee: false, requires: ["S6", "S7", "S8", "S9"],
    run: async (ctx) => {
      const { evaluationSid, result } = await ctx.adapter.evaluateCustomerProfile(need(ctx, "S1"));
      return { sid: evaluationSid, failedFields: result.status === "compliant" ? undefined : result.failedFields };
    },
  },
  { key: "S11", fee: false, requires: ["S10"], run: async (ctx) => ({ sid: await ctx.adapter.submitCustomerProfile(need(ctx, "S1")) }) },
  {
    key: "T1", fee: false, requires: ["S11"],
    find: (ctx, friendly) => ctx.adapter.findTrustProduct(friendly),
    run: async (ctx, friendly) => ({ sid: await ctx.adapter.createTrustProduct({ friendlyName: friendly, email: ctx.config.complianceEmail }) }),
  },
  {
    key: "T2", fee: false, requires: ["T1"],
    run: async (ctx, friendly) => {
      const payload = a2pEndUserAttributes(ctx.inputs);
      return { sid: await ctx.adapter.createEndUser({ friendlyName: friendly, type: payload.type, attributes: payload.attributes }) };
    },
  },
  { key: "T3", fee: false, requires: ["T1", "T2"], run: async (ctx) => ({ sid: await ctx.adapter.assignToTrustProduct(need(ctx, "T1"), need(ctx, "T2")) }) },
  { key: "T4", fee: false, requires: ["T1", "S1"], run: async (ctx) => ({ sid: await ctx.adapter.assignToTrustProduct(need(ctx, "T1"), need(ctx, "S1")) }) },
  {
    key: "T5", fee: false, requires: ["T3", "T4"],
    run: async (ctx) => {
      const { evaluationSid, result } = await ctx.adapter.evaluateTrustProduct(need(ctx, "T1"));
      return { sid: evaluationSid, failedFields: result.status === "compliant" ? undefined : result.failedFields };
    },
  },
  { key: "T6", fee: false, requires: ["T5"], run: async (ctx) => ({ sid: await ctx.adapter.submitTrustProduct(need(ctx, "T1")) }) },
  {
    key: "B1", fee: true, requires: ["S11", "T6"],
    find: (ctx) => ctx.adapter.findBrand({ customerProfileSid: need(ctx, "S1"), trustProductSid: need(ctx, "T1") }),
    run: async (ctx) => ({
      sid: await ctx.adapter.createBrand({
        customerProfileSid: need(ctx, "S1"), trustProductSid: need(ctx, "T1"),
        // Standard brand (owner decision for the ConfiDance pilot); automatic secondary vetting stays ON for Standard.
        brandType: "STANDARD", skipAutomaticSecVet: false, mock: ctx.config.mockBrand,
      }),
    }),
  },
];

if (STEPS.map((step) => step.key).join(",") !== ISV_STEP_KEYS.join(",")) throw new Error("runner step list and ISV_STEP_KEYS disagree");

const BRAND_MAP: Record<string, "in_review" | "approved" | "rejected" | "suspended" | null> = {
  PENDING: "in_review", IN_REVIEW: "in_review", APPROVED: "approved", FAILED: "rejected", SUSPENDED: "suspended",
};

function sanitizedDetail(error: unknown): string {
  if (error instanceof IsvApiError) return `${error.kind}${error.twilioCode ? `:${error.twilioCode}` : ""}${error.httpStatus ? `:http${error.httpStatus}` : ""}`;
  if (error instanceof PayloadError) return `payload:${error.field}`;
  if (error instanceof EinCryptoError) return `ein:${error.code}`;
  return "unexpected";
}

export async function runBrandSubmission(input: RunInput): Promise<RunResult> {
  const { store, adapter, config, studioId, actorId } = input;
  const decrypt = input.decrypt ?? decryptEin;
  const maxSteps = input.maxSteps ?? STEPS.length;
  const leaseOwner = `run-${randomUUID().slice(0, 8)}`;
  const stepsRun: IsvStepKey[] = [];

  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner);
  } catch (error) {
    const code = error instanceof RunnerStoreError ? error.code : "unknown";
    if (code === "55P03") return { outcome: "lease_busy", stepsRun };
    if (code === "TW001") return { outcome: "runner_closed", stepsRun };
    return { outcome: "not_runnable", stepsRun, detail: code };
  }
  const onboardingId = claim.onboarding_id;

  try {
    // Preflight: nothing is created unless the ISV Primary profile is Twilio-approved right now.
    let primary: { status: string; policySid: string | null };
    try {
      primary = await adapter.getCustomerProfile(config.primaryProfileSid);
    } catch (error) {
      return { outcome: error instanceof IsvApiError && error.kind === "transient" ? "retry_later" : "exception", stepsRun, detail: `preflight:${sanitizedDetail(error)}` };
    }
    if (primary.status !== "twilio-approved") return { outcome: "exception", stepsRun, detail: "preflight:primary_profile_not_approved" };
    // any approved profile in the account would pass the status test: it must also be the ISV Primary profile (its policy)
    if (primary.policySid !== config.primaryProfilePolicySid) return { outcome: "exception", stepsRun, detail: "preflight:primary_profile_policy_mismatch" };

    const inputs = await store.getInputs(onboardingId, leaseOwner);
    if (inputs.missing.length > 0) {
      await store.transition(onboardingId, leaseOwner, "needs_info", "preflight", "incomplete", safeField(firstWizardField(inputs.missing) ?? inputs.missing[0]));
      return { outcome: "needs_info", stepsRun, detail: `missing:${inputs.missing.join(",")}`, state: "needs_info" };
    }

    const ctx: Ctx = {
      adapter, config, inputs, sids: {},
      readEin: async () => {
        const row = await store.getEin(onboardingId, leaseOwner, actorId);
        // the key id stored beside the token must be the one inside it (the token is <keyId>.<iv>.<tag>.<data>)
        if (row.ciphertext.split(".")[0] !== row.keyId) throw new EinCryptoError("format_invalid");
        return decrypt(row.studioId, row.ciphertext);
      },
    };
    for (const step of claim.steps) if (step.status === "succeeded" && step.provider_sid) ctx.sids[step.step_key] = step.provider_sid;

    let state = claim.state;
    const move = async (to: RunnerTransitionState, step: string, code: string | null, field: string | null) => {
      state = await store.transition(onboardingId, leaseOwner, to, step, code, field);
    };
    // The onboarding moves to profile_review once the profile is submitted (S11), whether this run executed S11 or an earlier run did
    // (skip after a crash between the ledger write and the state change): the 4A graph only allows profile_review -> brand_pending.
    const syncReview = async () => {
      if (ctx.sids.S11 && state === "submitted_for_checks") await move("profile_review", "S11", null, null);
    };

    for (const step of STEPS) {
      await syncReview();
      if (ctx.sids[step.key]) continue;
      if (stepsRun.length >= maxSteps) break;
      for (const dependency of step.requires) {
        if (!ctx.sids[dependency]) {
          await move("exception", step.key, "dependency_missing", null);
          return { outcome: "exception", stepsRun, detail: `dependency:${dependency}`, state };
        }
      }
      if (step.fee && !input.confirmFee) {
        return { outcome: "waiting_fee_confirmation", stepsRun, state };
      }

      const friendly = stepFriendlyName(config.envName, studioId, step.key, claim.submission_seq);
      let begun;
      try {
        begun = await store.beginStep(onboardingId, leaseOwner, step.key, friendly, step.fee, step.fee ? actorId : null, step.fee ? config.mockBrand : false);
      } catch (error) {
        if (error instanceof RunnerStoreError && error.code === "TW001") {
          // the runner window was closed while this run was in progress: stop before the next step (and before any paid one)
          return { outcome: "runner_closed", stepsRun, state };
        }
        if (error instanceof RunnerStoreError && error.code === "55000") {
          // the studio already has a brand (or an unresolved attempt): never buy a second one; a human decides
          await move("exception", step.key, "brand_exists", null);
          return { outcome: "exception", stepsRun, detail: `${step.key}:brand_exists`, state };
        }
        throw error;
      }
      if (begun.action === "skip") {
        if (begun.provider_sid) ctx.sids[step.key] = begun.provider_sid;
        continue;
      }

      let ambiguous = false;
      if (begun.action === "reconcile") {
        ambiguous = true;
        if (step.find) {
          let found: string[];
          try {
            found = await step.find(ctx, friendly);
          } catch (error) {
            await store.finishStep(onboardingId, leaseOwner, step.key, { status: "unknown_outcome", errorCode: "reconcile_failed", errorDetail: sanitizedDetail(error) });
            return { outcome: "retry_later", stepsRun, detail: `reconcile:${step.key}`, state };
          }
          if (found.length === 1) {
            await store.finishStep(onboardingId, leaseOwner, step.key, { status: "succeeded", providerSid: found[0] });
            ctx.sids[step.key] = found[0];
            stepsRun.push(step.key);
            continue;
          }
          if (found.length > 1 || step.fee) {
            // Several candidates, or a paid step whose outcome is still unknown: never guess, never re-create.
            await store.finishStep(onboardingId, leaseOwner, step.key, { status: "unknown_outcome", errorCode: found.length > 1 ? "ambiguous_match" : "ambiguous_fee_step", errorDetail: `candidates:${found.length}` });
            await move("exception", step.key, found.length > 1 ? "ambiguous_match" : "ambiguous_fee_step", null);
            return { outcome: "exception", stepsRun, detail: `${step.key}:${found.length > 1 ? "ambiguous_match" : "ambiguous_fee_step"}`, state };
          }
        } else if (step.fee) {
          await move("exception", step.key, "ambiguous_fee_step", null);
          return { outcome: "exception", stepsRun, detail: `${step.key}:ambiguous_fee_step`, state };
        }
        // nothing found for a free step: it is safe to execute it again
      }

      // Always look before creating a resource Twilio lets us look up (profile, trust product, brand): a previous attempt may have
      // produced it even if our ledger never heard back.
      if (begun.action === "execute" && step.find) {
        let existing: string[];
        try {
          existing = await step.find(ctx, friendly);
        } catch (error) {
          await store.finishStep(onboardingId, leaseOwner, step.key, { status: "unknown_outcome", errorCode: "lookup_failed", errorDetail: sanitizedDetail(error) });
          return { outcome: "retry_later", stepsRun, detail: `lookup:${step.key}`, state };
        }
        if (existing.length === 1) {
          await store.finishStep(onboardingId, leaseOwner, step.key, { status: "succeeded", providerSid: existing[0] });
          ctx.sids[step.key] = existing[0];
          stepsRun.push(step.key);
          continue;
        }
        if (existing.length > 1) {
          await store.finishStep(onboardingId, leaseOwner, step.key, { status: "unknown_outcome", errorCode: "ambiguous_match", errorDetail: `candidates:${existing.length}` });
          await move("exception", step.key, "ambiguous_match", null);
          return { outcome: "exception", stepsRun, detail: `${step.key}:ambiguous_match`, state };
        }
      }

      let result: StepResult;
      try {
        result = await step.run(ctx, friendly);
      } catch (error) {
        const detail = sanitizedDetail(error);
        if (error instanceof PayloadError) {
          await store.finishStep(onboardingId, leaseOwner, step.key, { status: "failed", errorCode: "payload", errorDetail: detail });
          await move("needs_info", step.key, "payload", safeField(error.field));
          return { outcome: "needs_info", stepsRun, detail: `${step.key}:${detail}`, state };
        }
        // Only a DEFINITE refusal (a parsed 4xx, bad credentials) or a failure that happened before anything was sent (our own EIN
        // decryption) is recorded as failed. Anything else (network, timeout, 429/5xx, unreadable or SID-less success reply, or an
        // error we do not recognize) may have created the resource, so it is recorded as unknown and reconciled before any retry.
        const definite = error instanceof EinCryptoError || (error instanceof IsvApiError && (error.kind === "validation" || error.kind === "account"));
        if (!definite) {
          await store.finishStep(onboardingId, leaseOwner, step.key, { status: "unknown_outcome", errorCode: "unclear_outcome", errorDetail: detail });
          return { outcome: "retry_later", stepsRun, detail: `${step.key}:${detail}`, state };
        }
        await store.finishStep(onboardingId, leaseOwner, step.key, { status: "failed", errorCode: ambiguous ? "ambiguous_rejected" : "api", errorDetail: detail });
        await move("exception", step.key, ambiguous ? "ambiguous_rejected" : "api", null);
        return { outcome: "exception", stepsRun, detail: `${step.key}:${detail}`, state };
      }

      if (result.failedFields && result.failedFields.length > 0) {
        const field = firstWizardField(result.failedFields);
        await store.finishStep(onboardingId, leaseOwner, step.key, { status: "failed", errorCode: "noncompliant", errorDetail: `fields:${result.failedFields.join(",").slice(0, 400)}` });
        if (field) {
          await move("needs_info", step.key, "noncompliant", safeField(field));
          return { outcome: "needs_info", stepsRun, detail: `${step.key}:noncompliant:${field}`, state };
        }
        await move("exception", step.key, "noncompliant_unmapped", null);
        return { outcome: "exception", stepsRun, detail: `${step.key}:noncompliant_unmapped`, state };
      }

      await store.finishStep(onboardingId, leaseOwner, step.key, { status: "succeeded", providerSid: result.sid });
      ctx.sids[step.key] = result.sid;
      stepsRun.push(step.key);

    }

    await syncReview();
    if (!ctx.sids.B1) return { outcome: "retry_later", stepsRun, detail: "step_limit", state };

    // The brand exists: mirror it, and follow it.
    const recorded = claim.steps.find((row) => row.step_key === "B1" && row.status === "succeeded");
    const mock = recorded ? Boolean(recorded.mock) : config.mockBrand;
    return await followBrand({ store, adapter, onboardingId, leaseOwner, brandSid: ctx.sids.B1, stepsRun, state, justCreated: stepsRun.includes("B1"), mock });
  } finally {
    try {
      await store.release(onboardingId, leaseOwner);
    } catch {
      /* the lease expires by itself */
    }
  }
}

async function followBrand(args: {
  store: RunnerStore; adapter: IsvAdapter; onboardingId: string; leaseOwner: string; brandSid: string; stepsRun: IsvStepKey[]; state: string; justCreated: boolean; mock: boolean;
}): Promise<RunResult> {
  const { store, adapter, onboardingId, leaseOwner, brandSid, stepsRun } = args;
  let rawStatus: string;
  try {
    rawStatus = String(await adapter.getBrandStatus(brandSid));
  } catch (error) {
    return { outcome: "retry_later", stepsRun, detail: `brand_status:${sanitizedDetail(error)}`, state: args.state };
  }
  if (args.mock) {
    // A Twilio MOCK brand is a dry run: it is never mirrored into the registration and can never approve the onboarding.
    const state = await store.transition(onboardingId, leaseOwner, "brand_pending", "B1", null, null);
    return { outcome: args.justCreated ? "brand_submitted" : "brand_in_review", stepsRun, detail: "mock_brand", state };
  }
  const mapped = BRAND_MAP[rawStatus] ?? null;
  try {
    if (!mapped) {
      await store.transition(onboardingId, leaseOwner, "exception", "B1", "brand_unexpected_status", null);
      return { outcome: "exception", stepsRun, detail: "brand:unexpected_status", state: "exception" };
    }
    await store.recordBrand(onboardingId, leaseOwner, brandSid, mapped);
    if (mapped === "approved") {
      await store.transition(onboardingId, leaseOwner, "brand_pending", "B1", null, null); // idempotent; the first pass is still profile_review
      const state = await store.brandApproved(onboardingId, leaseOwner);
      return { outcome: "brand_approved", stepsRun, state };
    }
    if (mapped === "rejected" || mapped === "suspended") {
      await store.transition(onboardingId, leaseOwner, "exception", "B1", mapped === "rejected" ? "brand_rejected" : "brand_suspended", null);
      return { outcome: "exception", stepsRun, detail: `brand:${mapped}`, state: "exception" };
    }
    const state = await store.transition(onboardingId, leaseOwner, "brand_pending", "B1", null, null);
    return { outcome: args.justCreated ? "brand_submitted" : "brand_in_review", stepsRun, state };
  } catch (error) {
    // The paid brand exists at Twilio but we could not record it: say so plainly (the ledger already holds its sid) instead of throwing.
    if (error instanceof RunnerStoreError) return { outcome: "exception", stepsRun, detail: `brand_mirror_failed:${error.code}`, state: args.state };
    throw error;
  }
}

/** "Check brand status": GET-only. Mirrors the brand into the registration row and finishes the onboarding step when approved. */
export async function refreshBrandStatus(input: Pick<RunInput, "store" | "adapter" | "studioId" | "actorId">): Promise<RunResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `refresh-${randomUUID().slice(0, 8)}`;
  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner, 120, "refresh");
  } catch (error) {
    const code = error instanceof RunnerStoreError ? error.code : "unknown";
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", stepsRun: [], detail: code };
  }
  try {
    const brand = claim.steps.find((step) => step.step_key === "B1" && step.status === "succeeded" && step.provider_sid);
    if (!brand?.provider_sid) return { outcome: "not_runnable", stepsRun: [], detail: "no_brand" };
    return await followBrand({ store, adapter, onboardingId: claim.onboarding_id, leaseOwner, brandSid: brand.provider_sid, stepsRun: [], state: claim.state, justCreated: false, mock: Boolean(brand.mock) });
  } finally {
    try {
      await store.release(claim.onboarding_id, leaseOwner);
    } catch {
      /* lease expires */
    }
  }
}
