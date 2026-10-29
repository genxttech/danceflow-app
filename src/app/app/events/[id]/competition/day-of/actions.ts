"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import { dayOfHref, friendlyDayOfError } from "@/lib/competition/dayOf";
import { friendlyNoShowError } from "@/lib/competition/noShow";

/* O1: day-of operations. Every change is one database writer call; nothing here is trusted. */

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function back(eventId: string, params: Record<string, string | undefined>): never {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  revalidatePath(dayOfHref(eventId));
  redirect(`${dayOfHref(eventId)}${search.size ? `?${search}` : ""}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function prepare(formData: FormData) {
  const eventId = text(formData, "eventId");
  const requestId = text(formData, "requestId");
  const targetId = text(formData, "targetId");
  if (!UUID.test(requestId) || !UUID.test(targetId)) back(eventId, { error: "That request was not valid. Refresh and try again." });
  const { supabase } = await requireCompetitionManager(eventId);
  return { eventId, requestId, targetId, supabase };
}

export async function roundTransitionAction(formData: FormData): Promise<void> {
  const { eventId, requestId, targetId, supabase } = await prepare(formData);
  const kind = text(formData, "kind");
  if (kind === "schedule" || kind === "start") {
    const { error } = await supabase.rpc(kind === "schedule" ? "schedule_competition_round" : "start_competition_round", {
      p_round_id: targetId, p_request_id: requestId,
    });
    if (error) back(eventId, { error: friendlyDayOfError(error) });
    back(eventId, { notice: kind === "schedule" ? "Round scheduled." : "Round started." });
  }
  if (kind === "cancel") {
    const { error } = await supabase.rpc("cancel_competition_round", {
      p_round_id: targetId, p_reason: text(formData, "reason"), p_request_id: requestId,
    });
    if (error) back(eventId, { error: friendlyDayOfError(error) });
    back(eventId, { notice: "Round cancelled." });
  }
  back(eventId, { error: "Unknown round action." });
}

export async function heatTransitionAction(formData: FormData): Promise<void> {
  const { eventId, requestId, targetId, supabase } = await prepare(formData);
  const to = text(formData, "to");
  if (!["staging", "active", "complete"].includes(to)) back(eventId, { error: "Unknown heat action." });
  const { error } = await supabase.rpc("advance_competition_floor_heat", {
    p_floor_heat_id: targetId, p_to_status: to, p_request_id: requestId,
  });
  if (error) back(eventId, { error: friendlyDayOfError(error) });
  back(eventId, { notice: to === "staging" ? "Heat called to the floor." : to === "active" ? "Heat started." : "Heat completed." });
}

/** NS1: mark or void a heat no-show. The reason is mandatory; the database checks authority, window and idempotency. */
export async function noShowAction(formData: FormData): Promise<void> {
  const { eventId, requestId, targetId, supabase } = await prepare(formData);
  const kind = text(formData, "kind");
  const reason = text(formData, "reason");
  if (kind !== "mark" && kind !== "void") back(eventId, { error: "Unknown no-show action." });
  if (reason.length < 1 || reason.length > 500) back(eventId, { error: "Give a reason (up to 500 characters)." });
  const { error } = await supabase.rpc(kind === "mark" ? "mark_competition_heat_no_show" : "void_competition_heat_no_show", {
    p_heat_entry_id: targetId, p_reason: reason, p_request_id: requestId,
  });
  if (error) back(eventId, { error: friendlyNoShowError(error) });
  back(eventId, { notice: kind === "mark" ? "No-show recorded. Judges will rank the remaining entries." : "No-show undone. Judges must correct their ballots." });
}
