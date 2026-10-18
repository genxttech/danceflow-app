import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunnerInputs } from "./payloads";
import type { IsvStepKey } from "./types";

/**
 * TW-4 R1: the runner's persistence boundary. The Supabase implementation calls ONLY the service-role `tw4_runner_*`
 * functions (the 4A tables have no API privileges). Errors carry the SQLSTATE and never the database message text.
 */

export class RunnerStoreError extends Error {
  constructor(public readonly code: string) {
    super(`runner store failure (${code})`);
    this.name = "RunnerStoreError";
  }
}

export type LedgerStep = { mock?: boolean; step_key: IsvStepKey; status: "pending" | "in_flight" | "succeeded" | "failed" | "unknown_outcome" | "skipped"; provider_sid: string | null; fee_bearing: boolean };

export type Claim = { onboarding_id: string; studio_id: string; state: string; submission_seq: number; steps: LedgerStep[] };

export type BeginResult = { action: "skip" | "reconcile" | "execute"; provider_sid?: string | null; status?: string };

export type RunnerTransitionState = "profile_review" | "brand_pending" | "needs_info" | "exception";

export type EvaluationVerdictName = "compliant" | "noncompliant" | "unrecognized";

export type RunnerStatus = {
  onboarding_id: string;
  state: string;
  step: string | null;
  submission_seq: number;
  ein_on_file: boolean;
  leased: boolean;
  window_open?: boolean;
  brand_status: string | null;
  steps: { step_key: string; status: string; fee_bearing: boolean; fee_confirmed: boolean; error_code: string | null; evaluation_verdict?: EvaluationVerdictName | null; finished_at?: string | null }[];
  /** Platform-admin confirmations of S11 / T6 in the current generation (who is an id, never a name). */
  confirmations?: { step_key: string; confirmed_by: string; confirmed_at: string; consumed: boolean }[];
  /** The newest evaluation events (audit note format: step=S10;verdict=compliant;context=step;seq=1). */
  evaluations?: { at: string; note: string }[];
} | null;

export interface RunnerStore {
  /** mode "run" may create resources and needs an open runner window; "refresh" only reads Twilio. */
  claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds?: number, mode?: "run" | "refresh"): Promise<Claim>;
  setWindow(studioId: string, actorId: string, hours: number, reason: string): Promise<string>;
  release(onboardingId: string, leaseOwner: string): Promise<void>;
  getInputs(onboardingId: string, leaseOwner: string): Promise<RunnerInputs>;
  getEin(onboardingId: string, leaseOwner: string, actorId: string): Promise<{ studioId: string; ciphertext: string; keyId: string }>;
  beginStep(onboardingId: string, leaseOwner: string, step: IsvStepKey, friendlyName: string, feeBearing: boolean, feeConfirmedBy: string | null, mock?: boolean): Promise<BeginResult>;
  finishStep(
    onboardingId: string,
    leaseOwner: string,
    step: IsvStepKey,
    outcome: { status: "succeeded" | "failed" | "unknown_outcome"; providerSid?: string | null; errorCode?: string | null; errorDetail?: string | null },
  ): Promise<void>;
  transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null, errorField: string | null): Promise<string>;
  recordBrand(onboardingId: string, leaseOwner: string, brandSid: string, status: "in_review" | "approved" | "rejected" | "suspended"): Promise<void>;
  brandApproved(onboardingId: string, leaseOwner: string): Promise<string>;
  /** Records a platform admin's confirmation of ONE irreversible submission (S11 / T6) for this lease. The database refuses a stale or unverdicted evaluation (TW002) and consumes the confirmation when the step begins (TW003 without it). */
  confirmSubmission(onboardingId: string, leaseOwner: string, step: "S11" | "T6", actorId: string): Promise<void>;
  /** Records an evaluation verdict: on the open S10 / T5 ledger row (context "step") or as audit evidence of the fresh re-check (context "preverify"). */
  recordEvaluation(onboardingId: string, leaseOwner: string, step: "S10" | "T5", verdict: EvaluationVerdictName, context: "step" | "preverify"): Promise<void>;
  status(studioId: string, actorId: string): Promise<RunnerStatus>;
}

type Client = Pick<SupabaseClient, "rpc">;

export class SupabaseRunnerStore implements RunnerStore {
  constructor(private readonly admin: Client) {}

  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = (await this.admin.rpc(fn, args)) as { data: unknown; error: { code?: string } | null };
    if (error) throw new RunnerStoreError(String(error.code ?? "unknown"));
    return data as T;
  }

  async claim(studioId: string, actorId: string, leaseOwner: string, leaseSeconds = 300, mode: "run" | "refresh" = "run"): Promise<Claim> {
    return this.call<Claim>("tw4_runner_claim", { p_studio_id: studioId, p_actor: actorId, p_lease_owner: leaseOwner, p_lease_seconds: leaseSeconds, p_mode: mode });
  }

  async setWindow(studioId: string, actorId: string, hours: number, reason: string): Promise<string> {
    return String(await this.call<string>("tw4_runner_set_window", { p_studio_id: studioId, p_actor: actorId, p_hours: hours, p_reason: reason }));
  }

  async release(onboardingId: string, leaseOwner: string): Promise<void> {
    await this.call("tw4_runner_release", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async getInputs(onboardingId: string, leaseOwner: string): Promise<RunnerInputs> {
    return this.call<RunnerInputs>("tw4_runner_get_inputs", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
  }

  async getEin(onboardingId: string, leaseOwner: string, actorId: string) {
    const row = await this.call<{ studio_id: string; ciphertext: string; key_id: string }>("tw4_runner_get_ein", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_actor: actorId });
    return { studioId: row.studio_id, ciphertext: row.ciphertext, keyId: row.key_id };
  }

  async beginStep(onboardingId: string, leaseOwner: string, step: IsvStepKey, friendlyName: string, feeBearing: boolean, feeConfirmedBy: string | null, mock = false): Promise<BeginResult> {
    return this.call<BeginResult>("tw4_runner_begin_step", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_step_key: step, p_friendly_name: friendlyName, p_fee_bearing: feeBearing, p_fee_confirmed_by: feeConfirmedBy, p_mock: mock,
    });
  }

  async finishStep(onboardingId: string, leaseOwner: string, step: IsvStepKey, outcome: { status: "succeeded" | "failed" | "unknown_outcome"; providerSid?: string | null; errorCode?: string | null; errorDetail?: string | null }) {
    await this.call("tw4_runner_finish_step", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_step_key: step, p_status: outcome.status,
      p_provider_sid: outcome.providerSid ?? null, p_error_code: outcome.errorCode ?? null, p_error_detail: outcome.errorDetail ?? null,
    });
  }

  async transition(onboardingId: string, leaseOwner: string, to: RunnerTransitionState, step: string, errorCode: string | null, errorField: string | null): Promise<string> {
    const row = await this.call<{ state: string }>("tw4_runner_transition", {
      p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_to_state: to, p_step: step, p_error_code: errorCode, p_error_field: errorField,
    });
    return String(row?.state ?? "");
  }

  async recordBrand(onboardingId: string, leaseOwner: string, brandSid: string, status: "in_review" | "approved" | "rejected" | "suspended") {
    await this.call("tw4_runner_record_brand", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_brand_sid: brandSid, p_brand_status: status });
  }

  async brandApproved(onboardingId: string, leaseOwner: string): Promise<string> {
    const row = await this.call<{ state: string }>("tw4_runner_brand_approved", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner });
    return String(row?.state ?? "");
  }

  async confirmSubmission(onboardingId: string, leaseOwner: string, step: "S11" | "T6", actorId: string): Promise<void> {
    await this.call("tw4_runner_confirm_submission", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_step_key: step, p_actor: actorId });
  }

  async recordEvaluation(onboardingId: string, leaseOwner: string, step: "S10" | "T5", verdict: EvaluationVerdictName, context: "step" | "preverify"): Promise<void> {
    await this.call("tw4_runner_record_evaluation", { p_onboarding_id: onboardingId, p_lease_owner: leaseOwner, p_step_key: step, p_verdict: verdict, p_context: context });
  }

  async status(studioId: string, actorId: string): Promise<RunnerStatus> {
    return this.call<RunnerStatus>("tw4_runner_status", { p_studio_id: studioId, p_actor: actorId });
  }
}
