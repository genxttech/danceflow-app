import Link from "next/link";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import { buildLifecycleInput, computeLifecycle, type LifecycleProgram, type StageState } from "@/lib/competition/lifecycle";
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
type ContestRow = { id: string; program_id: string };
type DivisionRow = { id: string; program_id: string; contest_id: string | null };

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

export default async function CompetitionOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string; notice?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const { supabase } = await requireCompetitionWorkspace(id);

  const [programResult, contestResult, divisionResult, roundResult, ruleResult, offeringResult, entryResult, heatResult] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name, status, rules_profile_key, rules_profile_version, profile_locked_at, registration_status, registration_opened_at, configuration").eq("event_id", id).order("sort_order").order("created_at"),
    supabase.from("event_competition_contests").select("id, program_id").eq("event_id", id),
    supabase.from("event_competition_divisions").select("id, program_id, contest_id").eq("event_id", id),
    supabase.from("event_competition_rounds").select("division_id").eq("event_id", id),
    supabase.from("event_competition_contest_registration_rules").select("contest_id, program_id, dance_selection_mode, registration_open").eq("event_id", id),
    supabase.from("event_competition_division_dances").select("division_id").eq("event_id", id).eq("active", true),
    supabase.from("event_competition_entries").select("id", { count: "exact", head: true }).eq("event_id", id),
    supabase.from("event_competition_heats").select("id", { count: "exact", head: true }).eq("event_id", id),
  ]);
  const loadError = programResult.error || contestResult.error || divisionResult.error || roundResult.error || ruleResult.error || offeringResult.error || entryResult.error || heatResult.error;
  if (loadError) throw new Error("Could not load the competition overview.");

  const programs = (programResult.data ?? []) as ProgramRow[];
  const primary = programs[0] ?? null;
  const inProgram = <T extends { program_id: string }>(rows: T[]) => (primary ? rows.filter((row) => row.program_id === primary.id) : []);
  const contests = inProgram<ContestRow>((contestResult.data ?? []) as ContestRow[]);
  const divisions = inProgram<DivisionRow>((divisionResult.data ?? []) as DivisionRow[]);
  const divisionIds = new Set(divisions.map((division) => division.id));
  const lifecycleProgram: LifecycleProgram | null = primary
    ? {
        id: primary.id,
        name: primary.name,
        status: primary.status,
        rulesProfileKey: primary.rules_profile_key,
        rulesProfileVersion: primary.rules_profile_version,
        profileLocked: Boolean(primary.profile_locked_at),
        registrationStatus: primary.registration_status,
        registrationOpenedAt: primary.registration_opened_at,
      }
    : null;

  const lifecycle = computeLifecycle(
    buildLifecycleInput({
      eventId: id,
      program: lifecycleProgram,
      rows: {
        contests,
        divisions,
        rounds: ((roundResult.data ?? []) as Array<{ division_id: string }>).filter((round) => divisionIds.has(round.division_id)),
        rules: inProgram<RuleRow>((ruleResult.data ?? []) as RuleRow[]),
        offerings: ((offeringResult.data ?? []) as Array<{ division_id: string }>).filter((offering) => divisionIds.has(offering.division_id)),
      },
      entryCount: entryResult.count ?? 0,
      heatCount: heatResult.count ?? 0,
    }),
  );

  let profileName: string | null = null;
  let judgingLabel: string | null = null;
  if (primary?.rules_profile_key) {
    const { data: profile } = await supabase
      .from("competition_rules_profiles")
      .select("name, defaults")
      .eq("profile_key", primary.rules_profile_key)
      .eq("version", primary.rules_profile_version)
      .maybeSingle();
    profileName = profile?.name ?? null;
    const judging = primary.configuration?.simple?.judging;
    judgingLabel = judging ? (profile?.defaults?.judging?.[judging]?.label ?? null) : null;
  }

  const action = lifecycle.primaryAction;

  return (
    <div className="space-y-6">
      {query.created ? (
        <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Your competition is set up.</p>
          <p className="mt-1">Review it below, then publish when you are ready.{query.notice === "dates" ? " The registration dates could not be saved; you can set them on the event page." : ""}</p>
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">{primary ? primary.name : "Competition"}</h2>
            <p className="mt-1 text-sm text-slate-600">
              {primary
                ? [
                    lifecycle.published ? "Published" : "Draft",
                    lifecycle.published ? (primary.registration_status === "open" ? "Registration open" : "Registration closed") : null,
                    profileName ? `${profileName} rules v${primary.rules_profile_version}` : null,
                    judgingLabel,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "No competition has been set up for this event yet."}
            </p>
          </div>
          {primary ? <span className={`rounded-full px-3 py-1 text-xs font-semibold ${lifecycle.published ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{lifecycle.published ? "Published" : "Draft"}</span> : null}
        </div>

        <div className="mt-6 border-t border-slate-100 pt-5">
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
            {primary && lifecycle.published && action.kind !== "registration" ? (
              <div className="mt-3">
                <RegistrationForm
                  eventId={id}
                  programId={primary.id}
                  mode={primary.registration_status === "open" ? "close" : "open"}
                  label={primary.registration_status === "open" ? "Close registration" : primary.registration_opened_at ? "Reopen registration" : "Open registration"}
                  variant="secondary"
                />
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {lifecycle.problems.length > 0 ? (
        <section aria-label="What is missing" className="rounded-xl border border-amber-200 bg-amber-50 p-5">
          <h3 className="text-sm font-semibold text-amber-950">What is missing</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-900">
            {lifecycle.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <Link href={`/app/events/${id}/competition/divisions`} className="mt-3 inline-block text-sm font-semibold text-amber-950 underline">
            Open divisions
          </Link>
        </section>
      ) : null}

      <section aria-label="Competition progress" className="rounded-xl border border-slate-200 bg-white p-6">
        <h3 className="text-sm font-semibold text-slate-950">Progress</h3>
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
      </section>

      {programs.length > 1 ? (
        <p className="text-sm text-slate-600">
          This event has {programs.length} competition setups; the overview shows the first one. Manage the others in{" "}
          <Link href={`/app/events/${id}/competition/advanced`} className="font-semibold underline">Advanced settings</Link>.
        </p>
      ) : null}

      <p className="text-sm text-slate-500">
        Need more control?{" "}
        <Link href={`/app/events/${id}/competition/advanced`} className="font-semibold text-slate-700 underline">
          Advanced settings
        </Link>{" "}
        keeps everything you set up here and adds rounds, dances, rules and registration details.
      </p>
    </div>
  );
}
