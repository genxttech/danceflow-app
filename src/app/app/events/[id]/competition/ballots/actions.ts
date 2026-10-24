"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ballotErrorMessage, safeReturnPath } from "@/lib/competition/ballots/messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function uuid(formData: FormData, key: string) {
  const value = text(formData, key);
  return UUID.test(value) ? value : null;
}

/** Marks come from `mark:<entryId>` fields. Ordinal ballots send numbers, rating ballots send the band label. */
function readMarks(formData: FormData): Array<{ entry_id: string; value: string | number }> {
  const numeric = text(formData, "scoringMethod") !== "proficiency_rating";
  const marks: Array<{ entry_id: string; value: string | number }> = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("mark:")) continue;
    const entryId = key.slice(5);
    const value = String(raw).trim();
    if (!UUID.test(entryId) || value === "") continue;
    marks.push({ entry_id: entryId, value: numeric && /^-?\d+$/.test(value) ? Number(value) : value });
  }
  return marks;
}

/** Callback ballots: every ticked `pick` is a yes mark; the ballot is round-level (no heat). */
function readPicks(formData: FormData): Array<{ entry_id: string; value: true }> {
  return formData
    .getAll("pick")
    .map((raw) => String(raw).trim())
    .filter((id) => UUID.test(id))
    .map((id) => ({ entry_id: id, value: true as const }));
}

function back(returnTo: string, params: Record<string, string>): never {
  redirect(`${returnTo}?${new URLSearchParams(params).toString()}`);
}

/**
 * Every action calls exactly one database RPC. The RPC is the authority (who you are, your panel assignment, the
 * round state, the mark rules) and is idempotent on the request id minted when the page rendered; a refusal is shown
 * as plain text and nothing is retried.
 */
async function run(
  formData: FormData,
  fallbackReturn: string,
  call: (rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>) => PromiseLike<{ error: { message: string } | null }>,
  okMessage: string,
): Promise<never> {
  const returnTo = safeReturnPath(text(formData, "returnTo"), fallbackReturn);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const result = await call((name, args) => supabase.rpc(name, args));
  revalidatePath(returnTo);
  if (result.error) back(returnTo, { error: ballotErrorMessage(result.error.message) });
  back(returnTo, { saved: okMessage });
}

const INVALID = Promise.resolve({ error: { message: "COMP_BALLOT_INCOMPLETE" } });

/** A judge submits or corrects their own ballot for one heat. */
export async function submitJudgeBallotAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const callback = text(formData, "callback") === "1";
  const heatId = callback ? null : uuid(formData, "heatId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId && (callback || heatId) && requestId
        ? rpc("submit_competition_ballot", {
            p_round_id: roundId,
            p_heat_id: heatId,
            p_marks: callback ? readPicks(formData) : readMarks(formData),
            p_request_id: requestId,
            p_correction_reason: text(formData, "reason") || null,
          })
        : INVALID,
    "Ballot saved.",
  );
}

/** A scorer (or manager) enters a paper ballot on behalf of a named judge. */
export async function enterPaperBallotAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const callback = text(formData, "callback") === "1";
  const heatId = callback ? null : uuid(formData, "heatId");
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId && (callback || heatId) && officialId && requestId
        ? rpc("enter_competition_paper_ballot", {
            p_round_id: roundId,
            p_heat_id: heatId,
            p_official_id: officialId,
            p_marks: callback ? readPicks(formData) : readMarks(formData),
            p_request_id: requestId,
            p_correction_reason: text(formData, "reason") || null,
          })
        : INVALID,
    "Paper ballot saved.",
  );
}

/** A callback judge saves selections across heats without submitting (mutable draft, never a ballot). */
export async function saveCallbackDraftAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId
        ? rpc("save_competition_callback_draft", { p_round_id: roundId, p_entry_ids: readPicks(formData).map((pick) => pick.entry_id) })
        : INVALID,
    "Selections saved. They are not submitted yet.",
  );
}

export async function recordAttendanceAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  const status = text(formData, "status");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId && officialId && requestId && (status === "absent" || status === "present")
        ? rpc("record_competition_judge_attendance", {
            p_round_id: roundId,
            p_official_id: officialId,
            p_status: status,
            p_reason: text(formData, "reason") || null,
            p_request_id: requestId,
          })
        : Promise.resolve({ error: { message: "COMP_ATTENDANCE_INVALID" } }),
    status === "absent" ? "Absence recorded." : "Marked present.",
  );
}

export async function lockBallotsAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId && requestId
        ? rpc("lock_competition_round_ballots", { p_round_id: roundId, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_BALLOTS_BAD_STATE" } }),
    "Ballots locked.",
  );
}

export async function reopenBallotsAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    "/app/judging",
    (rpc) =>
      roundId && requestId
        ? rpc("reopen_competition_round_ballots", { p_round_id: roundId, p_reason: text(formData, "reason"), p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_BALLOTS_BAD_STATE" } }),
    "Ballots reopened.",
  );
}
