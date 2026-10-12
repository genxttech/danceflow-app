import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { buildLifecycleInput, computeLifecycle, type Lifecycle, type LifecycleProgram, type StageState } from "@/lib/competition/lifecycle";
import { PRICING_PENDING_TEXT } from "@/lib/competition/setup/draft";
import PricingCompletionForm from "./PricingCompletionForm";
import PublishForm from "./PublishForm";
import RegistrationForm from "./RegistrationForm";

type ProgramRow = {
  id: string;
  name: string;
  status: string;
  rules_profile_key: string | null;
  rules_profile_version: number | null;
  profile_locked_at: string | null;
  registration_status: "open" | "closed";
  registration_opened_at: string | null;
  configuration: { simple?: { judging?: string } } | null;
};

type RuleRow = { program_id: string; contest_id: string; dance_selection_mode: string; registration_open: boolean };
type ContestRow = {
  id: string;
  program_id: string;
  name: string;
  configuration: { simple?: { category_type?: string }; setup?: { pricing_pending?: boolean } } | null;
};
type DivisionRow = { id: string; program_id: string; contest_id: string | null };
type ProfileRow = {
  profile_key: string;
  version: number;
  name: string;
  defaults: { judging?: Record<string, { label?: string }>; categoryTypes?: Record<string, { pricing_models?: string[] }> } | null;
};

const COMPLETION_MODELS = ["per_dance", "per_entry", "free"];

function StageIcon({ state }: { state: StageState }) {
  if (state === "done") {
    return (
      <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-600 text-xs font-bold text-white">
        ✓
      </span>
    );
  }
  if (state === "current") {
    return <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-slate-950 bg-white"><span className="h-2 w-2 rounded-full bg-slate-950" /></span>;
  }
  return <span aria-hidden="true" className="h-6 w-6 rounded-full border-2 border-slate-200 bg-white" />;
}

function Progress({ lifecycle }: { lifecycle: Lifecycle }) {
  return (
    <ol className="mt-4 space-y-3">
      {lifecycle.stages.map((stage) => (
        <li key={stage.key} className="flex items-start gap-3">
          <StageIcon state={stage.state} />
          <div className={stage.state === "upcoming" && !stage.actionable ? "text-slate-400" : "text-slate-900"}>
            <p className={`text-sm ${stage.state === "current" ? "font-semibold" : ""}`}>{stage.label}</p>
            {stage.note && stage.state !== "done" ? <p className="text-xs text-slate-400">{stage.note}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export default async function CompetitionOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [programResult, contestResult, divisionResult, roundResult, ruleResult, offeringResult, entryResult, heatResult] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name, status, rules_profile_key, rules_profile_version, profile_locked_at, registration_status, registration_opened_at, configuration").eq("event_id", id).order("sort_order").order("created_at"),
    supabase.from("event_competition_contests").select("id, program_id, name, configuration").eq("event_id", id).order("sort_order"),
    supabase.from("event_competition_divisions").select("id, program_id, contest_id").eq("event_id", id),
    supabase.from("event_competition_rounds").select("division_id").eq("event_id", id),
    supabase.from("event_competition_contest_registration_rules").select("contest_id, program_id, dance_selection_mode, registration_open").eq("event_id", id),
    supabase.from("event_competition_division_dances").select("division_id").eq("event_id", id).eq("active", true),
    supabase.from("event_competition_entries").select("program_id").eq("event_id", id),
    supabase.from("event_competition_heats").select("division_id").eq("event_id", id),
  ]);
  const loadError = programResult.error || contestResult.error || divisionResult.error || roundResult.error || ruleResult.error || offeringResult.error || entryResult.error || heatResult.error;
  if (loadError) throw new Error("Could not load the competition overview.");

  const programs = (programResult.data ?? []) as ProgramRow[];
  const allContests = (contestResult.data ?? []) as ContestRow[];
  const allDivisions = (divisionResult.data ?? []) as DivisionRow[];
  const allRounds = (roundResult.data ?? []) as Array<{ division_id: string }>;
  const allRules = (ruleResult.data ?? []) as RuleRow[];
  const allOfferings = (offeringResult.data ?? []) as Array<{ division_id: string }>;
  const allEntries = (entryResult.data ?? []) as Array<{ program_id: string }>;
  const allHeats = (heatResult.data ?? []) as Array<{ division_id: string }>;

  const profileKeys = [...new Set(programs.map((program) => program.rules_profile_key).filter(Boolean) as string[])];
  const { data: profileData } = profileKeys.length
    ? await supabase.from("competition_rules_profiles").select("profile_key, version, name, defaults").in("profile_key", profileKeys)
    : { data: [] };
  const profiles = (profileData ?? []) as ProfileRow[];

  // One card per competition setup on the event (one per style, plus a separate showcase).
  const cards = programs.map((program) => {
    const inProgram = <T extends { program_id: string }>(rows: T[]) => rows.filter((row) => row.program_id === program.id);
    const contests = inProgram(allContests);
    const divisions = inProgram(allDivisions);
    const divisionIds = new Set(divisions.map((division) => division.id));
    const lifecycleProgram: LifecycleProgram = {
      id: program.id,
      name: program.name,
      status: program.status,
      rulesProfileKey: program.rules_profile_key,
      rulesProfileVersion: program.rules_profile_version,
      profileLocked: Boolean(program.profile_locked_at),
      registrationStatus: program.registration_status,
      registrationOpenedAt: program.registration_opened_at,
    };
    const lifecycle = computeLifecycle(
      buildLifecycleInput({
        eventId: id,
        program: lifecycleProgram,
        rows: {
          contests,
          divisions,
          rounds: allRounds.filter((round) => divisionIds.has(round.division_id)),
          rules: inProgram(allRules),
          offerings: allOfferings.filter((offering) => divisionIds.has(offering.division_id)),
        },
        entryCount: inProgram(allEntries).length,
        heatCount: allHeats.filter((heat) => divisionIds.has(heat.division_id)).length,
      }),
    );
    const profile = profiles.find((item) => item.profile_key === program.rules_profile_key && item.version === program.rules_profile_version) ?? null;
    const judging = program.configuration?.simple?.judging;
    const pendingPricing = contests
      .filter((contest) => contest.configuration?.setup?.pricing_pending === true)
      .map((contest) => {
        const allowed = profile?.defaults?.categoryTypes?.[contest.configuration?.simple?.category_type ?? ""]?.pricing_models ?? [];
        return { id: contest.id, name: contest.name, models: COMPLETION_MODELS.filter((model) => allowed.includes(model)) };
      });
    return {
      program,
      lifecycle,
      profileName: profile?.name ?? null,
      judgingLabel: judging ? (profile?.defaults?.judging?.[judging]?.label ?? null) : null,
      pendingPricing,
    };
  });

  const emptyLifecycle = programs.length === 0 ? computeLifecycle(buildLifecycleInput({ eventId: id, program: null, rows: { contests: [], divisions: [], rounds: [], rules: [], offerings: [] }, entryCount: 0, heatCount: 0 })) : null;

  return (
    <div className="space-y-6">
      {query.created ? (
        <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Your competition draft is ready.</p>
          <p className="mt-1">Nothing is published and registration is closed. Review it below, then publish when you are ready.</p>
        </div>
      ) : null}

      {emptyLifecycle ? (
        <section className="rounded-xl border border-slate-200 bg-white p-6">
          <h2 className="text-lg font-semibold text-slate-950">Competition</h2>
          <p className="mt-1 text-sm text-slate-600">{"This event doesn't have a competition set up yet."}</p>
          <div className="mt-6 border-t border-slate-100 pt-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next step</p>
            <h3 className="mt-1 text-xl font-semibold text-slate-950">{emptyLifecycle.primaryAction.label}</h3>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">{emptyLifecycle.primaryAction.description}</p>
            {emptyLifecycle.primaryAction.kind === "link" ? (
              <Link href={emptyLifecycle.primaryAction.href} className="mt-4 inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800">
                {emptyLifecycle.primaryAction.label}
              </Link>
            ) : null}
          </div>
        </section>
      ) : null}

      {cards.map(({ program, lifecycle, profileName, judgingLabel, pendingPricing }) => {
        const action = lifecycle.primaryAction;
        return (
          <section key={program.id} aria-label={program.name} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">{program.name}</h2>
                <p className="mt-1 text-sm text-slate-600">
                  {[
                    lifecycle.published ? "Published" : "Draft",
                    lifecycle.published ? (program.registration_status === "open" ? "Registration open" : "Registration closed") : null,
                    profileName ? `${profileName} rules v${program.rules_profile_version}` : null,
                    judgingLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-semibold ${lifecycle.published ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{lifecycle.published ? "Published" : "Draft"}</span>
            </div>

            {pendingPricing.length > 0 ? (
              <div aria-label="Pricing to finish" className="space-y-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-semibold text-amber-950">{PRICING_PENDING_TEXT}</p>
                {pendingPricing.map((item) => (
                  <PricingCompletionForm key={item.id} eventId={id} contestId={item.id} label={item.name} models={item.models} />
                ))}
              </div>
            ) : null}

            <div className="border-t border-slate-100 pt-5">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Next step</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-950">{action.label}</h3>
              <p className="mt-1 max-w-2xl text-sm text-slate-600">{action.description}</p>
              <div className="mt-4">
                {action.kind === "link" ? (
                  <Link href={action.href} className="inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800">
                    {action.label}
                  </Link>
                ) : action.kind === "publish" ? (
                  <PublishForm eventId={id} programId={action.programId} label={action.label} />
                ) : action.kind === "registration" ? (
                  <RegistrationForm eventId={id} programId={action.programId} mode={action.mode} label={action.label} />
                ) : null}
                {/* Registration control for every published competition the primary action does not cover
                    (Advanced-mode competitions, and reopening after close). */}
                {lifecycle.published && action.kind !== "registration" ? (
                  <div className="mt-3">
                    <RegistrationForm
                      eventId={id}
                      programId={program.id}
                      mode={program.registration_status === "open" ? "close" : "open"}
                      label={program.registration_status === "open" ? "Close registration" : program.registration_opened_at ? "Reopen registration" : "Open registration"}
                      variant="secondary"
                    />
                  </div>
                ) : null}
              </div>
            </div>

            {lifecycle.problems.length > 0 ? (
              <div aria-label="What is missing" className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <h3 className="text-sm font-semibold text-amber-950">What is missing</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
                  {lifecycle.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
                <Link href={`/app/events/${id}/competition/divisions`} className="mt-3 inline-block text-sm font-semibold text-amber-950 underline">
                  Open divisions
                </Link>
              </div>
            ) : null}

            <details open={cards.length === 1} className="border-t border-slate-100 pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-950">Progress</summary>
              <Progress lifecycle={lifecycle} />
            </details>
          </section>
        );
      })}

      {programs.length > 0 ? (
        <p className="text-sm text-slate-500">
          Need more control?{" "}
          <Link href={`/app/events/${id}/competition/advanced`} className="font-semibold text-slate-700 underline">
            Advanced settings
          </Link>{" "}
          keeps everything you set up here and adds rounds, dances, rules and registration details.
        </p>
      ) : null}
    </div>
  );
}
