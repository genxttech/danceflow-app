import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  addCompetitionDivisionDanceAction,
  applyCompetitionTemplateAction,
  createCompetitionContestAction,
  createCompetitionDanceAction,
  createCompetitionDivisionAction,
  createCompetitionProgramAction,
  createCompetitionRoundAction,
  restartCompetitionSetupAction,
  setCompetitionDivisionRegistrationStatusAction,
  updateCompetitionContestRegistrationAction,
  updateCompetitionDivisionDanceAction,
  updateWsdcProgramProfileAction,
} from "./actions";

type Template = { template_key: string; name: string; discipline_family: string; version: number; description: string | null };
type Program = { id: string; name: string; discipline_family: string; competition_mode: string; scoring_method: string; advancement_method: string; feedback_policy: string; rules_edition: string | null; status: string };
type Contest = { id: string; program_id: string; name: string; contest_type: string; entry_format: string; status: string };
type Dance = { id: string; program_id: string; dance_key: string; name: string; category_label: string | null };
type Division = { id: string; program_id: string; contest_id: string | null; name: string; age_label: string | null; skill_label: string | null; role_label: string | null; status: string };
type DivisionDance = { id: string; division_id: string; dance_id: string; entry_fee: number | string; currency: string; required: boolean };
type Round = { id: string; division_id: string; name: string; round_type: string; sequence_number: number; target_advancement_count: number | null; scoring_method: string; pairing_mode: string };
type RegistrationRule = { id: string; contest_id: string; registration_open: boolean; dance_selection_mode: string; pricing_method: string; base_entry_fee: number | string; currency: string; minimum_dances: number | null; maximum_dances: number | null; minimum_participants: number; maximum_participants: number; requires_routine_title: boolean; requires_music: boolean; requires_duration: boolean; public_description: string | null };
type WsdcProfile = { program_id: string; rules_edition: string; registry_status: string; registry_event_name: string | null; competitor_surcharge: number | string; surcharge_currency: string; results_reporting_required: boolean };

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

const inputClass = "h-10 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";

export default async function CompetitionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const context = await getCurrentStudioContext();
  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, name")
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (eventError || !event) notFound();

  const [templateResult, programResult, contestResult, danceResult, divisionResult, offeringResult, roundResult, registrationRuleResult, wsdcProfileResult, entryCountResult, heatCountResult] = await Promise.all([
    (supabase as any).from("competition_configuration_templates").select("template_key, name, discipline_family, version, description").eq("status", "active").order("discipline_family"),
    (supabase as any).from("event_competition_programs").select("id, name, discipline_family, competition_mode, scoring_method, advancement_method, feedback_policy, rules_edition, status").eq("event_id", id).order("sort_order").order("created_at"),
    (supabase as any).from("event_competition_contests").select("id, program_id, name, contest_type, entry_format, status").eq("event_id", id).order("sort_order").order("created_at"),
    (supabase as any).from("event_competition_dances").select("id, program_id, dance_key, name, category_label").eq("event_id", id).eq("active", true).order("sort_order").order("name"),
    (supabase as any).from("event_competition_divisions").select("id, program_id, contest_id, name, age_label, skill_label, role_label, status").eq("event_id", id).order("sort_order").order("created_at"),
    (supabase as any).from("event_competition_division_dances").select("id, division_id, dance_id, entry_fee, currency, required").eq("event_id", id).eq("active", true).order("sort_order"),
    (supabase as any).from("event_competition_rounds").select("id, division_id, name, round_type, sequence_number, target_advancement_count, scoring_method, pairing_mode").eq("event_id", id).order("sequence_number"),
    (supabase as any).from("event_competition_contest_registration_rules").select("id, contest_id, registration_open, dance_selection_mode, pricing_method, base_entry_fee, currency, minimum_dances, maximum_dances, minimum_participants, maximum_participants, requires_routine_title, requires_music, requires_duration, public_description").eq("event_id", id),
    (supabase as any).from("event_competition_wsdc_program_profiles").select("program_id, rules_edition, registry_status, registry_event_name, competitor_surcharge, surcharge_currency, results_reporting_required").eq("event_id", id),
    (supabase as any).from("event_competition_entries").select("id", { count: "exact", head: true }).eq("event_id", id),
    (supabase as any).from("event_competition_heats").select("id", { count: "exact", head: true }).eq("event_id", id),
  ]);

  const loadError = templateResult.error || programResult.error || contestResult.error || danceResult.error || divisionResult.error || offeringResult.error || roundResult.error || registrationRuleResult.error || wsdcProfileResult.error || entryCountResult.error || heatCountResult.error;
  if (loadError) throw new Error(`Could not load competition setup: ${loadError.message}`);

  const templates = (templateResult.data ?? []) as Template[];
  const programs = (programResult.data ?? []) as Program[];
  const contests = (contestResult.data ?? []) as Contest[];
  const dances = (danceResult.data ?? []) as Dance[];
  const divisions = (divisionResult.data ?? []) as Division[];
  const offerings = (offeringResult.data ?? []) as DivisionDance[];
  const rounds = (roundResult.data ?? []) as Round[];
  const registrationRules = (registrationRuleResult.data ?? []) as RegistrationRule[];
  const wsdcProfiles = (wsdcProfileResult.data ?? []) as WsdcProfile[];
  const unassignedDivisions = divisions.filter((division) => !division.contest_id);

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div><Link href={`/app/events/${id}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to event</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Competition Setup</h1><p className="mt-1 text-sm text-slate-600">{event.name}</p></div>
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold text-slate-700"><Link href={`/app/events/${id}/competition/schedule`} className="rounded bg-slate-950 px-3 py-2 text-white hover:bg-slate-800">Schedule of Events</Link><span className="rounded border border-slate-200 px-3 py-1">{entryCountResult.count ?? 0} entries</span><span className="rounded border border-slate-200 px-3 py-1">{heatCountResult.count ?? 0} heats</span></div>
      </header>

      <section className="border-b border-slate-200 py-6">
        <h2 className="text-lg font-semibold text-slate-950">Start from a template</h2>
        <p className="mt-1 text-sm text-slate-600">Templates create editable category shells. Review every division, fee, rule setting, and round before opening registration.</p>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {templates.map((template) => (
            <form key={`${template.template_key}:${template.version}`} action={applyCompetitionTemplateAction} className="rounded border border-slate-200 p-4">
              <input type="hidden" name="eventId" value={id} /><input type="hidden" name="templateKey" value={template.template_key} />
              <div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold text-slate-950">{template.name}</h3><p className="mt-1 text-sm text-slate-600">{template.description}</p></div><span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">v{template.version}</span></div>
              <button className={`${buttonClass} mt-4`}>Apply {template.name}</button>
            </form>
          ))}
        </div>
      </section>

      <details className="border-b border-slate-200 py-5">
        <summary className="cursor-pointer text-sm font-semibold text-slate-800">Create a custom program instead</summary>
        <form action={createCompetitionProgramAction} className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-4">
          <input type="hidden" name="eventId" value={id} /><input name="name" required placeholder="Program name" className={inputClass} />
          <select name="disciplineFamily" className={inputClass} defaultValue="custom"><option value="showcase">Showcase</option><option value="ballroom">Ballroom</option><option value="country">Country</option><option value="west_coast_swing">West Coast Swing</option><option value="collegiate_amateur">Collegiate / Amateur</option><option value="custom">Custom</option></select>
          <select name="competitionMode" className={inputClass} defaultValue="feedback_only"><option value="relative">Relative competition</option><option value="proficiency">Proficiency</option><option value="feedback_only">Feedback only</option><option value="exhibition">Exhibition</option></select>
          <select name="scoringMethod" className={inputClass} defaultValue="feedback_only"><option value="feedback_only">Feedback only</option><option value="skating">Skating System</option><option value="majority_rules">Majority Rules</option><option value="round_specific">Round-specific scoring</option><option value="wsdc_callback">WSDC Callback</option><option value="relative_placement">Relative Placement</option><option value="proficiency">Proficiency</option><option value="cumulative_points">Cumulative points</option><option value="none">No scoring</option><option value="custom">Custom</option></select>
          <select name="advancementMethod" className={inputClass} defaultValue="none"><option value="none">No advancement</option><option value="recall_count">Recall count</option><option value="promote_callback">Promote callback</option><option value="retire_callback">Retire callback</option><option value="custom">Custom</option></select>
          <select name="feedbackPolicy" className={inputClass} defaultValue="required"><option value="required">Feedback required</option><option value="optional">Feedback optional</option><option value="none">No feedback</option></select>
          <input name="rulesEdition" placeholder="Rules edition" className={inputClass} /><button className={buttonClass}>Add custom program</button>
        </form>
      </details>

      {programs.length === 0 ? <div className="mt-6 rounded border border-dashed border-slate-300 px-5 py-10 text-center text-sm text-slate-600">Apply a starter template or create a custom program.</div> : (
        <div className="mt-7 space-y-10">
          {programs.map((program) => {
            const programDances = dances.filter((dance) => dance.program_id === program.id);
            const programContests = contests.filter((contest) => contest.program_id === program.id);
            const wsdcProfile = wsdcProfiles.find((profile) => profile.program_id === program.id);
            return (
              <section key={program.id} className="border-b border-slate-300 pb-8">
                <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold text-slate-950">{program.name}</h2><p className="mt-1 text-sm text-slate-600">{label(program.discipline_family)} · {label(program.competition_mode)} · {label(program.scoring_method)}</p><p className="mt-1 text-xs text-slate-500">{label(program.advancement_method)} · {label(program.feedback_policy)}{program.rules_edition ? ` · ${program.rules_edition}` : ""}</p></div><span className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700">{label(program.status)}</span></div>
                {wsdcProfile ? <details className="mt-5 border-y border-slate-200 py-4"><summary className="cursor-pointer text-sm font-semibold text-slate-900">WSDC rules profile · {label(wsdcProfile.registry_status)}</summary><form action={updateWsdcProgramProfileAction} className="mt-4 grid gap-3 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><select name="registryStatus" defaultValue={wsdcProfile.registry_status} className={inputClass}><option value="not_declared">Not declared as a Registry Event</option><option value="trial">WSDC Trial Event</option><option value="approved">Approved WSDC Registry Event</option><option value="not_applicable">WSDC rules profile, non-Registry event</option></select><input name="registryEventName" defaultValue={wsdcProfile.registry_event_name ?? ""} placeholder="Registry event name, if approved" className={inputClass} /><input name="competitorSurcharge" type="number" min="0" step="0.01" defaultValue={Number(wsdcProfile.competitor_surcharge)} placeholder="Per-entry WSDC surcharge" className={inputClass} /><input name="surchargeCurrency" defaultValue={wsdcProfile.surcharge_currency} className={inputClass} /><label className="flex items-center gap-2 text-sm text-slate-700 md:col-span-2"><input type="checkbox" name="resultsReportingRequired" defaultChecked={wsdcProfile.results_reporting_required} /> Require WSDC results reporting</label><p className="text-xs text-slate-600 md:col-span-2">Selecting a status records the organizer declaration; it does not grant or imply WSDC approval.</p><button className={`${buttonClass} md:col-span-2 xl:col-span-4`}>Save WSDC settings</button></form></details> : null}

                <div className="mt-6 grid gap-6 lg:grid-cols-2">
                  <div><h3 className="text-sm font-semibold text-slate-950">Dance / style catalog</h3><form action={createCompetitionDanceAction} className="mt-3 grid gap-2 bg-slate-50 p-3 sm:grid-cols-2"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input name="name" required placeholder="Dance or style name" className={inputClass} /><input name="danceKey" placeholder="Optional internal key" className={inputClass} /><input name="categoryLabel" placeholder="Category label" className={inputClass} /><button className={buttonClass}>Add dance/style</button></form><div className="mt-3 flex flex-wrap gap-2">{programDances.map((dance) => <span key={dance.id} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{dance.name}{dance.category_label ? ` · ${dance.category_label}` : ""}</span>)}</div></div>
                  <div><h3 className="text-sm font-semibold text-slate-950">Add competition event</h3><form action={createCompetitionContestAction} className="mt-3 grid gap-2 bg-slate-50 p-3 sm:grid-cols-2"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input name="name" required placeholder="Competition event name" className={inputClass} /><input name="code" placeholder="Optional code" className={inputClass} /><select name="contestType" className={inputClass} defaultValue="custom"><option value="single_dance">Single dance</option><option value="multi_dance">Multi-dance</option><option value="scholarship">Scholarship</option><option value="showdance">Showdance</option><option value="cabaret">Cabaret</option><option value="formation">Formation</option><option value="line_dance">Line dance</option><option value="team">Team</option><option value="spotlight">Spotlight</option><option value="jack_and_jill">Jack and Jill</option><option value="strictly">Strictly</option><option value="custom">Custom</option></select><select name="entryFormat" className={inputClass} defaultValue="custom"><option value="solo">Solo</option><option value="couple">Couple</option><option value="pro_am">Pro/Am</option><option value="pro_pro">Pro/Pro</option><option value="mixed_amateur">Mixed amateur</option><option value="professional">Professional</option><option value="team">Team</option><option value="random_partner">Random partner</option><option value="custom">Custom</option></select><button className={buttonClass}>Add competition event</button></form></div>
                </div>

                <div className="mt-7 space-y-7">
                  {programContests.map((contest) => {
                    const contestDivisions = divisions.filter((division) => division.contest_id === contest.id);
                    const registrationRule = registrationRules.find((rule) => rule.contest_id === contest.id);
                    return (
                      <div key={contest.id} className="border-l-2 border-slate-400 pl-4">
                        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-slate-950">{contest.name}</h3><p className="mt-1 text-xs text-slate-500">{label(contest.contest_type)} · {label(contest.entry_format)} · {label(contest.status)}</p></div><span className="text-xs text-slate-500">{contestDivisions.length} divisions</span></div>
                        {registrationRule ? <details className="mt-3 border-y border-slate-200 py-3"><summary className="cursor-pointer text-sm font-semibold text-slate-800">Public registration configuration · {registrationRule.registration_open ? "Open" : "Closed"}</summary><form action={updateCompetitionContestRegistrationAction} className="mt-4 grid gap-3 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input type="hidden" name="contestId" value={contest.id} /><input type="hidden" name="ruleId" value={registrationRule.id} /><select name="danceSelectionMode" className={inputClass} defaultValue={registrationRule.dance_selection_mode}><option value="individual">Registrant chooses individual dances</option><option value="prescribed_set">Configured dance set included</option><option value="choose_count">Registrant chooses a set number</option><option value="routine">Routine or performance entry</option><option value="none">No dance selection</option></select><select name="pricingMethod" className={inputClass} defaultValue={registrationRule.pricing_method}><option value="per_dance">Price each selected dance</option><option value="flat_entry">Flat price per entry</option><option value="base_plus_dance">Base price plus selected dances</option><option value="included_set">Flat price including dance set</option></select><input name="baseEntryFee" type="number" min="0" step="0.01" defaultValue={Number(registrationRule.base_entry_fee)} placeholder="Base entry fee" className={inputClass} /><input name="currency" defaultValue={registrationRule.currency} className={inputClass} /><input name="minimumDances" type="number" min="1" defaultValue={registrationRule.minimum_dances ?? ""} placeholder="Minimum dances" className={inputClass} /><input name="maximumDances" type="number" min="1" defaultValue={registrationRule.maximum_dances ?? ""} placeholder="Maximum dances" className={inputClass} /><input name="minimumParticipants" type="number" min="1" defaultValue={registrationRule.minimum_participants} placeholder="Minimum participants" className={inputClass} /><input name="maximumParticipants" type="number" min="1" defaultValue={registrationRule.maximum_participants} placeholder="Maximum participants" className={inputClass} /><textarea name="publicDescription" defaultValue={registrationRule.public_description ?? ""} placeholder="Public registration description" className="min-h-20 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 md:col-span-2 xl:col-span-4" /><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="requiresRoutineTitle" defaultChecked={registrationRule.requires_routine_title} /> Require routine title</label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="requiresMusic" defaultChecked={registrationRule.requires_music} /> Require music details</label><label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="requiresDuration" defaultChecked={registrationRule.requires_duration} /> Require routine duration</label><label className="flex items-center gap-2 text-sm font-semibold text-slate-900"><input type="checkbox" name="registrationOpen" defaultChecked={registrationRule.registration_open} /> Open this competition event for registration</label><button className={`${buttonClass} md:col-span-2 xl:col-span-4`}>Save registration configuration</button></form></details> : <p className="mt-3 text-sm text-amber-700">Registration profile missing. Re-run the registration-cart migration to backfill this competition event.</p>}
                        <form action={createCompetitionDivisionAction} className="mt-3 grid gap-2 bg-slate-50 p-3 md:grid-cols-3 xl:grid-cols-6"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input type="hidden" name="contestId" value={contest.id} /><input name="name" required placeholder="Division name" className={inputClass} /><input name="code" placeholder="Code" className={inputClass} /><input name="ageLabel" placeholder="Age" className={inputClass} /><input name="skillLabel" placeholder="Skill" className={inputClass} /><input name="roleLabel" placeholder="Role" className={inputClass} /><button className={buttonClass}>Add division</button></form>

                        <div className="mt-4 space-y-5">
                          {contestDivisions.map((division) => {
                            const divisionOfferings = offerings.filter((offering) => offering.division_id === division.id);
                            const divisionRounds = rounds.filter((round) => round.division_id === division.id);
                            return (
                              <div key={division.id} className="border-t border-slate-200 pt-4">
                                <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-semibold text-slate-900">{division.name}</h4><p className="mt-1 text-xs text-slate-500">{[division.age_label, division.skill_label, division.role_label].filter(Boolean).join(" · ") || "Classification not specified"} · {label(division.status)}</p></div><form action={setCompetitionDivisionRegistrationStatusAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="divisionId" value={division.id} /><input type="hidden" name="status" value={division.status === "open" ? "closed" : "open"} /><button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">{division.status === "open" ? "Close registration" : "Open registration"}</button></form></div>
                                <div className="mt-3 grid gap-5 xl:grid-cols-2">
                                  <div><p className="text-xs font-semibold uppercase text-slate-500">Registration offerings</p><form action={addCompetitionDivisionDanceAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px_90px_auto]"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input type="hidden" name="divisionId" value={division.id} /><select name="danceId" required className={inputClass} defaultValue=""><option value="" disabled>Select dance/style</option>{programDances.map((dance) => <option key={dance.id} value={dance.id}>{dance.name}</option>)}</select><input name="entryFee" type="number" min="0" step="0.01" defaultValue="0" className={inputClass} /><input name="currency" defaultValue="USD" className={inputClass} /><button className={buttonClass}>Add</button></form><div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{divisionOfferings.map((offering) => { const dance = programDances.find((item) => item.id === offering.dance_id); return <form key={offering.id} action={updateCompetitionDivisionDanceAction} className="grid gap-2 py-2 sm:grid-cols-[1fr_100px_80px_auto_auto] sm:items-center"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="offeringId" value={offering.id} /><span className="text-sm font-medium text-slate-800">{dance?.name ?? "Dance"}</span><input name="entryFee" type="number" min="0" step="0.01" defaultValue={Number(offering.entry_fee)} className={inputClass} /><input name="currency" defaultValue={offering.currency} className={inputClass} /><label className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" name="required" defaultChecked={offering.required} /> Required</label><button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Save</button></form>; })}</div></div>
                                  <div><p className="text-xs font-semibold uppercase text-slate-500">Round structure</p><form action={createCompetitionRoundAction} className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="programId" value={program.id} /><input type="hidden" name="divisionId" value={division.id} /><input name="name" required placeholder="Round name" className={inputClass} /><select name="roundType" className={inputClass} defaultValue="final"><option value="preliminary">Preliminary</option><option value="quarterfinal">Quarterfinal</option><option value="semifinal">Semifinal</option><option value="final">Final</option><option value="proficiency">Proficiency</option><option value="feedback">Feedback</option><option value="exhibition">Exhibition</option><option value="custom">Custom</option></select><select name="roundScoringMethod" className={inputClass} defaultValue={program.discipline_family === "west_coast_swing" ? "wsdc_callback" : program.scoring_method}><option value="wsdc_callback">WSDC Callback</option><option value="relative_placement">Relative Placement</option><option value="majority_rules">Majority Rules</option><option value="skating">Skating System</option><option value="proficiency">Proficiency</option><option value="feedback_only">Feedback only</option><option value="none">No scoring</option><option value="custom">Custom</option></select><select name="pairingMode" className={inputClass} defaultValue={program.discipline_family === "west_coast_swing" ? "random_rotation" : "fixed"}><option value="fixed">Fixed partners</option><option value="random_rotation">Random partner rotation</option><option value="random_final_pair">Random final pairing</option><option value="individual">Individual</option><option value="team">Team</option><option value="none">No pairing</option></select><input name="sequenceNumber" type="number" min="1" defaultValue={divisionRounds.length + 1} className={inputClass} /><input name="targetAdvancementCount" type="number" min="1" placeholder="Target" className={inputClass} /><button className={buttonClass}>Add</button></form><div className="mt-2 flex flex-wrap gap-2">{divisionRounds.map((round) => <span key={round.id} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{round.sequence_number}. {round.name} · {label(round.round_type)} · {label(round.scoring_method)} · {label(round.pairing_mode)}</span>)}</div></div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {unassignedDivisions.length > 0 ? <section className="mt-6 rounded border border-amber-200 bg-amber-50 p-4"><h2 className="font-semibold text-amber-950">Legacy divisions need a competition event</h2><p className="mt-1 text-sm text-amber-800">{unassignedDivisions.length} divisions were created before the competition-event layer. Keep them out of registration until they are assigned or recreated.</p></section> : null}
      <section className="mt-8 border-t border-slate-200 pt-6"><h2 className="text-lg font-semibold text-slate-950">Entries and heats</h2><p className="mt-2 text-sm text-slate-600">Competition entries are collected through the dedicated individual and studio registration flow. Heat generation uses confirmed entries after eligibility review.</p><div className="mt-4 flex flex-wrap gap-2"><Link href={`/app/events/${id}/competition/registrations`} className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Competition registrations</Link><Link href={`/app/events/${id}/competition/checkin`} className="rounded border border-slate-950 px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50">Competition check-in</Link><Link href={`/app/events/${id}/registrations`} className="rounded border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50">Ticket registrations</Link></div></section>
      {programs.length > 0 ? (
        <details className="mt-8 border-t border-red-200 pt-6">
          <summary className="cursor-pointer text-sm font-semibold text-red-700">Restart competition setup</summary>
          <div className="mt-4 max-w-2xl border border-red-200 bg-red-50 p-4">
            <h2 className="font-semibold text-red-950">Delete all draft competition setup</h2>
            <p className="mt-2 text-sm text-red-800">This removes every competition program, contest, division, dance, round, draft schedule, floor, and generation setting for this event. It is blocked after registration or live operational data exists.</p>
            <form action={restartCompetitionSetupAction} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="eventId" value={id} />
              <label className="flex-1 text-xs font-semibold text-red-900">Type RESTART COMPETITION<input name="confirmation" required autoComplete="off" className="mt-1 h-10 w-full rounded border border-red-300 bg-white px-3 text-sm text-slate-950" /></label>
              <button className="h-10 rounded bg-red-700 px-4 text-sm font-semibold text-white hover:bg-red-800">Restart setup</button>
            </form>
          </div>
        </details>
      ) : null}
    </main>
  );
}
