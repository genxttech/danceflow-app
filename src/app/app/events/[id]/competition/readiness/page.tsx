import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import {
  addRecommendedConstraintsAction,
  createGenerationConstraintAction,
  disableGenerationConstraintAction,
  generateHeatPlanAction,
} from "./actions";

type Version = { id: string; version_number: number; name: string; status: string };
type Constraint = { id: string; name: string; constraint_type: string; enforcement: string; configuration: Record<string, unknown> };
type Contest = { id: string };
type Division = { id: string; contest_id: string | null };
type Round = { id: string; division_id: string };
type Block = { id: string; block_type: string };
type Assignment = { id: string; block_id: string };
type Run = { id: string; run_number: number; status: string; engine_version: string; initiated_at: string };

const inputClass = "h-10 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";
const REQUIRED_RULES = ["floor_capacity", "dancer_conflict", "instructor_conflict", "partner_conflict"];

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function configurationLabel(constraint: Constraint) {
  const value = constraint.configuration ?? {};
  if (constraint.constraint_type === "minimum_gap" && value.minutes) return `${value.minutes} minutes`;
  if (constraint.constraint_type === "estimated_duration" && value.seconds) return `${Number(value.seconds) / 60} minutes`;
  if (constraint.constraint_type === "time_window") return [value.earliest_time, value.latest_time].filter(Boolean).join(" to ");
  if (value.note) return String(value.note);
  return null;
}

function CheckRow({ ready, title, detail }: { ready: boolean; title: string; detail: string }) {
  return <div className="flex items-start justify-between gap-4 border-b border-slate-200 py-3 last:border-0"><div><p className="text-sm font-semibold text-slate-900">{title}</p><p className="mt-1 text-xs text-slate-600">{detail}</p></div><span className={`shrink-0 rounded px-2 py-1 text-xs font-semibold ${ready ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{ready ? "Ready" : "Needs attention"}</span></div>;
}

export default async function CompetitionReadinessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
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

  const { data: versionData, error: versionError } = await (supabase as any)
    .from("event_competition_schedule_versions")
    .select("id, version_number, name, status")
    .eq("event_id", id)
    .order("version_number", { ascending: false });
  if (versionError) throw new Error(`Could not load schedule versions: ${versionError.message}`);
  const versions = (versionData ?? []) as Version[];
  const selectedVersion = versions.find((item) => item.id === query.version) ?? versions.find((item) => item.status === "draft") ?? versions[0] ?? null;

  const [programResult, contestResult, divisionResult, roundResult, entryResult, floorResult] = await Promise.all([
    (supabase as any).from("event_competition_programs").select("id", { count: "exact", head: true }).eq("event_id", id),
    (supabase as any).from("event_competition_contests").select("id").eq("event_id", id).neq("status", "cancelled"),
    (supabase as any).from("event_competition_divisions").select("id, contest_id").eq("event_id", id).neq("status", "cancelled"),
    (supabase as any).from("event_competition_rounds").select("id, division_id").eq("event_id", id).neq("status", "cancelled"),
    (supabase as any).from("event_competition_entries").select("id, status, eligibility_status").eq("event_id", id),
    (supabase as any).from("event_competition_schedule_floors").select("id", { count: "exact", head: true }).eq("event_id", id).eq("active", true),
  ]);
  const baseError = programResult.error || contestResult.error || divisionResult.error || roundResult.error || entryResult.error || floorResult.error;
  if (baseError) throw new Error(`Could not calculate schedule readiness: ${baseError.message}`);

  let blocks: Block[] = [];
  let assignments: Assignment[] = [];
  let constraints: Constraint[] = [];
  let sessionCount = 0;
  let runs: Run[] = [];
  if (selectedVersion) {
    const [sessionResult, blockResult, assignmentResult, constraintResult, runResult] = await Promise.all([
      (supabase as any).from("event_competition_schedule_sessions").select("id", { count: "exact", head: true }).eq("schedule_version_id", selectedVersion.id),
      (supabase as any).from("event_competition_schedule_blocks").select("id, block_type").eq("schedule_version_id", selectedVersion.id),
      (supabase as any).from("event_competition_schedule_block_contests").select("id, block_id").eq("schedule_version_id", selectedVersion.id),
      (supabase as any).from("event_competition_generation_constraints").select("id, name, constraint_type, enforcement, configuration").eq("event_id", id).eq("schedule_version_id", selectedVersion.id).eq("active", true).order("created_at"),
      (supabase as any).from("event_competition_generation_runs").select("id, run_number, status, engine_version, initiated_at").eq("schedule_version_id", selectedVersion.id).order("run_number", { ascending: false }).limit(5),
    ]);
    const detailError = sessionResult.error || blockResult.error || assignmentResult.error || constraintResult.error || runResult.error;
    if (detailError) throw new Error(`Could not load readiness details: ${detailError.message}`);
    sessionCount = sessionResult.count ?? 0;
    blocks = (blockResult.data ?? []) as Block[];
    assignments = (assignmentResult.data ?? []) as Assignment[];
    constraints = (constraintResult.data ?? []) as Constraint[];
    runs = (runResult.data ?? []) as Run[];
  }

  const contests = (contestResult.data ?? []) as Contest[];
  const divisions = (divisionResult.data ?? []) as Division[];
  const rounds = (roundResult.data ?? []) as Round[];
  const entries = (entryResult.data ?? []) as Array<{ id: string; status: string; eligibility_status: string }>;
  const contestsWithoutDivisions = contests.filter((contest) => !divisions.some((division) => division.contest_id === contest.id)).length;
  const divisionsWithoutRounds = divisions.filter((division) => !rounds.some((round) => round.division_id === division.id)).length;
  const competitionBlocks = blocks.filter((block) => block.block_type === "competition");
  const unassignedBlocks = competitionBlocks.filter((block) => !assignments.some((assignment) => assignment.block_id === block.id)).length;
  const readyEntries = entries.filter((entry) => entry.status === "confirmed" && ["eligible", "waived"].includes(entry.eligibility_status)).length;
  const reviewEntries = entries.filter((entry) => ["pending", "confirmed", "waitlisted"].includes(entry.status) && !["eligible", "waived"].includes(entry.eligibility_status)).length;
  const configuredRuleTypes = new Set(constraints.map((constraint) => constraint.constraint_type));
  const missingRequiredRules = REQUIRED_RULES.filter((rule) => !configuredRuleTypes.has(rule));
  const checks = [
    (programResult.count ?? 0) > 0,
    contests.length > 0 && contestsWithoutDivisions === 0,
    divisions.length > 0 && divisionsWithoutRounds === 0,
    readyEntries > 0,
    reviewEntries === 0,
    (floorResult.count ?? 0) > 0,
    sessionCount > 0,
    competitionBlocks.length > 0 && unassignedBlocks === 0,
    missingRequiredRules.length === 0,
  ];
  const readyCount = checks.filter(Boolean).length;
  const editable = selectedVersion?.status === "draft";

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5"><div><Link href={`/app/events/${id}/competition/schedule`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Schedule of Events</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Schedule Readiness</h1><p className="mt-1 text-sm text-slate-600">{event.name}</p></div><span className={`rounded px-3 py-2 text-sm font-semibold ${readyCount === checks.length ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{readyCount} of {checks.length} ready</span></header>

    <section className="border-b border-slate-200 py-5"><div className="flex flex-wrap gap-2">{versions.map((version) => <Link key={version.id} href={`?version=${version.id}`} className={`rounded border px-3 py-2 text-sm ${selectedVersion?.id === version.id ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 text-slate-700"}`}>v{version.version_number} · {version.name} · {label(version.status)}</Link>)}</div></section>

    {!selectedVersion ? <div className="mt-8 rounded border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-600">Create a schedule draft before configuring generation readiness.</div> : <>
      <section className="grid gap-8 py-7 lg:grid-cols-2"><div><h2 className="text-lg font-semibold text-slate-950">Configuration checks</h2><div className="mt-3 border-y border-slate-200"><CheckRow ready={(programResult.count ?? 0) > 0} title="Competition programs" detail={`${programResult.count ?? 0} configured`} /><CheckRow ready={contests.length > 0 && contestsWithoutDivisions === 0} title="Competition events and divisions" detail={`${contests.length} events · ${contestsWithoutDivisions} without divisions`} /><CheckRow ready={divisions.length > 0 && divisionsWithoutRounds === 0} title="Round structures" detail={`${divisions.length} divisions · ${divisionsWithoutRounds} without rounds`} /><CheckRow ready={(floorResult.count ?? 0) > 0} title="Floors and capacity" detail={`${floorResult.count ?? 0} active floors`} /><CheckRow ready={sessionCount > 0} title="Sessions" detail={`${sessionCount} scheduled`} /></div></div>
      <div><h2 className="text-lg font-semibold text-slate-950">Operational checks</h2><div className="mt-3 border-y border-slate-200"><CheckRow ready={readyEntries > 0} title="Eligible entries" detail={`${readyEntries} confirmed and eligible`} /><CheckRow ready={reviewEntries === 0} title="Eligibility review" detail={`${reviewEntries} entries still need review`} /><CheckRow ready={competitionBlocks.length > 0 && unassignedBlocks === 0} title="Contest blocks" detail={`${competitionBlocks.length} competition blocks · ${unassignedBlocks} unassigned`} /><CheckRow ready={missingRequiredRules.length === 0} title="Core conflict rules" detail={missingRequiredRules.length === 0 ? "Capacity, dancer, instructor, and partner rules configured" : `${missingRequiredRules.length} required rules missing`} /></div></div></section>

      <section className="border-t border-slate-200 py-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-slate-950">Generation rules</h2><p className="mt-1 text-sm text-slate-600">Hard rules block an invalid schedule. Soft rules produce warnings for organizer review.</p></div>{editable && missingRequiredRules.length > 0 ? <form action={addRecommendedConstraintsAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="scheduleVersionId" value={selectedVersion.id} /><button className={buttonClass}>Add recommended rules</button></form> : null}</div>
      <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">{constraints.map((constraint) => <div key={constraint.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-semibold text-slate-900">{constraint.name}</p><p className="mt-1 text-xs text-slate-600">{label(constraint.constraint_type)} · {label(constraint.enforcement)}{configurationLabel(constraint) ? ` · ${configurationLabel(constraint)}` : ""}</p></div>{editable ? <form action={disableGenerationConstraintAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="constraintId" value={constraint.id} /><button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Disable</button></form> : null}</div>)}</div>

      {editable ? <form action={createGenerationConstraintAction} className="mt-5 grid gap-3 bg-slate-50 p-4 md:grid-cols-2 xl:grid-cols-4"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="scheduleVersionId" value={selectedVersion.id} /><input name="name" required placeholder="Rule name" className={inputClass} /><select name="constraintType" className={inputClass} defaultValue="minimum_gap"><option value="minimum_gap">Minimum turnaround</option><option value="estimated_duration">Estimated heat duration</option><option value="time_window">Allowed time window</option><option value="judge_availability">Judge availability</option><option value="keep_together">Keep together</option><option value="keep_separate">Keep separate</option><option value="round_requirement">Round requirement</option><option value="floor_assignment">Floor assignment</option><option value="custom">Custom</option></select><select name="enforcement" className={inputClass} defaultValue="hard"><option value="hard">Hard rule</option><option value="soft">Soft warning</option><option value="informational">Information only</option></select><input name="amount" type="number" min="0.25" step="0.25" placeholder="Minutes, when applicable" className={inputClass} /><input name="earliestTime" type="time" className={inputClass} /><input name="latestTime" type="time" className={inputClass} /><input name="note" placeholder="Optional rule details" className={`${inputClass} xl:col-span-2`} /><button className={`${buttonClass} xl:col-span-4`}>Add schedule rule</button></form> : null}</section>

      <section className="border-t border-slate-200 py-7"><div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-semibold text-slate-950">Heat generation</h2>{readyCount === checks.length ? <p className="mt-2 text-sm text-emerald-800">This schedule is ready to generate a proposed heat plan.</p> : <p className="mt-2 text-sm text-amber-800">Resolve the remaining readiness items before generating heats.</p>}<p className="mt-2 text-sm text-slate-600">Every run creates a reviewable proposal. It does not change operational heats or the published program.</p></div>{editable && readyCount === checks.length ? <form action={generateHeatPlanAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="scheduleVersionId" value={selectedVersion.id} /><button className={buttonClass}>Generate proposed heats</button></form> : null}</div>{runs.length > 0 ? <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">{runs.map((run) => <Link key={run.id} href={`/app/events/${id}/competition/generation/${run.id}`} className="flex justify-between gap-4 py-3 text-sm hover:bg-slate-50"><span>Run {run.run_number} · {label(run.status)}</span><span className="text-slate-500">Review plan</span></Link>)}</div> : null}</section>
    </>}
  </main>;
}
