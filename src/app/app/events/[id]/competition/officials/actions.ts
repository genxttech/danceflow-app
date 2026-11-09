"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { officialErrorCode, OFFICIAL_ROLES } from "@/lib/competition/officials/contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function uuid(formData: FormData, key: string) {
  const value = text(formData, key);
  return UUID.test(value) ? value : null;
}

function back(eventId: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  redirect(`/app/events/${eventId}/competition/officials?${query}`);
}

/**
 * Every action re-checks manager access (404 for others) and calls exactly one database RPC. The RPC is the
 * authority: it re-checks the manager role, the account identity and the round state, and is idempotent on the
 * request id minted when the page rendered.
 */
async function run(
  formData: FormData,
  call: (rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>, eventId: string) => PromiseLike<{ error: { message: string } | null }>,
  okMessage: string,
): Promise<never> {
  const eventId = uuid(formData, "eventId");
  if (!eventId) throw new Error("Event not found.");
  const { supabase } = await requireCompetitionWorkspace(eventId);
  const result = await call((name, args) => supabase.rpc(name, args), eventId);
  revalidatePath(`/app/events/${eventId}/competition/officials`);
  if (result.error) back(eventId, { error: officialErrorCode(result.error.message) });
  back(eventId, { saved: okMessage });
}

export async function addOfficialAction(formData: FormData): Promise<void> {
  const userId = uuid(formData, "userId");
  const requestId = uuid(formData, "requestId");
  const role = text(formData, "role");
  await run(
    formData,
    (rpc, eventId) =>
      userId && requestId && (OFFICIAL_ROLES as readonly string[]).includes(role)
        ? rpc("add_competition_official", { p_event_id: eventId, p_user_id: userId, p_role: role, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "added",
  );
}

export async function deactivateOfficialAction(formData: FormData): Promise<void> {
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    (rpc) =>
      officialId && requestId
        ? rpc("deactivate_competition_official", { p_official_id: officialId, p_reason: text(formData, "reason"), p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "deactivated",
  );
}

export async function setChairAction(formData: FormData): Promise<void> {
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    (rpc, eventId) =>
      officialId && requestId
        ? rpc("set_competition_chair", { p_event_id: eventId, p_official_id: officialId, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "chair_set",
  );
}

export async function clearChairAction(formData: FormData): Promise<void> {
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    (rpc, eventId) =>
      requestId
        ? rpc("clear_competition_chair", { p_event_id: eventId, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "chair_cleared",
  );
}

export async function assignPanelMemberAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  const letter = text(formData, "judgeLetter");
  await run(
    formData,
    (rpc) =>
      roundId && officialId && requestId
        ? rpc("assign_competition_panel_member", { p_round_id: roundId, p_official_id: officialId, p_judge_letter: letter || null, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "assigned",
  );
}

export async function unassignPanelMemberAction(formData: FormData): Promise<void> {
  const roundId = uuid(formData, "roundId");
  const officialId = uuid(formData, "officialId");
  const requestId = uuid(formData, "requestId");
  await run(
    formData,
    (rpc) =>
      roundId && officialId && requestId
        ? rpc("unassign_competition_panel_member", { p_round_id: roundId, p_official_id: officialId, p_request_id: requestId })
        : Promise.resolve({ error: { message: "COMP_OFFICIAL_INVALID" } }),
    "unassigned",
  );
}
