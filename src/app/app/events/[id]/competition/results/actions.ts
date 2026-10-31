"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeReturnPath } from "@/lib/competition/ballots/messages";
import { calculateRound } from "@/lib/competition/results/calculate";
import { lookupRegisteredEngine } from "@/lib/competition/results/engineAdapter";
import { resultErrorMessage } from "@/lib/competition/results/messages";
import {
  errorText,
  parseExclusionReasonKind,
  validateExclusionReason,
  withRetryOnce,
  withdrawalReasonLooksSubstantive,
  type RpcCall,
} from "@/lib/competition/results/advancement";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function uuid(formData: FormData, key: string) {
  const value = text(formData, key);
  return UUID.test(value) ? value : null;
}

function back(returnTo: string, params: Record<string, string>): never {
  redirect(`${returnTo}?${new URLSearchParams(params).toString()}`);
}

type Session = { rpc: RpcCall; returnTo: string };

/**
 * Every action is one database transition. The RPC is the authority (who, round state, hash binding); a refusal is shown as plain text.
 * CF1: every RPC called here carries a request id, so a deadlock (40P01) or a refused lock wait (55P03) is repeated once with the same
 * id (the database replays instead of applying twice); a second failure shows the "try again" copy.
 */
async function session(formData: FormData): Promise<Session> {
  const returnTo = safeReturnPath(text(formData, "returnTo"), "/app/events");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { rpc: withRetryOnce((name, args) => supabase.rpc(name, args)), returnTo };
}

/** Loads the locked ballots, runs the round's pinned engine through the narrow interface and records a new result version. */
export async function calculateRoundResultAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const outcome = await calculateRound({ rpc, engineFor: lookupRegisteredEngine }, roundId, requestId);
  revalidatePath(returnTo);
  if (!outcome.ok) back(returnTo, { error: resultErrorMessage(`${outcome.code} ${outcome.message}`) });
  back(returnTo, { saved: `Calculated result version ${outcome.version}. Review it, then approve.` });
}

/** A manager approves a calculated version. The calculator may approve only with an override reason, which is audited. */
export async function approveRoundResultAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const versionId = uuid(formData, "versionId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !versionId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { error } = await rpc("approve_competition_round_result", {
    p_round_id: roundId,
    p_result_version_id: versionId,
    p_override_reason: text(formData, "overrideReason") || null,
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Result approved. The round's heats are certified." });
}

/** Reopens an approved, calculated or published round for a ballot correction. Reason required; refused once a later round has ballots. */
export async function openRoundCorrectionAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { error } = await rpc("open_competition_round_correction", {
    p_round_id: roundId,
    p_reason: text(formData, "reason"),
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Correction opened. Judges can submit corrected ballots; recalculate when they are done." });
}

/** published -> complete. Refused until publication exists (F3). */
export async function completeRoundAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { error } = await rpc("complete_competition_round", { p_round_id: roundId, p_request_id: requestId });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Round completed." });
}

/**
 * CF1 A0: advance the approved callback result into the Final (creates the Final's heat). Manager only (the RPC checks role and verified
 * email). There is no override: a blocked tie or an unavailable couple is refused by the database and shown as copy.
 */
export async function applyAdvancementAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const versionId = uuid(formData, "versionId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !versionId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { data, error } = await rpc("apply_competition_round_advancement", {
    p_round_id: roundId,
    p_result_version_id: versionId,
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  const result = (data ?? {}) as { entry_count?: number; carried?: number; replayed?: boolean };
  const advanced = typeof result.entry_count === "number" ? ` ${result.entry_count} couple${result.entry_count === 1 ? "" : "s"}` : "";
  back(returnTo, { saved: `${result.replayed ? "Advancement was already applied." : "Advanced"}${result.replayed ? "" : `${advanced} to the Final.`}` });
}

// ----- A5: "Excluded, with reason" (a danced couple that later became ineligible or was refunded) -----

/** A manager requests an exclusion. Nothing takes effect until a second person co-signs. */
export async function requestExclusionAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const entryId = uuid(formData, "entryId");
  const requestId = uuid(formData, "requestId");
  const kind = parseExclusionReasonKind(text(formData, "reasonKind"));
  const reason = validateExclusionReason(text(formData, "reason"));
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !entryId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  if (!kind) back(returnTo, { error: resultErrorMessage("COMP_EXCLUSION_REASON_KIND") });
  if (!reason.ok) back(returnTo, { error: reason.message });
  const { error } = await rpc("request_round_exclusion", {
    p_round_id: roundId,
    p_entry_id: entryId,
    p_reason_kind: kind,
    p_reason: reason.value,
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Exclusion requested. It takes effect when a different person co-signs it." });
}

/** A chair or a different manager co-signs a pending exclusion request (`decisionId` is the request row). */
export async function cosignExclusionAction(formData: FormData): Promise<void> {
  const decisionId = uuid(formData, "decisionId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!decisionId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { error } = await rpc("cosign_round_exclusion", { p_decision_id: decisionId, p_request_id: requestId });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Exclusion co-signed. The couple is out of this round's ranking. Judges' submitted ballots may need correcting." });
}

/** After the cause is corrected, a manager requests that the exclusion be reversed. */
export async function requestExclusionReversalAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const entryId = uuid(formData, "entryId");
  const requestId = uuid(formData, "requestId");
  const reason = validateExclusionReason(text(formData, "reason"));
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !entryId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  if (!reason.ok) back(returnTo, { error: reason.message });
  const { error } = await rpc("request_round_exclusion_reversal", {
    p_round_id: roundId,
    p_entry_id: entryId,
    p_reason: reason.value,
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Reversal requested. It takes effect when a different person co-signs it." });
}

export async function cosignExclusionReversalAction(formData: FormData): Promise<void> {
  const decisionId = uuid(formData, "decisionId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!decisionId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { error } = await rpc("cosign_round_exclusion_reversal", { p_decision_id: decisionId, p_request_id: requestId });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: "Exclusion reversed. The couple is back in this round's ranking." });
}

// ----- A6: withdrawal and reinstatement of an advanced couple (on the Final round) -----

/** A manager requests a withdrawal or a reinstatement. `roundId` is the Final round. A second person co-signs. */
export async function requestFinalWithdrawalAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const entryId = uuid(formData, "entryId");
  const requestId = uuid(formData, "requestId");
  const kind = text(formData, "kind");
  const reason = text(formData, "reason");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !entryId || !requestId || (kind !== "withdraw" && kind !== "reinstate")) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  if (!withdrawalReasonLooksSubstantive(reason)) back(returnTo, { error: resultErrorMessage("COMP_WITHDRAWAL_REASON_WEAK") });
  const { error } = await rpc(kind === "withdraw" ? "withdraw_advanced_entry_from_final" : "reinstate_withdrawn_entry_to_final", {
    p_round_id: roundId,
    p_entry_id: entryId,
    p_reason: reason,
    p_request_id: requestId,
  });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  back(returnTo, { saved: `${kind === "withdraw" ? "Withdrawal" : "Reinstatement"} requested. It takes effect when a different person co-signs it.` });
}

/** The co-signer names the requester's `requestId`. Only this call changes the Final's heat. */
export async function cosignFinalWithdrawalAction(formData: FormData): Promise<void> {
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const { data, error } = await rpc("cosign_final_withdrawal_request", { p_request_id: requestId });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  const kind = (data as { kind?: string } | null)?.kind;
  back(returnTo, { saved: kind === "reinstate" ? "Reinstatement recorded." : "Withdrawal recorded." });
}

/** A6 D-B: the requester (while still a manager) or any manager/chair cancels a pending request. Reason required, no expiry. */
export async function cancelFinalWithdrawalAction(formData: FormData): Promise<void> {
  const requestId = uuid(formData, "requestId");
  const reason = text(formData, "reason");
  const { rpc, returnTo } = await session(formData);
  if (!requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  if (!withdrawalReasonLooksSubstantive(reason)) back(returnTo, { error: resultErrorMessage("COMP_WITHDRAWAL_REASON_WEAK") });
  const { data, error } = await rpc("cancel_final_withdrawal_request", { p_request_id: requestId, p_reason: reason });
  revalidatePath(returnTo);
  if (error) back(returnTo, { error: errorText(error) });
  const replayed = (data as { replayed?: boolean } | null)?.replayed === true;
  back(returnTo, { saved: replayed ? "That request was already cancelled." : "Request cancelled." });
}
