"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { getEventTimeZone } from "@/lib/events/eventTiming";
import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";
import type { createClient as createServerClient } from "@/lib/supabase/server";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import type { ProfileDefaults, SimpleCompetitionSpec } from "@/lib/competition/simple/types";
import { validateSpec } from "@/lib/competition/simple/wizard";

export type ActionState = { ok: boolean; error?: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The database functions raise plain-language messages with the default SQLSTATE (P0001) or 42501.
 * Anything else (constraint names, driver errors) is not shown to organizers.
 */
function friendly(error: { code?: string; message?: string } | null | undefined) {
  if (!error) return GENERIC_ERROR;
  if (error.code === "P0001" || error.code === "42501") return error.message || GENERIC_ERROR;
  return GENERIC_ERROR;
}

function refreshWorkspace(eventId: string) {
  revalidatePath(`/app/events/${eventId}`);
  revalidatePath(competitionWorkspaceHref(eventId), "layout");
}

export async function createSimpleCompetitionAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  if (!eventId) return { ok: false, error: "Event is required." };
  const { supabase, event } = await requireCompetitionManager(eventId);

  let spec: SimpleCompetitionSpec;
  try {
    spec = JSON.parse(text(formData, "spec")) as SimpleCompetitionSpec;
  } catch {
    return { ok: false, error: "The competition details could not be read. Please start again." };
  }

  const { data: profile } = await supabase
    .from("competition_rules_profiles")
    .select("defaults, status")
    .eq("profile_key", spec.profile_key)
    .eq("version", spec.profile_version)
    .maybeSingle();
  if (!profile || profile.status !== "active") return { ok: false, error: "This competition type is no longer available." };

  const errors = validateSpec(spec, profile.defaults as ProfileDefaults);
  if (errors.length > 0) return { ok: false, error: errors[0] };

  const opens = text(formData, "registrationOpens");
  const closes = text(formData, "registrationCloses");
  for (const value of [opens, closes]) {
    if (value && !DATE_PATTERN.test(value)) return { ok: false, error: "Registration dates must be valid dates." };
  }
  if (opens && closes && closes < opens) return { ok: false, error: "Registration cannot close before it opens." };

  const { error } = await supabase.rpc("create_simple_competition", { target_event_id: eventId, spec });
  if (error) return { ok: false, error: friendly(error) };

  // The registration window belongs to the event itself, so it is saved on the event (and honored by
  // the existing public event flow); it is not a competition-only setting.
  let notice = "";
  if (opens || closes) {
    const zone = getEventTimeZone(event);
    const update: Record<string, string | null> = {};
    if (opens) update.registration_opens_at = zonedDateTimeToUtcDate(opens, "00:00", zone).toISOString();
    if (closes) update.registration_closes_at = zonedDateTimeToUtcDate(closes, "23:59", zone).toISOString();
    const { error: dateError } = await supabase.from("events").update(update).eq("id", eventId);
    if (dateError) notice = "&notice=dates";
  }

  refreshWorkspace(eventId);
  redirect(`${competitionWorkspaceHref(eventId)}?created=1${notice}`);
}

export async function publishCompetitionAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  if (!eventId || !programId) return { ok: false, error: "Competition is required." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { error } = await supabase.rpc("publish_competition_program", { target_program_id: programId });
  if (error) return { ok: false, error: friendly(error) };

  refreshWorkspace(eventId);
  return { ok: true };
}

async function editableProgramStatus(supabase: Awaited<ReturnType<typeof createServerClient>>, eventId: string, programId: string) {
  const { data } = await supabase.from("event_competition_programs").select("status").eq("id", programId).eq("event_id", eventId).maybeSingle();
  return data?.status as string | undefined;
}

export async function updateDivisionAction(formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const divisionId = text(formData, "divisionId");
  const name = text(formData, "name");
  if (!eventId || !divisionId) return { ok: false, error: "Division is required." };
  if (name.length < 1 || name.length > 200) return { ok: false, error: "Enter a division name (up to 200 characters)." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { data: division } = await supabase
    .from("event_competition_divisions")
    .select("id, contest_id, program_id")
    .eq("id", divisionId)
    .eq("event_id", eventId)
    .maybeSingle();
  if (!division) return { ok: false, error: "Division was not found." };
  const status = await editableProgramStatus(supabase, eventId, division.program_id);
  if (!status || !["draft", "configured"].includes(status)) return { ok: false, error: "Divisions cannot be edited once the competition is running." };

  const { data: siblings } = await supabase
    .from("event_competition_divisions")
    .select("id, name")
    .eq("contest_id", division.contest_id)
    .eq("event_id", eventId);
  if ((siblings ?? []).some((item: { id: string; name: string }) => item.id !== divisionId && item.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: `This category already has a division named ${name}.` };
  }

  const { error } = await supabase
    .from("event_competition_divisions")
    .update({ name, skill_label: text(formData, "skillLabel") || null, age_label: text(formData, "ageLabel") || null })
    .eq("id", divisionId)
    .eq("event_id", eventId);
  if (error) return { ok: false, error: GENERIC_ERROR };

  refreshWorkspace(eventId);
  return { ok: true };
}

export async function addDivisionAction(formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const contestId = text(formData, "contestId");
  if (!eventId || !contestId) return { ok: false, error: "Category is required." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { error } = await supabase.rpc("add_competition_division", {
    target_contest_id: contestId,
    division_name: text(formData, "name"),
    skill_label: text(formData, "skillLabel") || null,
    age_label: text(formData, "ageLabel") || null,
  });
  if (error) return { ok: false, error: friendly(error) };

  refreshWorkspace(eventId);
  return { ok: true };
}

export async function removeDivisionAction(formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const divisionId = text(formData, "divisionId");
  if (!eventId || !divisionId) return { ok: false, error: "Division is required." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { error } = await supabase.rpc("remove_competition_division", { target_division_id: divisionId });
  if (error) return { ok: false, error: friendly(error) };

  refreshWorkspace(eventId);
  return { ok: true };
}
