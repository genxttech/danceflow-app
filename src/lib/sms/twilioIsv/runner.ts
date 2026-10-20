import { decryptEin, EinCryptoError } from "@/lib/sms/onboarding/ein";
import { randomUUID } from "node:crypto";
import type { IsvConfig } from "./config";
import {
  PayloadError, a2pEndUserAttributes, addressInput, businessEndUserAttributes, firstWizardField, representativeEndUserAttributes, safeField, stepFriendlyName,
  type RunnerInputs,
} from "./payloads";
import { RunnerStoreError, type RunnerStore, type RunnerTransitionState } from "./store";
import { paidBrandSupported, registrationPath, type RegistrationPath } from "./registrationPath";
import { IsvApiError, ISV_STEP_KEYS, type IsvAdapter, type IsvStepKey, type PrimaryProfileReader } from "./types";

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
  | "status_checked"
  | "waiting_submission_confirmation"
  | "needs_info"
  | "exception"
  | "retry_later"
  | "lease_busy"
  | "runner_closed"
  | "not_runnable"
  | "config_missing"
  /** TW-4F-3a: the studio has no legal entity or its entity has no active Twilio subaccount yet. Nothing was called. */
  | "needs_subaccount"
  /** TW-4F-3a: the adapter belongs to a different Twilio account than the studio's legal entity subaccount. Nothing was called. */
  | "account_mismatch"
  /** TW-4F-3a: a fee-bearing step has no owner-approved spend within the legal entity's cap. Nothing was called. */
  | "spend_blocked"
  /** TW-4F-3b-0: the funding studio's settled prepaid credit cannot cover a fee-bearing step (or the account is on hold / negative). Nothing was called or charged. */
  | "insufficient_credit"
  /** TW-4F-3b-0: Twilio performed (or definitely did not perform) a fee step but the credit settlement could not be recorded. The reservation stays held for a human. */
  | "settlement_failed"
  /** TW-4F provider integration: the paid brand of this registration tier has no published price yet (Low-Volume Standard). Nothing was reserved or called. */
  | "tier_unpriced";

/** The steps whose Twilio call cannot be undone (a submission for review). Each needs its own explicit confirmation on every run. */
export const SUBMISSION_STEPS = ["S11", "T6"] as const;
export type SubmissionStepKey = (typeof SUBMISSION_STEPS)[number];

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
  /** Never start a step positioned after this one (positional, unlike maxSteps which counts steps executed in this run). Used by the staged validation. */
  stopAfter?: IsvStepKey;
  /**
   * The irreversible submissions the platform admin explicitly confirmed for THIS run only (S11 = submit the profile for Twilio review,
   * T6 = submit the A2P trust product). Default: none. A submission step that is not listed never starts: the run stops with
   * `waiting_submission_confirmation` before any Twilio call or ledger write for that step. Nothing here is stored or reused by a later run.
   */
  confirmSubmit?: readonly SubmissionStepKey[];
  /**
   * Default false (safe): a confirmation is honoured only if the evaluation it relies on (S10 for S11, T5 for T6) was ALREADY `succeeded`
   * in the ledger when this run started, so the confirming click always follows an evaluation a human could read. A run that has to
   * perform that evaluation itself stops at the submission with `waiting_submission_confirmation` (detail `S11:review`), even if confirmed.
   * Only the staged validation harness (Stage C, behind its own authorization token) sets this to true. The platform action never does.
   */
  allowSubmitInSameRunAsEvaluation?: boolean;
  /**
   * TW-4F provider integration: reads the ISV Primary profile with PARENT credentials (it lives in the parent account; a subaccount can assign it but
   * is not known to be able to read it). Every subaccount run passes the parent here. Without it the preflight reads through `adapter`, which is only
   * correct for the single-account validation harness; in a subaccount that read finds nothing and the run stops (fail closed).
   */
  primary?: PrimaryProfileReader;
};

type Ctx = {
  adapter: IsvAdapter;
  config: IsvConfig;
  /** TW-4F provider integration: Standard or Low-Volume Standard, from the database (never guessed). */
  path: RegistrationPath;
  inputs: RunnerInputs;
  sids: Partial<Record<IsvStepKey, string>>;
  /** Evaluations that returned an explicit compliant verdict IN THIS PROCESS. A ledger row from an earlier run never counts as one. */
  verified: Partial<Record<"S10" | "T5", true>>;
  readEin: () => Promise<string>;
};

/**
 * What an evaluation really established. A successful API call (an EL sid came back) is NOT a successful evaluation: only an explicit
 * "compliant" with no failing field lets the step succeed, which is the only way S11 / T6 (submission) can become runnable. Everything
 * else fails closed, including "noncompliant" with no named field and any missing, malformed, unknown or contradictory status.
 */
export type EvaluationVerdict =
  | { kind: "compliant"; failedFields: [] }
  | { kind: "noncompliant"; failedFields: string[] }
  | { kind: "unrecognized"; failedFields: string[] };

export function classifyEvaluation(raw: unknown): EvaluationVerdict {
  const reply = raw !== null && typeof raw === "object" ? (raw as { status?: unknown; failedFields?: unknown }) : {};
  const listed = Array.isArray(reply.failedFields) ? reply.failedFields : null;
  const names = listed ? listed.filter((field): field is string => typeof field === "string") : [];
  const wellFormed = listed !== null && names.length === listed.length;
  if (reply.status === "compliant" && wellFormed && names.length === 0) return { kind: "compliant", failedFields: [] };
  if (reply.status === "noncompliant") return { kind: "noncompliant", failedFields: names };
  return { kind: "unrecognized", failedFields: names };
}

const TWILIO_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,79}$/;
/** Keeps only plain Twilio field NAMES (start with a letter; no spaces, @, or all-digit strings such as an EIN) for the ledger and the report. */
export function safeFieldNames(names: readonly string[]): string[] {
  return names.filter((name) => TWILIO_FIELD_NAME.test(name)).slice(0, 50);
}

type StepResult = { sid: string; evaluation?: EvaluationVerdict };

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
      return { sid: evaluationSid, evaluation: classifyEvaluation(result) };
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
      return { sid: evaluationSid, evaluation: classifyEvaluation(result) };
    },
  },
  { key: "T6", fee: false, requires: ["T5"], run: async (ctx) => ({ sid: await ctx.adapter.submitTrustProduct(need(ctx, "T1")) }) },
  {
    key: "B1", fee: true, requires: ["S11", "T6"],
    find: (ctx) => ctx.adapter.findBrand({ customerProfileSid: need(ctx, "S1"), trustProductSid: need(ctx, "T1") }),
    run: async (ctx) => ({
      sid: await ctx.adapter.createBrand({
        customerProfileSid: need(ctx, "S1"), trustProductSid: need(ctx, "T1"),
        // Both tiers are BrandType STANDARD. Standard (D3, the pilot default) keeps automatic secondary vetting ON; Low-Volume Standard skips it,
        // which Twilio allows only for Low-Volume Standard brands (see registrationPath.ts).
        brandType: ctx.path.brand.brandType, skipAutomaticSecVet: ctx.path.brand.skipAutomaticSecVet, mock: ctx.config.mockBrand,
      }),
    }),
  },
];

if (STEPS.map((step) => step.key).join(",") !== ISV_STEP_KEYS.join(",")) throw new Error("runner step list and ISV_STEP_KEYS disagree");
STEPS.forEach((step) => Object.freeze(step));
Object.freeze(STEPS);

const BRAND_MAP: Record<string, "in_review" | "approved" | "rejected" | "suspended" | null> = {
  PENDING: "in_review", IN_REVIEW: "in_review", APPROVED: "approved", FAILED: "rejected", SUSPENDED: "suspended",
};

function sanitizedDetail(error: unknown): string {
  if (error instanceof IsvApiError) return `${error.kind}${error.twilioCode ? `:${error.twilioCode}` : ""}${error.httpStatus ? `:http${error.httpStatus}` : ""}`;
  if (error instanceof PayloadError) return `payload:${error.field}`;
  if (error instanceof EinCryptoError) return `ein:${error.code}`;
  return "unexpected";
}

/**
 * TW-4F-3a (D2): every Twilio-touching operation runs only in the Twilio SUBACCOUNT of the studio's legal entity, as recorded in the database
 * under this lease. Fail closed: no entity, no active subaccount, a lookup failure or an adapter built for any other account (including the
 * parent) ends the operation BEFORE the first Twilio call or ledger write.
 */
async function accountRefusal(store: RunnerStore, adapter: IsvAdapter, onboardingId: string, leaseOwner: string, state: string): Promise<RunResult | null> {
  let account;
  try {
    account = await store.getAccount(onboardingId, leaseOwner);
  } catch (error) {
    return { outcome: "exception", stepsRun: [], detail: `account:${error instanceof RunnerStoreError ? error.code : "unknown"}`, state };
  }
  if (!account.legalEntityId) return { outcome: "needs_subaccount", stepsRun: [], detail: "no_legal_entity", state };
  if (!account.accountSid) return { outcome: "needs_subaccount", stepsRun: [], detail: "no_subaccount", state };
  if (adapter.accountSid !== account.accountSid) return { outcome: "account_mismatch", stepsRun: [], detail: "adapter_account_differs", state };
  return null;
}

export async function runBrandSubmission(input: RunInput): Promise<RunResult> {
  const { store, adapter, config, studioId, actorId } = input;
  const decrypt = input.decrypt ?? decryptEin;
  const maxSteps = input.maxSteps ?? STEPS.length;
  const stopAfterIndex = input.stopAfter === undefined ? -1 : STEPS.findIndex((step) => step.key === input.stopAfter);
  // A stop point that is not a real step would otherwise mean "no limit": refuse before anything is claimed or called.
  if (input.stopAfter !== undefined && stopAfterIndex < 0) return { outcome: "not_runnable", stepsRun: [], detail: "unknown_stop_after" };
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
    const refused = await accountRefusal(store, adapter, onboardingId, leaseOwner, claim.state);
    if (refused) return { ...refused, stepsRun };

    // Preflight: nothing is created unless the ISV Primary profile is Twilio-approved right now.
    let primary: { status: string; policySid: string | null };
    try {
      primary = input.primary ? await input.primary.getPrimaryProfile() : await adapter.getCustomerProfile(config.primaryProfileSid);
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

    let path: RegistrationPath;
    try {
      path = registrationPath((await store.getTier(onboardingId, leaseOwner)).tier);
    } catch (error) {
      return { outcome: "exception", stepsRun, detail: error instanceof RunnerStoreError ? `tier:${error.code}` : "tier:unknown", state: claim.state };
    }

    const ctx: Ctx = {
      adapter, config, path, inputs, sids: {}, verified: {},
      readEin: async () => {
        const row = await store.getEin(onboardingId, leaseOwner, actorId);
        // the key id stored beside the token must be the one inside it (the token is <keyId>.<iv>.<tag>.<data>)
        if (row.ciphertext.split(".")[0] !== row.keyId) throw new EinCryptoError("format_invalid");
        return decrypt(row.studioId, row.ciphertext);
      },
    };
    for (const step of claim.steps) if (step.status === "succeeded" && step.provider_sid) ctx.sids[step.step_key] = step.provider_sid;
    const evaluatedBeforeRun = { S10: Boolean(ctx.sids.S10), T5: Boolean(ctx.sids.T5) };

    let state = claim.state;
    const move = async (to: RunnerTransitionState, step: string, code: string | null, field: string | null) => {
      state = await store.transition(onboardingId, leaseOwner, to, step, code, field);
    };
    // The onboarding moves to profile_review once the profile is submitted (S11), whether this run executed S11 or an earlier run did
    // (skip after a crash between the ledger write and the state change): the 4A graph only allows profile_review -> brand_pending.
    const syncReview = async () => {
      if (ctx.sids.S11 && state === "submitted_for_checks") await move("profile_review", "S11", null, null);
    };

    // TW-4F-3b-0: closes the credit reservation of a fee step. A paid operation that happened is CAPTURED; one that definitely did not is RELEASED;
    // an unknown outcome is neither (it stays held until a human reconciles). A settlement that cannot be recorded stops the run for a human.
    const settleFee = async (stepKey: IsvStepKey, outcome: "captured" | "released", ref: string): Promise<RunResult | null> => {
      if (stepKey !== "B1" || config.mockBrand) return null;
      try {
        await store.settleSpend(onboardingId, leaseOwner, "brand", outcome, ref);
      } catch (error) {
        return { outcome: "settlement_failed", stepsRun, detail: `${stepKey}:${outcome}:${error instanceof RunnerStoreError ? error.code : "unknown"}`, state };
      }
      return null;
    };

    for (const step of STEPS) {
      await syncReview();
      if (ctx.sids[step.key]) {
        // TW-4F-3b-0: a fee step that already SUCCEEDED (an earlier run died, or its settlement failed, after Twilio accepted it) must be captured:
        // idempotent, a no-op when it already was. A studio from before credits has no reservation, which is fine.
        if (step.fee) {
          const stale = await settleFee(step.key, "captured", ctx.sids[step.key]!);
          if (stale && !stale.detail?.endsWith(":TW004")) return stale;
        }
        continue;
      }
      if (stepsRun.length >= maxSteps) break;
      if (stopAfterIndex >= 0 && STEPS.indexOf(step) > stopAfterIndex) break;
      for (const dependency of step.requires) {
        if (!ctx.sids[dependency]) {
          await move("exception", step.key, "dependency_missing", null);
          return { outcome: "exception", stepsRun, detail: `dependency:${dependency}`, state };
        }
      }
      if (step.key === "S11" || step.key === "T6") {
        // Gate 1: this exact submission must have been confirmed for this run (checked before anything else, so a missing confirmation
        // causes no Twilio call and no ledger write).
        if (!(input.confirmSubmit ?? []).includes(step.key)) {
          // A previous attempt at THIS submission that never finished cleanly may already have reached Twilio: say so (the admin must check).
          const unresolved = claim.steps.some((row) => row.step_key === step.key && (row.status === "in_flight" || row.status === "unknown_outcome"));
          return { outcome: "waiting_submission_confirmation", stepsRun, detail: unresolved ? `${step.key}:attempt_unresolved` : step.key, state };
        }
        // Gate 1b: the confirmation must follow an evaluation that already existed when the run began (see allowSubmitInSameRunAsEvaluation).
        if (!input.allowSubmitInSameRunAsEvaluation && !evaluatedBeforeRun[step.key === "S11" ? "S10" : "T5"]) {
          return { outcome: "waiting_submission_confirmation", stepsRun, detail: `${step.key}:review`, state };
        }
        // Gate 2: submission is irreversible. A `succeeded` S10 / T5 row from an EARLIER run (or older code) records only that an evaluation call
        // finished, never its verdict, so it cannot authorize a submission: unless this process just got an explicit compliant verdict,
        // evaluate again right now and refuse unless the answer is an explicit compliant.
        // Follow-ups (Opus review, accepted P3s): (A) a refused re-check moves the onboarding state but leaves the frozen S10/T5 ledger row
        // `succeeded`; read the state, last_error_code and the stage report `evaluations`, not the ledger alone. (B) a crashed S11/T6 attempt
        // (in_flight / unknown_outcome) is re-checked before reconciliation; a noncompliant answer then needs a human to decide whether the
        // submission went through.
        const evalKey = step.key === "S11" ? "S10" : "T5";
        if (!ctx.verified[evalKey]) {
          let reply: { result: unknown };
          try {
            reply = step.key === "S11" ? await adapter.evaluateCustomerProfile(need(ctx, "S1")) : await adapter.evaluateTrustProduct(need(ctx, "T1"));
          } catch (error) {
            return { outcome: "retry_later", stepsRun, detail: `preverify:${step.key}:${sanitizedDetail(error)}`, state };
          }
          const check = classifyEvaluation((reply as { result?: unknown } | null | undefined)?.result);
          await store.recordEvaluation(onboardingId, leaseOwner, evalKey, check.kind, "preverify");
          if (check.kind !== "compliant") {
            const field = check.kind === "noncompliant" ? firstWizardField(check.failedFields) : null;
            if (field) {
              await move("needs_info", evalKey, "noncompliant", safeField(field));
              return { outcome: "needs_info", stepsRun, detail: `${step.key}:preverify_noncompliant:${field}`, state };
            }
            await move("exception", evalKey, check.kind === "noncompliant" ? "noncompliant_unmapped" : "evaluation_unrecognized", null);
            return { outcome: "exception", stepsRun, detail: `${step.key}:preverify_${check.kind}`, state };
          }
          ctx.verified[evalKey] = true;
        }
      }
      if (step.key === "S11" || step.key === "T6") {
        // The database records the confirmation (who, when, for this lease and generation) and refuses a submission without it: begin_step
        // consumes it. It also refuses an evaluation that has no recorded compliant verdict or that the onboarding was sent back after.
        try {
          await store.confirmSubmission(onboardingId, leaseOwner, step.key, actorId);
        } catch (error) {
          if (error instanceof RunnerStoreError && error.code === "TW002") {
            // The evaluation cannot authorize this submission (no recorded compliant verdict, sent back after it, or the onboarding is not in the
            // submission state). Fail closed AND send the setup back to the owner: resubmitting starts a fresh generation with a fresh evaluation.
            await move("needs_info", step.key, "evaluation_stale", null);
            return { outcome: "needs_info", stepsRun, detail: `${step.key}:evaluation_stale`, state };
          }
          if (error instanceof RunnerStoreError && error.code === "TW001") return { outcome: "runner_closed", stepsRun, state };
          throw error;
        }
      }
      // A paid brand of a tier with no published price would be reserved and captured at the wrong (Standard) price: refuse before asking for the
      // fee confirmation, before any reservation and before any Twilio call. A MOCK brand is free and may use either tier.
      if (step.fee && !config.mockBrand && !paidBrandSupported(ctx.path)) {
        return { outcome: "tier_unpriced", stepsRun, detail: `${step.key}:${ctx.path.tier}`, state };
      }
      if (step.fee && !input.confirmFee) {
        return { outcome: "waiting_fee_confirmation", stepsRun, state };
      }
      if (step.fee && !config.mockBrand) {
        // (a Twilio MOCK brand is a free dry run and consumes no authorization)
        // TW-4F-3a: the owner-approved spend for THIS fee step must exist within the legal entity's cap; it is reserved (once, idempotently) before
        // any Twilio call. No authorization, no fee: the run stops here without a ledger write.
        try {
          await store.reserveSpend(onboardingId, leaseOwner, "brand");
        } catch (error) {
          if (error instanceof RunnerStoreError && error.code === "TW004") return { outcome: "spend_blocked", stepsRun, detail: `${step.key}:no_authorized_spend`, state };
          if (error instanceof RunnerStoreError && error.code === "TW007") return { outcome: "insufficient_credit", stepsRun, detail: `${step.key}:insufficient_credit`, state };
          throw error;
        }
      }

      const friendly = stepFriendlyName(config.envName, studioId, step.key, claim.submission_seq);
      let begun;
      try {
        begun = await store.beginStep(onboardingId, leaseOwner, step.key, friendly, step.fee, step.fee ? actorId : null, step.fee ? config.mockBrand : false);
      } catch (error) {
        if (error instanceof RunnerStoreError && error.code === "TW001") {
          // the runner window was closed while this run was in progress: stop before the next step (and before any paid one)
          await settleFee(step.key, "released", "window_closed");
          return { outcome: "runner_closed", stepsRun, state };
        }
        if (error instanceof RunnerStoreError && (error.code === "TW002" || error.code === "TW003")) {
          // the database refused the submission at the moment it began (no fresh confirmation, or the evaluation went stale): nothing was sent
          return { outcome: "exception", stepsRun, detail: `${step.key}:${error.code === "TW002" ? "evaluation_stale" : "confirmation_missing"}`, state };
        }
        if (error instanceof RunnerStoreError && error.code === "55000") {
          // the studio already has a brand (or an unresolved attempt): never buy a second one; a human decides
          await settleFee(step.key, "released", "brand_exists");
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
            const unsettledFound = await settleFee(step.key, "captured", found[0]);
            if (unsettledFound) return unsettledFound;
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
          const unsettledExisting = await settleFee(step.key, "captured", existing[0]);
          if (unsettledExisting) return unsettledExisting;
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
          await settleFee(step.key, "released", "payload");
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
        // a DEFINITE refusal for an operation that was never accepted (not an ambiguous retry): the reservation is freed
        if (!ambiguous) await settleFee(step.key, "released", "api");
        await move("exception", step.key, ambiguous ? "ambiguous_rejected" : "api", null);
        return { outcome: "exception", stepsRun, detail: `${step.key}:${detail}`, state };
      }

      // An evaluation step can only succeed on an explicit "compliant" verdict; a step that returned no verdict at all is unrecognized too.
      const verdict: EvaluationVerdict | undefined = step.key === "S10" || step.key === "T5" ? (result.evaluation ?? { kind: "unrecognized", failedFields: [] }) : result.evaluation;
      if (step.key === "S10" || step.key === "T5") {
        // The verdict is written onto the still-open ledger row BEFORE the step is finished, so a succeeded S10 / T5 always carries it.
        await store.recordEvaluation(onboardingId, leaseOwner, step.key, verdict?.kind ?? "unrecognized", "step");
      }
      if (verdict && verdict.kind === "unrecognized") {
        // The call succeeded but did not establish compliance (missing / malformed / unknown / contradictory status): fail closed, for a human.
        await store.finishStep(onboardingId, leaseOwner, step.key, { status: "failed", errorCode: "evaluation_unrecognized", errorDetail: `status:unrecognized;fields:${safeFieldNames(verdict.failedFields).join(",").slice(0, 380) || "none"}` });
        await move("exception", step.key, "evaluation_unrecognized", null);
        return { outcome: "exception", stepsRun, detail: `${step.key}:evaluation_unrecognized`, state };
      }
      if (verdict && verdict.kind === "noncompliant") {
        const failedFields = verdict.failedFields;
        const field = firstWizardField(failedFields);
        await store.finishStep(onboardingId, leaseOwner, step.key, { status: "failed", errorCode: "noncompliant", errorDetail: `fields:${safeFieldNames(failedFields).join(",").slice(0, 400) || "none"}` });
        if (field) {
          await move("needs_info", step.key, "noncompliant", safeField(field));
          return { outcome: "needs_info", stepsRun, detail: `${step.key}:noncompliant:${field}`, state };
        }
        await move("exception", step.key, "noncompliant_unmapped", null);
        return { outcome: "exception", stepsRun, detail: `${step.key}:noncompliant_unmapped`, state };
      }

      await store.finishStep(onboardingId, leaseOwner, step.key, { status: "succeeded", providerSid: result.sid });
      ctx.sids[step.key] = result.sid;
      const unsettledCreated = await settleFee(step.key, "captured", result.sid);
      if (unsettledCreated) return unsettledCreated;
      if (step.key === "S10" || step.key === "T5") ctx.verified[step.key] = true; // only reachable with an explicit compliant verdict
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

/** How Twilio's review of a bundle (customer profile / trust product) reads: a closed set, anything else is "unknown". */
export type BundleReviewState = "draft" | "pending-review" | "in-review" | "twilio-approved" | "twilio-rejected" | "unknown";
export function classifyBundleStatus(raw: unknown): BundleReviewState {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (["draft", "pending-review", "in-review", "twilio-approved", "twilio-rejected"] as const).find((state) => state === value) ?? "unknown";
}

/**
 * "Check status": GET-only observation of where Twilio's review of the profile, the trust product and the brand stands. Nothing is
 * created, submitted or paid. The one thing it may do is move a setup whose profile or trust product Twilio REJECTED to `exception`
 * (a human decides; nothing is resubmitted automatically). With a brand it also follows the brand exactly as "Check brand status" did.
 * The result detail lists what was observed, e.g. `profile=in-review;trust_product=twilio-approved`.
 */
export async function checkRegistrationStatus(input: Pick<RunInput, "store" | "adapter" | "studioId" | "actorId">): Promise<RunResult> {
  const { store, adapter, studioId, actorId } = input;
  const leaseOwner = `status-${randomUUID().slice(0, 8)}`;
  let claim;
  try {
    claim = await store.claim(studioId, actorId, leaseOwner, 120, "refresh");
  } catch (error) {
    const code = error instanceof RunnerStoreError ? error.code : "unknown";
    return { outcome: code === "55P03" ? "lease_busy" : "not_runnable", stepsRun: [], detail: code };
  }
  try {
    const refused = await accountRefusal(store, adapter, claim.onboarding_id, leaseOwner, claim.state);
    if (refused) return refused;
    const sid = (key: IsvStepKey) => claim.steps.find((step) => step.step_key === key && step.status === "succeeded" && step.provider_sid)?.provider_sid ?? null;
    const profileSid = sid("S1");
    const trustProductSid = sid("T1");
    const brand = claim.steps.find((step) => step.step_key === "B1" && step.status === "succeeded" && step.provider_sid);
    if (!profileSid && !trustProductSid && !brand?.provider_sid) return { outcome: "not_runnable", stepsRun: [], detail: "nothing_to_check" };

    const observed: string[] = [];
    let profile: BundleReviewState | null = null;
    let trustProduct: BundleReviewState | null = null;
    try {
      if (profileSid) profile = classifyBundleStatus((await adapter.getCustomerProfile(profileSid)).status);
      if (trustProductSid) trustProduct = classifyBundleStatus((await adapter.getTrustProductStatus(trustProductSid)).status);
    } catch (error) {
      return { outcome: "retry_later", stepsRun: [], detail: `status:${sanitizedDetail(error)}`, state: claim.state };
    }
    if (profile) observed.push(`profile=${profile}`);
    if (trustProduct) observed.push(`trust_product=${trustProduct}`);

    // a rejected bundle is for a human: never resubmitted or recreated here (the paid brand step is never reached for it)
    const rejected = profile === "twilio-rejected" ? "profile_rejected" : trustProduct === "twilio-rejected" ? "trust_product_rejected" : null;
    if (rejected && claim.state !== "exception") {
      const state = await store.transition(claim.onboarding_id, leaseOwner, "exception", rejected === "profile_rejected" ? "S11" : "T6", rejected, null);
      return { outcome: "exception", stepsRun: [], detail: [rejected, ...observed].join(";"), state };
    }

    if (brand?.provider_sid) {
      const followed = await followBrand({ store, adapter, onboardingId: claim.onboarding_id, leaseOwner, brandSid: brand.provider_sid, stepsRun: [], state: claim.state, justCreated: false, mock: Boolean(brand.mock) });
      return { ...followed, detail: [followed.detail, ...observed].filter(Boolean).join(";") || undefined };
    }
    return { outcome: "status_checked", stepsRun: [], detail: observed.join(";"), state: claim.state };
  } finally {
    try {
      await store.release(claim.onboarding_id, leaseOwner);
    } catch {
      /* lease expires */
    }
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
    const refused = await accountRefusal(store, adapter, claim.onboarding_id, leaseOwner, claim.state);
    if (refused) return refused;
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
