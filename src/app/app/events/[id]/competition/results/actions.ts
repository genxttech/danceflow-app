"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeReturnPath } from "@/lib/competition/ballots/messages";
import { calculateRound } from "@/lib/competition/results/calculate";
import { lookupRegisteredEngine } from "@/lib/competition/results/engines";
import { resultErrorMessage } from "@/lib/competition/results/messages";

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

type Session = { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>; returnTo: string };

/** Every action is one database transition. The RPC is the authority (who, round state, hash binding); a refusal is shown as plain text. */
async function session(formData: FormData): Promise<Session> {
  const returnTo = safeReturnPath(text(formData, "returnTo"), "/app/events");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { rpc: (name, args) => supabase.rpc(name, args), returnTo };
}

/** Loads the locked ballots, runs the round's pinned engine through the narrow interface and records a new result version. */
export async function calculateRoundResultAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  const { rpc, returnTo } = await session(formData);
  if (!roundId || !requestId) back(returnTo, { error: resultErrorMessage("COMP_REQUEST_ID_REQUIRED") });
  const outcome = await calculateRound({ rpc, engineFor: lookupRegisteredEngine }, roundId, requestId);
  revalidatePath(returnTo);
  if (!outcome.ok) back(returnTo, { error: resultErrorMessage(outcome.code) });
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
  if (error) back(returnTo, { error: resultErrorMessage(error.message) });
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
  if (error) back(returnTo, { error: resultErrorMessage(error.message) });
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
  if (error) back(returnTo, { error: resultErrorMessage(error.message) });
  back(returnTo, { saved: "Round completed." });
}
