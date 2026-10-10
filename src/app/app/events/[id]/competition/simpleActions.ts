"use server";

import { revalidatePath } from "next/cache";
import { zonedDateTimeToUtcDate } from "@/lib/booking/selfServiceAvailability";
import { getEventTimeZone } from "@/lib/events/eventTiming";
import { competitionWorkspaceHref } from "@/lib/competition/workspaceLink";
import type { createClient as createServerClient } from "@/lib/supabase/server";
import { requireCompetitionManager } from "@/lib/competition/workspaceServer";
import type { SetupProfileDefaults } from "@/lib/competition/setup/types";
import { STUDIO_CUSTOM_PROFILE } from "@/lib/competition/setup/studioCustomV2";
import { SETUP_STEPS, deriveDraft, parsePrice, restoreAnswers } from "@/lib/competition/setup/draft";

export type ActionState = { ok: boolean; error?: string; href?: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";
const REQUEST_KEY_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PRICING_COMPLETION_MODELS = ["per_dance", "per_entry", "free"];

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

/**
 * 10C.5: creates the whole competition draft in one database transaction (create_competition_draft).
 * The client sends only its answers; they are re-derived here against the stored profile with the same
 * deriveDraft() the Review step used, so the payload is never taken from the browser. The registration
 * window belongs to the event and is written by the same transaction (dates are whole days in the event
 * time zone). Registration stays closed and nothing is published.
 */
export async function createCompetitionDraftAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  if (!eventId) return { ok: false, error: "Event is required." };
  const { supabase, event } = await requireCompetitionManager(eventId);

  const requestKey = text(formData, "requestKey");
  if (!REQUEST_KEY_PATTERN.test(requestKey)) return { ok: false, error: "The setup could not be read. Please start again." };

  const { data: profile } = await supabase
    .from("competition_rules_profiles")
    .select("defaults, status")
    .eq("profile_key", STUDIO_CUSTOM_PROFILE.key)
    .eq("version", STUDIO_CUSTOM_PROFILE.version)
    .maybeSingle();
  if (!profile || profile.status !== "active") return { ok: false, error: "Studio / Custom Rules are not available right now." };
  const defaults = profile.defaults as SetupProfileDefaults;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text(formData, "answers"));
  } catch {
    return { ok: false, error: "The setup could not be read. Please start again." };
  }
  const answers = restoreAnswers(parsed, defaults);
  if (!answers) return { ok: false, error: "The setup could not be read. Please start again." };

  const draft = deriveDraft(answers, defaults, {
    eventName: event.name,
    profileKey: STUDIO_CUSTOM_PROFILE.key,
    profileVersion: STUDIO_CUSTOM_PROFILE.version,
    requestKey,
  });
  if (!draft.payload) {
    const step = SETUP_STEPS.find((item) => draft.errors[item.key]?.length);
    return { ok: false, error: step ? `${step.label}: ${draft.errors[step.key]?.[0]}` : "Finish every step before creating the draft." };
  }

  const zone = getEventTimeZone(event);
  const { opens, closes } = answers.registration;
  const spec = {
    ...draft.payload,
    registration: {
      ...draft.payload.registration,
      opens_at: opens ? zonedDateTimeToUtcDate(opens, "00:00", zone).toISOString() : null,
      closes_at: closes ? zonedDateTimeToUtcDate(closes, "23:59", zone).toISOString() : null,
    },
  };

  const { error } = await supabase.rpc("create_competition_draft", { p_event_id: eventId, p_spec: spec });
  if (error) return { ok: false, error: friendly(error) };

  refreshWorkspace(eventId);
  return { ok: true, href: `${competitionWorkspaceHref(eventId)}?created=1` };
}

/** 10C.5: completes "Configure later" pricing for one category (set_competition_category_pricing). */
export async function completeCategoryPricingAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const contestId = text(formData, "contestId");
  const model = text(formData, "model");
  if (!eventId || !contestId) return { ok: false, error: "Category is required." };
  if (!PRICING_COMPLETION_MODELS.includes(model)) return { ok: false, error: "Choose how this category is priced." };
  const { supabase } = await requireCompetitionManager(eventId);

  let amount: number | null = null;
  if (model !== "free") {
    amount = parsePrice(text(formData, "amount"));
    if (amount === null || amount <= 0) return { ok: false, error: "Enter a price, or choose Free." };
  }

  const { error } = await supabase.rpc("set_competition_category_pricing", { p_contest_id: contestId, p_model: model, p_amount: amount });
  if (error) return { ok: false, error: friendly(error) };

  refreshWorkspace(eventId);
  return { ok: true };
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

/**
 * Phase 10C: OPEN / CLOSE registration through the canonical database lifecycle
 * (open_/close_competition_registration). Opening moves the published categories, their draft
 * divisions and registration rules to open; public visibility also needs the event to be published,
 * public/unlisted, registration-required and inside its registration window.
 */
export async function setCompetitionRegistrationAction(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const mode = text(formData, "mode");
  if (!eventId || !programId || !["open", "close"].includes(mode)) return { ok: false, error: "Competition is required." };
  const { supabase } = await requireCompetitionManager(eventId);

  const { error } = await supabase.rpc(mode === "open" ? "open_competition_registration" : "close_competition_registration", { p_program_id: programId });
  if (error) {
    const message = friendly(error).replace(/^COMP10C_[A-Z_]+:\s*/, "");
    return { ok: false, error: message.charAt(0).toUpperCase() + message.slice(1) };
  }

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
