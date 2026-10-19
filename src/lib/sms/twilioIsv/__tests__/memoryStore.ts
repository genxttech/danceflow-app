import { canTransition, type OnboardingState } from "@/lib/sms/onboarding/stateMachine";
import type { RunnerInputs } from "../payloads";
import { DEFAULT_FAKE_ACCOUNT_SID } from "../fake";
import { RunnerStoreError, type BeginResult, type Claim, type LedgerStep, type RunnerAccount, type RunnerStatus, type RunnerStore, type RunnerTransitionState, type SpendKind } from "../store";
import type { IsvStepKey } from "../types";

type Confirmation = { step: "S11" | "T6"; seq: number; by: string; owner: string; at: number; consumed: boolean; expired: boolean };

/**
 * Test double for `RunnerStore` that mirrors the semantics of the SQL functions (lease, ledger protocol, fee confirmation,
 * state graph, brand mirror, EIN purge on brand approval). The real functions are tested separately in
 * `test_T_twilio_tw4_r1_runner.sql` and against a real schema in `localStack.tw4_r1.test.ts`.
 */

type Row = { verdict?: string | null; finishedAt?: number; mock: boolean; step_key: IsvStepKey; seq: number; status: LedgerStep["status"]; provider_sid: string | null; fee_bearing: boolean; fee_confirmed_by: string | null; error_code: string | null; error_detail: string | null };

export class MemoryRunnerStore implements RunnerStore {
  state: OnboardingState = "submitted_for_checks";
  seq = 1;
  leaseOwner: string | null = null;
  ledger: Row[] = [];
  registration: { brand_sid: string; brand_status: string; customer_profile_sid: string } | null = null;
  einCiphertext: string | null;
  einPurged = false;
  audit: string[] = [];
  lastErrorField: string | null = null;
  einReads = 0;
  platformAdmins = new Set<string>();
  switchOn = true;
  windowOpen = true;
  /** An earlier brand attempt for this studio that is not a definite failure (another generation). */
  priorBrandAttempt = false;
  claimModes: string[] = [];
  /** Mirrors studio_sms_submission_confirmations (TW-4F-1b). */
  confirmations: Confirmation[] = [];
  /** Mirrors the audit trail for the evaluation evidence: one line per event. */
  evaluationEvents: string[] = [];
  private clock = 0;
  private stateEvents: { n: number; to: string }[] = [];

  constructor(public inputs: RunnerInputs, einCiphertext: string | null, public readonly studioId = inputs.studio_id) {
    this.einCiphertext = einCiphertext;
  }

  private current(step: IsvStepKey) {
    return this.ledger.find((row) => row.step_key === step && row.seq === this.seq);
  }

  private lease(owner: string) {
    if (this.leaseOwner !== owner) throw new RunnerStoreError("55P03");
  }

  async setWindow(_studioId: string, actorId: string, hours: number): Promise<string> {
    if (!this.platformAdmins.has(actorId)) throw new RunnerStoreError("42501");
    this.windowOpen = hours > 0;
    return new Date().toISOString();
  }

  async claim(studioId: string, actorId: string, leaseOwner: string, _seconds?: number, mode: "run" | "refresh" = "run"): Promise<Claim> {
    this.claimModes.push(mode);
    if (!this.platformAdmins.has(actorId)) throw new RunnerStoreError("42501");
    if (!this.switchOn) throw new RunnerStoreError("42501");
    if (mode === "run" && !this.windowOpen) throw new RunnerStoreError("TW001");
    if (studioId !== this.studioId) throw new RunnerStoreError("22023");
    if (!["submitted_for_checks", "profile_review", "brand_pending"].includes(this.state)) throw new RunnerStoreError("22023");
    if (this.leaseOwner && this.leaseOwner !== leaseOwner) throw new RunnerStoreError("55P03");
    this.leaseOwner = leaseOwner;
    return {
      onboarding_id: "onb-1", studio_id: this.studioId, state: this.state, submission_seq: this.seq,
      steps: this.ledger.filter((row) => row.seq === this.seq).map((row) => ({ step_key: row.step_key, status: row.status, provider_sid: row.provider_sid, fee_bearing: row.fee_bearing, mock: row.mock })),
    };
  }

  async release(_id: string, owner: string) {
    if (this.leaseOwner === owner) this.leaseOwner = null;
  }

  async getInputs(_id: string, owner: string) {
    this.lease(owner);
    return { ...this.inputs, submission_seq: this.seq, state: this.state };
  }

  async getEin(_id: string, owner: string, actorId: string) {
    if (!this.platformAdmins.has(actorId)) throw new RunnerStoreError("42501");
    this.lease(owner);
    if (!this.einCiphertext) throw new RunnerStoreError("22023");
    this.einReads += 1;
    return { studioId: this.studioId, ciphertext: this.einCiphertext, keyId: "v1" };
  }

  async beginStep(_id: string, owner: string, step: IsvStepKey, _friendly: string, fee: boolean, confirmedBy: string | null, mock = false): Promise<BeginResult> {
    this.lease(owner);
    if (fee !== (step === "B1") || (mock && step !== "B1")) throw new RunnerStoreError("22023");
    if (!this.windowOpen) throw new RunnerStoreError("TW001"); // R1.1: every step needs an open window when it begins
    const row = this.current(step);
    if (row?.status === "succeeded") return { action: "skip", provider_sid: row.provider_sid };
    if (step === "S11" || step === "T6") {
      // (parity with the SQL, in order) a submission (also its reconcile / retry) needs a fresh confirmation held by THIS lease, consumed once (SQLSTATE TW003 without)
      const confirmation = this.confirmations.filter((c) => c.step === step && c.seq === this.seq && c.owner === owner && !c.consumed && !c.expired).at(-1);
      if (!confirmation) throw new RunnerStoreError("TW003");
      if (this.submissionCheck(step) !== "ok") throw new RunnerStoreError("TW002");
      confirmation.consumed = true;
    }
    if (row && (row.status === "in_flight" || row.status === "unknown_outcome")) return { action: "reconcile", provider_sid: row.provider_sid, status: row.status };
    if (fee && !(confirmedBy && this.platformAdmins.has(confirmedBy))) throw new RunnerStoreError("42501");
    if (fee) {
      const otherAttempt = this.priorBrandAttempt || this.ledger.some((r) => r.step_key === "B1" && r !== row && r.status !== "failed");
      if (this.registration?.brand_sid || otherAttempt) throw new RunnerStoreError("55000");
    }
    if (row) {
      Object.assign(row, { verdict: null, status: "in_flight", fee_bearing: fee, fee_confirmed_by: fee ? confirmedBy : null, error_code: null, error_detail: null, mock });
    } else {
      this.ledger.push({ step_key: step, seq: this.seq, status: "in_flight", provider_sid: null, fee_bearing: fee, fee_confirmed_by: fee ? confirmedBy : null, error_code: null, error_detail: null, mock });
    }
    return { action: "execute" };
  }

  async finishStep(_id: string, owner: string, step: IsvStepKey, outcome: { status: "succeeded" | "failed" | "unknown_outcome"; providerSid?: string | null; errorCode?: string | null; errorDetail?: string | null }) {
    this.lease(owner);
    const row = this.current(step);
    if (!row) throw new RunnerStoreError("22023");
    if (row.status !== "in_flight" && row.status !== "unknown_outcome") throw new RunnerStoreError("22023");
    if (outcome.status === "succeeded" && !/^[A-Za-z]{2}[0-9a-fA-F]{32}$/.test(String(outcome.providerSid ?? ""))) throw new RunnerStoreError("22023");
    if (outcome.status === "succeeded" && (step === "S10" || step === "T5") && row.verdict !== "compliant") throw new RunnerStoreError("22023");
    row.status = outcome.status;
    row.provider_sid = outcome.providerSid ?? row.provider_sid;
    row.error_code = outcome.errorCode ?? null;
    row.error_detail = outcome.errorDetail ?? null;
    row.finishedAt = ++this.clock;
    this.audit.push(`runner_step:${step}:${outcome.status}`);
  }

  async transition(_id: string, owner: string, to: RunnerTransitionState, _step: string, _code: string | null, field: string | null) {
    this.lease(owner);
    if (this.state === to) return this.state;
    if (!canTransition(this.state, to)) throw new RunnerStoreError("22023");
    this.state = to;
    this.lastErrorField = field;
    this.stateEvents.push({ n: ++this.clock, to });
    this.audit.push(`state:${to}`);
    return this.state;
  }

  async recordBrand(_id: string, owner: string, brandSid: string, status: "in_review" | "approved" | "rejected" | "suspended") {
    this.lease(owner);
    const profile = this.current("S1");
    if (!profile || profile.status !== "succeeded") throw new RunnerStoreError("22023");
    const b1 = this.current("B1");
    if (!b1 || b1.status !== "succeeded" || b1.provider_sid !== brandSid || b1.mock) throw new RunnerStoreError("22023");
    if (this.registration && this.registration.brand_sid !== brandSid) throw new RunnerStoreError("22023");
    this.registration = { brand_sid: brandSid, brand_status: status, customer_profile_sid: profile.provider_sid! };
  }

  async brandApproved(_id: string, owner: string) {
    this.lease(owner);
    if (this.state !== "brand_pending" || this.registration?.brand_status !== "approved" || this.current("B1")?.mock) throw new RunnerStoreError("22023");
    this.state = "service_setup";
    this.einCiphertext = null;
    this.einPurged = true;
    return this.state;
  }

  /** Mirrors public._tw4f1b_submission_check. */
  private submissionCheck(step: "S11" | "T6"): "ok" | "state" | "missing" | "unverified" | "stale" {
    if (this.state !== (step === "S11" ? "submitted_for_checks" : "profile_review")) return "state";
    const pre = this.current(step === "S11" ? "S10" : "T5");
    if (!pre || pre.status !== "succeeded") return "missing";
    if (pre.verdict !== "compliant" || pre.finishedAt === undefined) return "unverified";
    if (this.stateEvents.some((event) => (event.to === "needs_info" || event.to === "exception") && event.n >= (pre.finishedAt ?? 0))) return "stale";
    return "ok";
  }

  async confirmSubmission(_id: string, owner: string, step: "S11" | "T6", actorId: string) {
    this.lease(owner);
    if (!this.platformAdmins.has(actorId)) throw new RunnerStoreError("42501");
    if (step !== "S11" && step !== "T6") throw new RunnerStoreError("22023");
    if (!this.windowOpen) throw new RunnerStoreError("TW001");
    const check = this.submissionCheck(step);
    if (check === "missing") throw new RunnerStoreError("22023");
    if (check !== "ok") throw new RunnerStoreError("TW002");
    this.confirmations.push({ step, seq: this.seq, by: actorId, owner, at: ++this.clock, consumed: false, expired: false });
    this.audit.push(`submission_confirmed:${step}`);
  }

  async recordEvaluation(_id: string, owner: string, step: "S10" | "T5", verdict: "compliant" | "noncompliant" | "unrecognized", context: "step" | "preverify") {
    this.lease(owner);
    if (context === "step") {
      const row = this.current(step);
      if (!row || (row.status !== "in_flight" && row.status !== "unknown_outcome")) throw new RunnerStoreError("22023");
      row.verdict = verdict;
    }
    this.evaluationEvents.push(`${step}:${verdict}:${context}`);
  }

  /** Test helper: the onboarding was sent back (needs_info / exception) AFTER the evaluation, as the audit trail would show. */
  sendBackAfterEvaluation(to: "needs_info" | "exception") {
    this.stateEvents.push({ n: ++this.clock, to });
  }

  /** Test helper: the 15-minute freshness window of the SQL function has passed for every unconsumed confirmation. */
  expireConfirmations() {
    for (const c of this.confirmations) if (!c.consumed) c.expired = true;
  }

  async status(): Promise<RunnerStatus> {
    return null;
  }

  /** TW-4F-3a: the studio's legal entity and active subaccount (the default account of a FakeIsvAdapter). Set to nulls to model "not provisioned". */
  account: RunnerAccount = { legalEntityId: "ent-1", accountSid: DEFAULT_FAKE_ACCOUNT_SID, status: "active" };
  /** TW-4F-3a: whether the owner authorized (and the cap allows) the brand fee. */
  spendAuthorized = true;
  spendReservations: string[] = [];

  async getAccount(_id: string, owner: string): Promise<RunnerAccount> {
    this.lease(owner);
    return { ...this.account };
  }

  async reserveSpend(_id: string, owner: string, kind: SpendKind) {
    this.lease(owner);
    if (!this.spendAuthorized) throw new RunnerStoreError("TW004");
    const key = `${this.seq}:${kind}`;
    if (!this.spendReservations.includes(key)) this.spendReservations.push(key);
    return { spendEventId: `spend-${key}`, amountCents: 1000 };
  }
}
