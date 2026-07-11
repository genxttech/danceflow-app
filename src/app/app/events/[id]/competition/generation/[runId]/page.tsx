import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import { acknowledgeHeatPlanConflictAction, applyHeatPlanAction, reviewHeatPlanAction } from "./actions";

type Run = { id: string; run_number: number; status: string; engine_version: string; randomization_seed: string; summary: Record<string, number>; initiated_at: string; completed_at: string | null; schedule_version_id: string };
type ProposalState = { proposal_key: string; contest_name: string; division_name: string; round_name: string; heat_number: number; name: string; schedule_block_id: string; schedule_block_name: string; floor_name: string | null; scheduled_at: string; estimated_ends_at: string; expected_entry_count: number; entry_names: string[]; dances: Array<{ dance_label: string }> };
type Proposal = { id: string; review_status: string; sort_order: number; proposed_state: ProposalState };
type Conflict = { id: string; conflict_type: string; severity: string; status: string; title: string; details: string | null };

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function time(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default async function CompetitionGenerationRunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event, error: eventError } = await supabase.from("events").select("id, name, studio_id").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (eventError || !event) notFound();

  const [runResult, proposalResult, conflictResult, settingsResult] = await Promise.all([
    (supabase as any).from("event_competition_generation_runs").select("id, run_number, status, engine_version, randomization_seed, summary, initiated_at, completed_at, schedule_version_id").eq("id", runId).eq("event_id", id).maybeSingle(),
    (supabase as any).from("event_competition_generation_proposals").select("id, review_status, sort_order, proposed_state").eq("generation_run_id", runId).eq("entity_type", "heat").order("sort_order"),
    (supabase as any).from("event_competition_generation_conflicts").select("id, conflict_type, severity, status, title, details").eq("generation_run_id", runId).order("severity").order("created_at"),
    supabase.from("studio_settings").select("timezone").eq("studio_id", event.studio_id).maybeSingle(),
  ]);
  const loadError = runResult.error || proposalResult.error || conflictResult.error || settingsResult.error;
  if (loadError || !runResult.data) notFound();
  const run = runResult.data as Run;
  const proposals = (proposalResult.data ?? []) as Proposal[];
  const conflicts = (conflictResult.data ?? []) as Conflict[];
  const timeZone = settingsResult.data?.timezone || "America/New_York";
  const blockers = conflicts.filter((item) => item.severity === "blocker" && item.status === "open");
  const openWarnings = conflicts.filter((item) => item.severity !== "blocker" && item.status === "open");
  const blockNames = [...new Set(proposals.map((item) => item.proposed_state.schedule_block_name))];

  return <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5"><div><Link href={`/app/events/${id}/competition/readiness?version=${run.schedule_version_id}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Schedule Readiness</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Proposed Heat Plan</h1><p className="mt-1 text-sm text-slate-600">{event.name} · Run {run.run_number}</p></div><span className={`rounded px-3 py-2 text-sm font-semibold ${run.status === "reviewed" ? "bg-emerald-50 text-emerald-800" : run.status === "rejected" || run.status === "failed" ? "bg-rose-50 text-rose-800" : "bg-slate-100 text-slate-700"}`}>{label(run.status)}</span></header>

    <section className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 sm:grid-cols-5"><div className="bg-white px-4 py-5"><p className="text-2xl font-semibold text-slate-950">{run.summary.proposed_heat_count ?? proposals.length}</p><p className="mt-1 text-xs text-slate-600">Proposed heats</p></div><div className="bg-white px-4 py-5"><p className="text-2xl font-semibold text-slate-950">{run.summary.scheduled_entry_assignments ?? 0}</p><p className="mt-1 text-xs text-slate-600">Entry assignments</p></div><div className="bg-white px-4 py-5"><p className="text-2xl font-semibold text-rose-700">{blockers.length}</p><p className="mt-1 text-xs text-slate-600">Open blockers</p></div><div className="bg-white px-4 py-5"><p className="text-2xl font-semibold text-amber-700">{openWarnings.length}</p><p className="mt-1 text-xs text-slate-600">Open warnings</p></div><div className="bg-white px-4 py-5"><p className="text-sm font-semibold text-slate-950">{run.engine_version}</p><p className="mt-1 text-xs text-slate-600">Planner version</p></div></section>

    {conflicts.length > 0 ? <section className="border-b border-slate-200 py-7"><h2 className="text-lg font-semibold text-slate-950">Conflicts and warnings</h2><div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{conflicts.map((conflict) => <div key={conflict.id} className="flex flex-wrap items-start justify-between gap-4 py-4"><div><div className="flex flex-wrap items-center gap-2"><span className={`rounded px-2 py-1 text-xs font-semibold ${conflict.severity === "blocker" ? "bg-rose-50 text-rose-800" : conflict.severity === "warning" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-700"}`}>{label(conflict.severity)}</span><p className="text-sm font-semibold text-slate-900">{conflict.title}</p>{conflict.status !== "open" ? <span className="text-xs text-slate-500">{label(conflict.status)}</span> : null}</div>{conflict.details ? <p className="mt-2 text-sm text-slate-600">{conflict.details}</p> : null}</div>{run.status === "proposed" && conflict.status === "open" && conflict.severity !== "blocker" ? <form action={acknowledgeHeatPlanConflictAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="conflictId" value={conflict.id} /><button className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Acknowledge</button></form> : null}</div>)}</div></section> : null}

    <section className="py-7"><h2 className="text-lg font-semibold text-slate-950">Proposed program</h2><div className="mt-5 space-y-8">{blockNames.map((blockName) => { const blockProposals = proposals.filter((item) => item.proposed_state.schedule_block_name === blockName); return <div key={blockName}><div className="flex items-end justify-between gap-4 border-b border-slate-300 pb-2"><h3 className="font-semibold text-slate-950">{blockName}</h3><span className="text-xs text-slate-500">{blockProposals.length} heats</span></div><div className="divide-y divide-slate-200">{blockProposals.map((proposal) => { const state = proposal.proposed_state; return <div key={proposal.id} className="grid gap-3 py-4 md:grid-cols-[110px_1fr_180px]"><div><p className="text-sm font-semibold text-slate-950">{time(state.scheduled_at, timeZone)}</p><p className="mt-1 text-xs text-slate-500">{state.floor_name ?? "Floor needed"}</p></div><div><p className="text-sm font-semibold text-slate-900">{state.name}</p><p className="mt-1 text-xs text-slate-600">{state.round_name} · {state.dances.map((dance) => dance.dance_label).join(", ")}</p><p className="mt-2 text-sm text-slate-700">{state.entry_names.length > 0 ? state.entry_names.join(" · ") : `${state.expected_entry_count} callback positions`}</p></div><div className="text-xs text-slate-500 md:text-right">{time(state.scheduled_at, timeZone)}–{time(state.estimated_ends_at, timeZone)}<br />{state.expected_entry_count} expected entries</div></div>; })}</div></div>; })}</div></section>

    {run.status === "proposed" ? <section className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 py-6"><div><h2 className="text-lg font-semibold text-slate-950">Organizer review</h2><p className="mt-1 text-sm text-slate-600">Approval marks this proposal ready for application. It still does not create operational heats.</p>{blockers.length > 0 ? <p className="mt-2 text-sm font-medium text-rose-700">Generate a new plan after correcting all blocking conflicts.</p> : null}</div><div className="flex gap-2"><form action={reviewHeatPlanAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="decision" value="rejected" /><button className="h-10 rounded border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50">Reject plan</button></form><form action={reviewHeatPlanAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="runId" value={runId} /><input type="hidden" name="decision" value="reviewed" /><button disabled={blockers.length > 0} className="h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300">Approve proposal</button></form></div></section> : null}
    {run.status === "reviewed" ? <section className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 py-6"><div><h2 className="text-lg font-semibold text-slate-950">Apply approved plan</h2><p className="mt-1 text-sm text-slate-600">This creates operational heats in the draft schedule. Application is rejected if entries, configuration, constraints, or schedule blocks changed after generation.</p></div><form action={applyHeatPlanAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="runId" value={runId} /><button className="h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800">Apply to draft schedule</button></form></section> : null}
    {run.status === "applied" ? <section className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200 py-6"><div><h2 className="text-lg font-semibold text-emerald-900">Heat plan applied</h2><p className="mt-1 text-sm text-slate-600">The operational heats now belong to this draft schedule. Review the program before publishing.</p></div><Link href={`/app/events/${id}/competition/schedule?version=${run.schedule_version_id}`} className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">Review schedule</Link></section> : null}
  </main>;
}
