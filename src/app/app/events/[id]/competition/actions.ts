"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

const DISCIPLINES = ["showcase", "ballroom", "country", "west_coast_swing", "collegiate_amateur", "custom"];
const MODES = ["relative", "proficiency", "feedback_only", "exhibition"];
const SCORING_METHODS = ["skating", "majority_rules", "wsdc_callback", "relative_placement", "round_specific", "proficiency", "cumulative_points", "feedback_only", "custom", "none"];
const ADVANCEMENT_METHODS = ["promote_callback", "retire_callback", "recall_count", "custom", "none"];
const FEEDBACK_POLICIES = ["none", "optional", "required"];
const ROUND_TYPES = ["qualifying", "preliminary", "quarterfinal", "semifinal", "final", "proficiency", "feedback", "exhibition", "custom"];
const CONTEST_TYPES = ["single_dance", "multi_dance", "scholarship", "showdance", "cabaret", "formation", "line_dance", "team", "spotlight", "jack_and_jill", "strictly", "exhibition", "custom"];
const ENTRY_FORMATS = ["solo", "couple", "pro_am", "pro_pro", "mixed_amateur", "professional", "team", "random_partner", "custom"];
const DANCE_SELECTION_MODES = ["individual", "prescribed_set", "choose_count", "routine", "none"];
const PRICING_METHODS = ["per_dance", "flat_entry", "base_plus_dance", "included_set", "custom"];
const WSDC_REGISTRY_STATUSES = ["not_declared", "trial", "approved", "not_applicable"];

function text(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value: string) {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonnegativeAmount(value: string) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function allowed(value: string, values: string[], fallback: string) {
  return values.includes(value) ? value : fallback;
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function requireEventManager(eventId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();

  if (error || !event) throw new Error("Event not found.");

  const studioCanManage = ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
  let organizerCanManage = false;

  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", context.userId)
      .eq("active", true)
      .maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }

  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) {
    throw new Error("You do not have permission to manage this competition.");
  }

  return { supabase, context, event };
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}`);
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/registrations`);
}

export async function restartCompetitionSetupAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const confirmation = text(formData, "confirmation");
  if (!eventId) throw new Error("Event is required.");
  if (confirmation !== "RESTART COMPETITION") {
    throw new Error('Type "RESTART COMPETITION" exactly to restart setup.');
  }

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("restart_event_competition_setup", {
    target_event_id: eventId,
    confirmation_text: confirmation,
  });

  if (error) throw new Error(`Could not restart competition setup: ${error.message}`);
  refresh(eventId);
}

export async function applyCompetitionTemplateAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const templateKey = text(formData, "templateKey");
  if (!eventId || !templateKey) throw new Error("Event and template are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("apply_competition_configuration_template", {
    target_event_id: eventId,
    selected_template_key: templateKey,
  });

  if (error) throw new Error(`Could not apply competition template: ${error.message}`);
  refresh(eventId);
}

export async function createCompetitionProgramAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const name = text(formData, "name");
  if (!eventId || !name) throw new Error("Event and program name are required.");

  const { supabase, context, event } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_programs").insert({
    event_id: eventId,
    studio_id: event.studio_id,
    organizer_id: event.organizer_id,
    name,
    discipline_family: allowed(text(formData, "disciplineFamily"), DISCIPLINES, "showcase"),
    competition_mode: allowed(text(formData, "competitionMode"), MODES, "feedback_only"),
    scoring_method: allowed(text(formData, "scoringMethod"), SCORING_METHODS, "feedback_only"),
    advancement_method: allowed(text(formData, "advancementMethod"), ADVANCEMENT_METHODS, "none"),
    feedback_policy: allowed(text(formData, "feedbackPolicy"), FEEDBACK_POLICIES, "required"),
    rules_edition: text(formData, "rulesEdition") || null,
    created_by: context.userId,
  });

  if (error) throw new Error(`Could not create program: ${error.message}`);
  refresh(eventId);
}

export async function updateWsdcProgramProfileAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  if (!eventId || !programId) throw new Error("West Coast Swing program is required.");

  const registryStatus = allowed(text(formData, "registryStatus"), WSDC_REGISTRY_STATUSES, "not_declared");
  const surchargeAmount = nonnegativeAmount(text(formData, "competitorSurcharge"));
  const surchargeCurrency = (text(formData, "surchargeCurrency") || "USD").toUpperCase();
  const resultsReportingRequired = text(formData, "resultsReportingRequired") === "on";
  const { supabase } = await requireEventManager(eventId);

  const { data: program } = await (supabase as any)
    .from("event_competition_programs")
    .select("id")
    .eq("id", programId)
    .eq("event_id", eventId)
    .eq("discipline_family", "west_coast_swing")
    .maybeSingle();
  if (!program) throw new Error("West Coast Swing program was not found.");

  const { error: profileError } = await (supabase as any)
    .from("event_competition_wsdc_program_profiles")
    .update({
      registry_status: registryStatus,
      registry_event_name: text(formData, "registryEventName") || null,
      competitor_surcharge: surchargeAmount,
      surcharge_currency: surchargeCurrency,
      results_reporting_required: resultsReportingRequired,
    })
    .eq("event_id", eventId)
    .eq("program_id", programId);
  if (profileError) throw new Error(`Could not update WSDC settings: ${profileError.message}`);

  const { data: registryContests, error: contestError } = await (supabase as any)
    .from("event_competition_contests")
    .select("id")
    .eq("event_id", eventId)
    .eq("program_id", programId)
    .contains("configuration", { registry_points_contest: true });
  if (contestError) throw new Error(`Could not load WSDC contests: ${contestError.message}`);

  for (const contest of registryContests ?? []) {
    const { data: existingFee, error: feeLookupError } = await (supabase as any)
      .from("event_competition_fee_rules")
      .select("id")
      .eq("event_id", eventId)
      .eq("contest_id", contest.id)
      .contains("configuration", { source: "wsdc_competitor_surcharge" })
      .maybeSingle();
    if (feeLookupError) throw new Error(`Could not load WSDC surcharge: ${feeLookupError.message}`);

    const feeValues = {
      name: "WSDC competitor surcharge",
      calculation_type: "flat_per_entry",
      registration_mode: "both",
      amount: surchargeAmount,
      currency: surchargeCurrency,
      active: surchargeAmount > 0,
      configuration: { source: "wsdc_competitor_surcharge", rules_edition: "2026.1C" },
    };
    const feeResult = existingFee
      ? await (supabase as any).from("event_competition_fee_rules").update(feeValues).eq("id", existingFee.id).eq("event_id", eventId)
      : await (supabase as any).from("event_competition_fee_rules").insert({ ...feeValues, event_id: eventId, program_id: programId, contest_id: contest.id });
    if (feeResult.error) throw new Error(`Could not save WSDC surcharge: ${feeResult.error.message}`);
  }

  refresh(eventId);
}

export async function createCompetitionDanceAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const name = text(formData, "name");
  if (!eventId || !programId || !name) throw new Error("Program and dance/style name are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_dances").insert({
    event_id: eventId,
    program_id: programId,
    dance_key: slugify(text(formData, "danceKey") || name),
    name,
    category_label: text(formData, "categoryLabel") || null,
  });

  if (error) throw new Error(`Could not add dance/style: ${error.message}`);
  refresh(eventId);
}

export async function createCompetitionDivisionAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const contestId = text(formData, "contestId");
  const name = text(formData, "name");
  if (!eventId || !programId || !contestId || !name) throw new Error("Competition event and division name are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_divisions").insert({
    event_id: eventId,
    program_id: programId,
    contest_id: contestId,
    name,
    code: text(formData, "code") || null,
    age_label: text(formData, "ageLabel") || null,
    skill_label: text(formData, "skillLabel") || null,
    role_label: text(formData, "roleLabel") || null,
  });

  if (error) throw new Error(`Could not create division: ${error.message}`);
  refresh(eventId);
}

export async function createCompetitionContestAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const name = text(formData, "name");
  if (!eventId || !programId || !name) throw new Error("Program and competition event name are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_contests").insert({
    event_id: eventId,
    program_id: programId,
    name,
    code: text(formData, "code") || null,
    contest_type: allowed(text(formData, "contestType"), CONTEST_TYPES, "custom"),
    entry_format: allowed(text(formData, "entryFormat"), ENTRY_FORMATS, "custom"),
  });

  if (error) throw new Error(`Could not create competition event: ${error.message}`);
  refresh(eventId);
}

export async function addCompetitionDivisionDanceAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const divisionId = text(formData, "divisionId");
  const danceId = text(formData, "danceId");
  if (!eventId || !programId || !divisionId || !danceId) throw new Error("Division and dance/style are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_division_dances").insert({
    event_id: eventId,
    program_id: programId,
    division_id: divisionId,
    dance_id: danceId,
    entry_fee: nonnegativeAmount(text(formData, "entryFee")),
    currency: (text(formData, "currency") || "USD").toUpperCase(),
    required: text(formData, "required") === "on",
  });

  if (error) throw new Error(`Could not add division offering: ${error.message}`);
  refresh(eventId);
}

export async function createCompetitionRoundAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const divisionId = text(formData, "divisionId");
  const name = text(formData, "name");
  if (!eventId || !programId || !divisionId || !name) throw new Error("Division and round name are required.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_rounds").insert({
    event_id: eventId,
    program_id: programId,
    division_id: divisionId,
    name,
    round_type: allowed(text(formData, "roundType"), ROUND_TYPES, "final"),
    scoring_method: allowed(text(formData, "roundScoringMethod"), SCORING_METHODS, "none"),
    pairing_mode: allowed(text(formData, "pairingMode"), ["fixed", "random_rotation", "random_final_pair", "individual", "team", "none"], "fixed"),
    sequence_number: positiveInteger(text(formData, "sequenceNumber"), 1),
    target_advancement_count: optionalPositiveInteger(text(formData, "targetAdvancementCount")),
  });

  if (error) throw new Error(`Could not create round: ${error.message}`);
  refresh(eventId);
}

export async function updateCompetitionContestRegistrationAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const programId = text(formData, "programId");
  const contestId = text(formData, "contestId");
  const ruleId = text(formData, "ruleId");
  if (!eventId || !programId || !contestId || !ruleId) throw new Error("Competition event registration settings are required.");

  const registrationOpen = text(formData, "registrationOpen") === "on";
  const minimumDances = optionalPositiveInteger(text(formData, "minimumDances"));
  const maximumDances = optionalPositiveInteger(text(formData, "maximumDances"));
  const minimumParticipants = positiveInteger(text(formData, "minimumParticipants"), 1);
  const maximumParticipants = positiveInteger(text(formData, "maximumParticipants"), minimumParticipants);
  if (maximumDances && minimumDances && maximumDances < minimumDances) throw new Error("Maximum dances cannot be less than minimum dances.");
  if (maximumParticipants < minimumParticipants) throw new Error("Maximum participants cannot be less than minimum participants.");

  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any)
    .from("event_competition_contest_registration_rules")
    .update({
      registration_open: registrationOpen,
      dance_selection_mode: allowed(text(formData, "danceSelectionMode"), DANCE_SELECTION_MODES, "none"),
      pricing_method: allowed(text(formData, "pricingMethod"), PRICING_METHODS, "flat_entry"),
      base_entry_fee: nonnegativeAmount(text(formData, "baseEntryFee")),
      currency: (text(formData, "currency") || "USD").toUpperCase(),
      minimum_dances: minimumDances,
      maximum_dances: maximumDances,
      minimum_participants: minimumParticipants,
      maximum_participants: maximumParticipants,
      requires_routine_title: text(formData, "requiresRoutineTitle") === "on",
      requires_music: text(formData, "requiresMusic") === "on",
      requires_duration: text(formData, "requiresDuration") === "on",
      public_description: text(formData, "publicDescription") || null,
    })
    .eq("id", ruleId)
    .eq("event_id", eventId)
    .eq("contest_id", contestId);
  if (error) throw new Error(`Could not update registration settings: ${error.message}`);

  const { error: contestError } = await (supabase as any)
    .from("event_competition_contests")
    .update({ status: registrationOpen ? "open" : "closed" })
    .eq("id", contestId)
    .eq("event_id", eventId);
  if (contestError) throw new Error(`Could not update competition event status: ${contestError.message}`);

  if (registrationOpen) {
    const { error: programError } = await (supabase as any)
      .from("event_competition_programs")
      .update({ status: "configured" })
      .eq("id", programId)
      .eq("event_id", eventId)
      .eq("status", "draft");
    if (programError) throw new Error(`Could not activate competition program: ${programError.message}`);
  }
  refresh(eventId);
}

export async function setCompetitionDivisionRegistrationStatusAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const divisionId = text(formData, "divisionId");
  const status = text(formData, "status") === "open" ? "open" : "closed";
  if (!eventId || !divisionId) throw new Error("Division is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_divisions").update({ status }).eq("id", divisionId).eq("event_id", eventId);
  if (error) throw new Error(`Could not update division registration: ${error.message}`);
  refresh(eventId);
}

export async function updateCompetitionDivisionDanceAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const offeringId = text(formData, "offeringId");
  if (!eventId || !offeringId) throw new Error("Dance offering is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any)
    .from("event_competition_division_dances")
    .update({
      entry_fee: nonnegativeAmount(text(formData, "entryFee")),
      currency: (text(formData, "currency") || "USD").toUpperCase(),
      required: text(formData, "required") === "on",
    })
    .eq("id", offeringId)
    .eq("event_id", eventId);
  if (error) throw new Error(`Could not update dance offering: ${error.message}`);
  refresh(eventId);
}
