import "server-only";
import { isvEnvName, type RealCallsGate } from "./config";
import { IsvApiError } from "./types";

/**
 * TW-4F slice E: EMERGENCY Twilio subaccount suspension and reactivation (design: docs/twilio/TW-4F_Emergency_Subaccount_Suspension.md). SERVER ONLY.
 *
 * NOT a spending ceiling: a suspended subaccount keeps paying for its numbers, accepted messages can still bill, and whether inbound attempts or
 * campaign / brand monthly fees bill while suspended is NOT verified. NOT a response to low credit: no cron, credit check, alert, webhook or reconciler
 * may call this module (enforced by suspension.noAutomation.test.ts). The only callers are the platform-administrator server actions.
 *
 * Suspension also blocks INBOUND SMS: a texter's STOP sent while suspended may never reach DanceFlow (compliance-critical; see the design, section 2.1).
 *
 * Flow: begin (the administrator's own token; the database checks session, registered admin, switch, identity, typed confirmation, idempotency, one open
 * attempt, and places the traffic hold) -> refuse the parent SID -> provider GET (must be a subaccount owned by the parent; closed is refused) -> provider
 * status write (never "closed") -> provider GET -> record (service role). An unclear outcome is recorded as `unknown` and the attempt stays OPEN: it is
 * never retried and never reversed automatically; an administrator runs the read-only verification.
 */

type Env = Record<string, string | undefined>;
type Rpc = { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };

export type SuspensionAction = "suspend" | "reactivate";
export type ProviderStatus = "active" | "suspended" | "closed";
export type ProviderAccount = { sid: string; ownerAccountSid: string | null; status: string };

/** The provider surface this module needs. The fake (suspensionFake.ts) and the guarded real client in real.ts implement it. */
export interface SubaccountStatusProvider {
  readonly isFake: boolean;
  getAccount(accountSid: string): Promise<ProviderAccount>;
  setStatus(accountSid: string, status: "suspended" | "active"): Promise<void>;
}

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;

/**
 * Environment gate (gate 2 of 2; the database switch is gate 1). Production deployment AND production build AND TW4_SUBACCOUNT_SUSPENSION_CALLS=on.
 * Nothing in the repository sets the flag.
 */
export function suspensionCallsAllowed(env: Env = process.env): RealCallsGate {
  if (isvEnvName(env) !== "production") return { allowed: false, reason: "Subaccount status changes are disabled outside production." };
  if (String(env.NODE_ENV ?? "") !== "production") return { allowed: false, reason: "Subaccount status changes are disabled outside a production build." };
  if (String(env.TW4_SUBACCOUNT_SUSPENSION_CALLS ?? "") !== "on") return { allowed: false, reason: "Subaccount status changes are switched off." };
  return { allowed: true };
}

export type ChangeInput = {
  studioId: string;
  action: SuspensionAction;
  studioName: string;
  sidTail: string;
  authorizationRef: string;
  reason: string;
  idempotencyKey: string;
  /** The administrator's typed count of the legal business's locations: the subaccount serves all of them (checked by the database). */
  locationCount: number;
};

export type ChangeResult =
  | { kind: "refused"; code: string }
  | { kind: "replay"; state: string; outcome: string | null; providerStateAfter: string | null }
  | { kind: "done"; outcome: "succeeded" | "already_in_state" | "failed" | "refused" | "unknown"; code: string | null; stateBefore: string | null; stateAfter: string | null; recorded: boolean; locations: number; holdsPlaced: number };

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function providerState(status: unknown): string {
  return status === "active" || status === "suspended" || status === "closed" ? status : "other";
}

function errorCode(e: unknown): string {
  if (e instanceof IsvApiError) return `${e.kind}${e.httpStatus ? `:http${e.httpStatus}` : ""}`.replace(/[^a-z0-9_:.-]/g, "").slice(0, 60) || "provider_error";
  return "unexpected";
}

/** A definite refusal: Twilio answered with a parseable 4xx (or rejected the credentials). Everything else may have been applied. */
function definite(e: unknown): boolean {
  return e instanceof IsvApiError && (e.kind === "validation" || e.kind === "account");
}

/** Account SIDs compare case-insensitively everywhere (hex digits): a differently cased parent SID is still the parent. */
export const sameSid = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === "string" && typeof b === "string" && a !== "" && a.toLowerCase() === b.toLowerCase();

/** Is this reply about the requested account, and is it a SUBACCOUNT of the deployment's parent (never the parent itself)? */
export function ownedSubaccount(account: ProviderAccount, requestedSid: string, parentSid: string): boolean {
  return ACCOUNT_SID.test(account.sid) && sameSid(account.sid, requestedSid) && !sameSid(account.sid, parentSid) && sameSid(account.ownerAccountSid, parentSid);
}

async function record(admin: Rpc, attemptId: string, accountSid: string, step: "precheck" | "outcome" | "reconciled", before: string | null, after: string | null, outcome: string | null, code: string | null): Promise<boolean> {
  try {
    const res = await admin.rpc("tw4susp_record", { p_attempt_id: attemptId, p_account_sid: accountSid, p_step: step, p_state_before: before, p_state_after: after, p_outcome: outcome, p_code: code, p_detail: null });
    if (res.error) console.warn("tw4susp_record_failed", step, res.error.code ?? "unknown");
    return !res.error;
  } catch {
    console.warn("tw4susp_record_failed", step, "exception");
    return false;
  }
}

/**
 * One suspend or reactivate request. `user` is the administrator's own (cookie) client: begin runs with their token. `admin` is the service-role
 * client used ONLY to record what the provider showed. `parentSid` is the deployment's parent account (TWILIO_ACCOUNT_SID).
 */
export async function runSubaccountStatusChange(deps: { user: Rpc; admin: Rpc; provider: SubaccountStatusProvider; parentSid: string }, input: ChangeInput): Promise<ChangeResult> {
  const { user, admin, provider, parentSid } = deps;
  const begun = await user.rpc("tw4susp_begin", {
    p_studio_id: input.studioId, p_action: input.action, p_studio_name: input.studioName, p_sid_tail: input.sidTail, p_location_count: input.locationCount,
    p_authorization_ref: input.authorizationRef, p_reason: input.reason, p_idempotency_key: input.idempotencyKey,
  });
  if (begun.error) return { kind: "refused", code: begun.error.code === "42501" ? "not_allowed" : begun.error.code === "22023" ? "invalid" : "unavailable" };
  const b = obj(begun.data);
  if (b.decision === "refused") return { kind: "refused", code: str(b.code) || "refused" };
  if (b.decision === "replay") return { kind: "replay", state: str(b.state), outcome: str(b.outcome) || null, providerStateAfter: str(b.provider_state_after) || null };
  const attemptId = str(b.attempt_id);
  const sid = str(b.account_sid);
  if (b.decision !== "proceed" || !attemptId || !ACCOUNT_SID.test(sid) || b.action !== input.action) return { kind: "refused", code: "unavailable" };
  const target: ProviderStatus = input.action === "suspend" ? "suspended" : "active";
  const locations = typeof b.locations === "number" ? b.locations : 0;
  const holdsPlaced = typeof b.holds_placed === "number" ? b.holds_placed : 0;

  const finish = async (outcome: "succeeded" | "already_in_state" | "failed" | "refused" | "unknown", code: string | null, before: string | null, after: string | null): Promise<ChangeResult> => {
    const recorded = await record(admin, attemptId, sid, "outcome", before, after, outcome, code);
    return { kind: "done", outcome, code, stateBefore: before, stateAfter: after, recorded, locations, holdsPlaced };
  };

  // NEVER the parent account (every subaccount would follow it)
  if (!ACCOUNT_SID.test(parentSid)) return finish("refused", "parent_unknown", "not_called", null);
  if (sameSid(sid, parentSid)) return finish("refused", "parent_account", "not_called", null);

  // pre-check: the recorded SID must be a subaccount owned by this parent. Nothing has changed yet, so an unreadable reply is a definite failure.
  let before: ProviderAccount;
  try {
    before = await provider.getAccount(sid);
  } catch (e) {
    return finish("failed", `precheck:${errorCode(e)}`.slice(0, 60), "unreadable", null);
  }
  if (!ownedSubaccount(before, sid, parentSid)) return finish("refused", "not_owned_by_parent", providerState(before.status), null);
  const stateBefore = providerState(before.status);
  if (stateBefore === "closed") return finish("refused", "closed", "closed", "closed"); // permanent: never offered, never changed
  if (stateBefore === target) return finish("already_in_state", null, stateBefore, stateBefore);
  if (stateBefore === "other") return finish("refused", "unexpected_provider_state", "other", null);
  // the pre-check is the evidence that a write MAY follow (the opt-out reconciliation rule depends on it): no record, no write
  if (!(await record(admin, attemptId, sid, "precheck", stateBefore, null, null, null))) return finish("failed", "precheck_unrecorded", stateBefore, null);

  let writeError: unknown = null;
  try {
    await provider.setStatus(sid, target);
  } catch (e) {
    writeError = e;
  }

  // read back what the provider now shows: that, not the write's reply, decides
  let after: string;
  try {
    const acct = await provider.getAccount(sid);
    after = sameSid(acct.sid, sid) ? providerState(acct.status) : "unreadable";
  } catch {
    after = "unreadable";
  }
  if (after === target) return finish("succeeded", writeError ? `write:${errorCode(writeError)}`.slice(0, 60) : null, stateBefore, after);
  if (writeError && definite(writeError) && after === stateBefore) return finish("failed", `write:${errorCode(writeError)}`.slice(0, 60), stateBefore, after);
  return finish("unknown", writeError ? `write:${errorCode(writeError)}`.slice(0, 60) : "readback_mismatch", stateBefore, after);
}

export type HoldResult = { kind: "released"; replayed: boolean } | { kind: "recorded" } | { kind: "refused"; code: string };

/** Lift a DanceFlow traffic hold with the administrator's OWN token; the database refuses while a suspension or its reconciliation is outstanding. */
export async function releaseTrafficHold(user: Rpc, input: { studioId: string; reason: string }): Promise<HoldResult> {
  const res = await user.rpc("tw4_traffic_hold_release", { p_studio_id: input.studioId, p_reason: input.reason });
  if (res.error) return { kind: "refused", code: res.error.code === "42501" ? "not_allowed" : "unavailable" };
  const d = obj(res.data);
  return d.decision === "released" ? { kind: "released", replayed: d.replayed === true } : { kind: "refused", code: str(d.code) || "refused" };
}

/** Record (append-only) that opt-outs were reconciled after one suspend attempt, with an evidence reference. The administrator's OWN token. */
export async function attestReconciliation(user: Rpc, input: { studioId: string; attemptId: string; evidenceRef: string; note: string }): Promise<HoldResult> {
  const res = await user.rpc("tw4susp_reconciliation_attest", { p_studio_id: input.studioId, p_attempt_id: input.attemptId, p_evidence_ref: input.evidenceRef, p_note: input.note });
  if (res.error) return { kind: "refused", code: res.error.code === "42501" ? "not_allowed" : "unavailable" };
  const d = obj(res.data);
  return d.decision === "recorded" ? { kind: "recorded" } : { kind: "refused", code: str(d.code) || "refused" };
}

export type VerifyResult = { kind: "refused"; code: string } | { kind: "verified"; observed: string; recorded: boolean };

/** Read-only verification of an OPEN attempt (unknown, or stuck in progress): GET only, the observed state is recorded. It never writes to the provider. */
export async function runSubaccountVerification(deps: { user: Rpc; admin: Rpc; provider: SubaccountStatusProvider; parentSid: string }, input: { studioId: string; reason: string }): Promise<VerifyResult> {
  const { user, admin, provider, parentSid } = deps;
  const begun = await user.rpc("tw4susp_verify_begin", { p_studio_id: input.studioId, p_reason: input.reason });
  if (begun.error) return { kind: "refused", code: begun.error.code === "42501" ? "not_allowed" : "unavailable" };
  const b = obj(begun.data);
  if (b.decision !== "proceed") return { kind: "refused", code: str(b.code) || "refused" };
  const attemptId = str(b.attempt_id);
  const sid = str(b.account_sid);
  if (!attemptId || !ACCOUNT_SID.test(sid) || !ACCOUNT_SID.test(parentSid) || sameSid(sid, parentSid)) return { kind: "refused", code: "parent_account" };
  let acct: ProviderAccount;
  try {
    acct = await provider.getAccount(sid);
  } catch {
    return { kind: "refused", code: "provider_unreadable" }; // the attempt stays open; nothing recorded as a fact
  }
  if (!ownedSubaccount(acct, sid, parentSid)) return { kind: "refused", code: "not_owned_by_parent" };
  const observed = providerState(acct.status);
  if (observed === "other") return { kind: "refused", code: "unexpected_provider_state" };
  const recorded = await record(admin, attemptId, sid, "reconciled", null, observed, "reconciled", null);
  return { kind: "verified", observed, recorded };
}

/** The sentence the console shows for a result. Never claims a spending ceiling. */
export function suspensionMessage(result: ChangeResult | VerifyResult | HoldResult): { ok: boolean; message: string } {
  const R: Record<string, string> = {
    switched_off: "Subaccount suspension is switched off. Nothing changed.",
    disabled: "Subaccount suspension is switched off in this deployment. Nothing changed.",
    not_allowed: "Not allowed: this needs a registered platform administrator with a fresh authenticator code. Nothing changed.",
    invalid: "The request was incomplete. Nothing changed.",
    missing_reason_or_authorization: "Give the written authorization reference (6 to 120 characters) and a reason (10 to 300 characters). Nothing changed.",
    unknown_location: "Choose a location from the list. Nothing changed.",
    no_legal_business: "This location is not linked to a verified legal business. Nothing changed.",
    no_subaccount: "No Twilio subaccount is recorded for this location's business. Nothing changed.",
    closed: "The subaccount is CLOSED. Closing is permanent; nothing can be changed. Escalate to the owner.",
    subaccount_not_ready: "The business's subaccount is not active or suspended in DanceFlow's records. Nothing changed.",
    wrong_studio_name: "The location name you typed does not match. Nothing changed.",
    wrong_sid_tail: "The last 6 characters of the subaccount SID do not match the subaccount recorded for this location. Nothing changed.",
    wrong_location_count: "The number of locations you typed does not match this business. The subaccount serves every location of the business. Nothing changed.",
    sid_collision: "Refused: the recorded subaccount SID matches another business's record when case is ignored. Escalate; nothing changed.",
    precheck_unrecorded: "The pre-check could not be recorded, so nothing was written to Twilio. Try again.",
    subaccount_suspended: "The subaccount is still suspended. Reactivate it first.",
    reconciliation_required: "Opt-outs for the suspension window must be reconciled and attested first (runbook 5.2). The hold stays on.",
    unknown_attempt: "That attempt does not belong to this location's business.",
    not_needed: "That attempt never reached Twilio; no reconciliation is needed.",
    subaccount_not_active: "Reconcile only after the subaccount is active again.",
    attempt_open: "Another suspension or reactivation for this business is in progress or has an unknown outcome. Run the verification first. Nothing changed.",
    not_suspended: "Reactivation is offered only after a confirmed suspension. Nothing changed.",
    parent_account: "Refused: that is the parent account. DanceFlow never suspends the parent.",
    parent_unknown: "Refused: the deployment's parent account is not configured, so the target cannot be proven to be a subaccount.",
    not_owned_by_parent: "Refused: Twilio does not report this account as a subaccount of DanceFlow's parent account.",
    unexpected_provider_state: "Refused: Twilio reported an unexpected account status. Nothing changed.",
    key_conflict: "This form's request key was already used for a different request. Reload the page and try again. Nothing changed.",
    nothing_to_verify:"There is no open attempt to verify.",
    attempt_in_progress: "That attempt started less than 10 minutes ago; wait, then verify.",
    provider_unreadable: "Twilio could not be read. The attempt stays open; try the verification again later.",
  };
  if (result.kind === "refused") return { ok: false, message: R[result.code] ?? "Refused. Nothing changed." };
  if (result.kind === "released") return { ok: true, message: result.replayed ? "The location was not on a hold." : "DanceFlow traffic hold lifted for this location. Billed texts follow the usual checks again." };
  if (result.kind === "recorded") return { ok: true, message: "Opt-out reconciliation recorded with your name and evidence reference. The hold can now be lifted." };
  if (result.kind === "verified") return { ok: true, message: `Verified: Twilio shows the subaccount as ${result.observed}. The observed state was ${result.recorded ? "recorded" : "NOT recorded (check the audit)"}. The traffic hold is unchanged.` };
  if (result.kind === "replay") return { ok: result.outcome === "succeeded" || result.outcome === "already_in_state", message: `This request was already handled (${result.state}${result.outcome ? `, ${result.outcome}` : ""}). Nothing was sent to Twilio again.` };
  const note = result.recorded ? "" : " The outcome could NOT be recorded: the attempt stays open; check the audit and run the verification.";
  switch (result.outcome) {
    case "succeeded":
    case "already_in_state":
      return { ok: true, message: `Twilio now shows the subaccount as ${result.stateAfter}. It serves ${result.locations} location(s); ${result.holdsPlaced} new traffic hold(s) were placed. This is not a spending ceiling: number fees continue while suspended. The DanceFlow traffic hold stays on until an administrator lifts it after the opt-out reconciliation.${note}` };
    case "failed":
      // a pre-check failure means Twilio was never asked to change anything: say exactly that
      if ((result.code ?? "").startsWith("precheck")) {
        return { ok: false, message: `Twilio was NOT called to change anything: the account could not be ${result.code === "precheck_unrecorded" ? "checked and recorded" : "read"} before the change. Nothing changed. The DanceFlow traffic hold stays on.${note}` };
      }
      return { ok: false, message: `Twilio refused the change and still shows ${result.stateAfter ?? "the previous state"}. Nothing changed. The DanceFlow traffic hold stays on.${note}` };
    case "refused":
      return { ok: false, message: (R[result.code ?? ""] ?? "Refused before any change.") + note };
    default:
      return { ok: false, message: `The outcome is UNKNOWN (Twilio shows ${result.stateAfter ?? "nothing readable"}). It will not be retried. Run the verification before anything else.${note}` };
  }
}
