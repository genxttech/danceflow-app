import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CompetitionFeeRule,
  CompetitionRegistrationCatalog,
  CompetitionRegistrationContest,
  CompetitionRegistrationDivision,
  CompetitionRegistrationOffering,
  CompetitionRegistrationProgram,
  CompetitionRegistrationRule,
} from "@/lib/competition/registrationPricing";

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export async function loadCompetitionRegistrationCatalog(
  supabase: SupabaseClient,
  eventId: string,
): Promise<CompetitionRegistrationCatalog> {
  const [programResult, contestResult, divisionResult, offeringResult, ruleResult, feeRuleResult] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name, discipline_family").eq("event_id", eventId).in("status", ["configured", "active"]).order("sort_order"),
    supabase.from("event_competition_contests").select("id, program_id, name, contest_type, entry_format").eq("event_id", eventId).eq("status", "open").order("sort_order"),
    supabase.from("event_competition_divisions").select("id, program_id, contest_id, name, age_label, skill_label, role_label").eq("event_id", eventId).eq("status", "open").order("sort_order"),
    supabase.from("event_competition_division_dances").select("id, program_id, division_id, dance_id, entry_fee, currency, required, dance:event_competition_dances(dance_key, name, category_label)").eq("event_id", eventId).eq("active", true).order("sort_order"),
    supabase.from("event_competition_contest_registration_rules").select("id, program_id, contest_id, dance_selection_mode, pricing_method, base_entry_fee, currency, minimum_dances, maximum_dances, minimum_participants, maximum_participants, requires_routine_title, requires_music, requires_duration, public_description, terminology").eq("event_id", eventId).eq("registration_open", true),
    supabase.from("event_competition_fee_rules").select("id, program_id, contest_id, division_id, name, calculation_type, registration_mode, amount, percentage, currency, priority").eq("event_id", eventId).eq("active", true).order("priority"),
  ]);
  const error = programResult.error || contestResult.error || divisionResult.error || offeringResult.error || ruleResult.error || feeRuleResult.error;
  if (error) throw new Error(`Could not load competition registration: ${error.message}`);

  const programs = (programResult.data ?? []) as CompetitionRegistrationProgram[];
  const programIds = new Set(programs.map((item) => item.id));
  const rules = (ruleResult.data ?? []).filter((item) => programIds.has(item.program_id)).map((item) => ({ ...item, base_entry_fee: Number(item.base_entry_fee ?? 0), terminology: (item.terminology ?? {}) as Record<string, string> })) as CompetitionRegistrationRule[];
  const openContestIds = new Set(rules.map((item) => item.contest_id));
  const contests = (contestResult.data ?? []).filter((item) => programIds.has(item.program_id) && openContestIds.has(item.id)) as CompetitionRegistrationContest[];
  const contestIds = new Set(contests.map((item) => item.id));
  const divisions = (divisionResult.data ?? []).filter((item) => contestIds.has(item.contest_id)) as CompetitionRegistrationDivision[];
  const divisionIds = new Set(divisions.map((item) => item.id));
  const offerings = (offeringResult.data ?? []).filter((item) => divisionIds.has(item.division_id)).map((item) => ({
    ...item,
    entry_fee: Number(item.entry_fee ?? 0),
    dance: one(item.dance),
  })) as CompetitionRegistrationOffering[];
  const feeRules = (feeRuleResult.data ?? []).map((item) => ({ ...item, amount: Number(item.amount ?? 0), percentage: item.percentage == null ? null : Number(item.percentage) })) as CompetitionFeeRule[];
  return { programs, contests, divisions, offerings, rules, feeRules };
}
