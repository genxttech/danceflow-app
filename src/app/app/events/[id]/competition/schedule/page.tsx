import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";
import {
  assignContestToBlockAction,
  createScheduleBlockAction,
  createScheduleFloorAction,
  createScheduleSessionAction,
  createScheduleVersionAction,
  publishScheduleVersionAction,
} from "./actions";

type Version = { id: string; version_number: number; name: string; status: string; published_at: string | null };
type Floor = { id: string; name: string; location_label: string | null; capacity: number };
type Session = { id: string; name: string; session_date: string; starts_at: string; ends_at: string };
type Block = { id: string; session_id: string; floor_id: string | null; floor_name_snapshot: string | null; floor_capacity_snapshot: number | null; name: string; block_type: string; starts_at: string; ends_at: string };
type Contest = { id: string; name: string; program_id: string; program: { name: string } | null };
type Assignment = { id: string; block_id: string; contest_id: string; planned_round_type: string | null };
type Heat = { id: string; schedule_block_id: string; name: string | null; scheduled_at: string; estimated_ends_at: string | null; status: string; configuration: { expected_entry_count?: number } | null };
type HeatDance = { heat_id: string; dance_label: string; sequence_number: number };
type HeatEntry = { heat_id: string };

const inputClass = "h-10 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function time(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default async function CompetitionSchedulePage({
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
    .select("id, name, studio_id")
    .eq("id", id)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (eventError || !event) notFound();

  const [versionResult, floorResult, contestResult, settingsResult] = await Promise.all([
    (supabase as any).from("event_competition_schedule_versions").select("id, version_number, name, status, published_at").eq("event_id", id).order("version_number", { ascending: false }),
    (supabase as any).from("event_competition_schedule_floors").select("id, name, location_label, capacity").eq("event_id", id).eq("active", true).order("sort_order").order("name"),
    (supabase as any).from("event_competition_contests").select("id, name, program_id, program:event_competition_programs(name)").eq("event_id", id).neq("status", "cancelled").order("sort_order").order("name"),
    supabase.from("studio_settings").select("timezone").eq("studio_id", event.studio_id).maybeSingle(),
  ]);
  const loadError = versionResult.error || floorResult.error || contestResult.error || settingsResult.error;
  if (loadError) throw new Error(`Could not load competition schedule: ${loadError.message}`);

  const versions = (versionResult.data ?? []) as Version[];
  const floors = (floorResult.data ?? []) as Floor[];
  const contests = (contestResult.data ?? []) as Contest[];
  const selectedVersion = versions.find((item) => item.id === query.version) ?? versions.find((item) => item.status === "draft") ?? versions[0] ?? null;
  const timeZone = settingsResult.data?.timezone || "America/New_York";

  let sessions: Session[] = [];
  let blocks: Block[] = [];
  let assignments: Assignment[] = [];
  let heats: Heat[] = [];
  let heatDances: HeatDance[] = [];
  let heatEntries: HeatEntry[] = [];
  if (selectedVersion) {
    const [sessionResult, blockResult, assignmentResult, heatResult, heatDanceResult, heatEntryResult] = await Promise.all([
      (supabase as any).from("event_competition_schedule_sessions").select("id, name, session_date, starts_at, ends_at").eq("schedule_version_id", selectedVersion.id).order("starts_at"),
      (supabase as any).from("event_competition_schedule_blocks").select("id, session_id, floor_id, floor_name_snapshot, floor_capacity_snapshot, name, block_type, starts_at, ends_at").eq("schedule_version_id", selectedVersion.id).order("starts_at"),
      (supabase as any).from("event_competition_schedule_block_contests").select("id, block_id, contest_id, planned_round_type").eq("schedule_version_id", selectedVersion.id).order("sort_order"),
      (supabase as any).from("event_competition_heats").select("id, schedule_block_id, name, scheduled_at, estimated_ends_at, status, configuration").eq("schedule_version_id", selectedVersion.id).neq("status", "cancelled").order("schedule_sequence"),
      (supabase as any).from("event_competition_heat_dances").select("heat_id, dance_label, sequence_number").eq("event_id", id).neq("status", "cancelled").order("sequence_number"),
      (supabase as any).from("event_competition_heat_entries").select("heat_id").eq("event_id", id).neq("status", "scratched"),
    ]);
    const scheduleError = sessionResult.error || blockResult.error || assignmentResult.error || heatResult.error || heatDanceResult.error || heatEntryResult.error;
    if (scheduleError) throw new Error(`Could not load schedule details: ${scheduleError.message}`);
    sessions = (sessionResult.data ?? []) as Session[];
    blocks = (blockResult.data ?? []) as Block[];
    assignments = (assignmentResult.data ?? []) as Assignment[];
    heats = (heatResult.data ?? []) as Heat[];
    const selectedHeatIds = new Set(heats.map((heat) => heat.id));
    heatDances = ((heatDanceResult.data ?? []) as HeatDance[]).filter((item) => selectedHeatIds.has(item.heat_id));
    heatEntries = ((heatEntryResult.data ?? []) as HeatEntry[]).filter((item) => selectedHeatIds.has(item.heat_id));
  }

  const editable = selectedVersion?.status === "draft";
  const unassignedCompetitionBlocks = blocks.filter((block) => block.block_type === "competition" && !assignments.some((assignment) => assignment.block_id === block.id));

  return (
    <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 pb-5">
        <div><Link href={`/app/events/${id}/competition`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to competition setup</Link><h1 className="mt-2 text-2xl font-semibold text-slate-950">Schedule of Events</h1><p className="mt-1 text-sm text-slate-600">{event.name} · {timeZone}</p></div>
        <div className="flex flex-wrap items-center gap-2">{selectedVersion ? <span className="rounded border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700">{selectedVersion.name} · {label(selectedVersion.status)}</span> : null}<Link href={`/app/events/${id}/competition/readiness${selectedVersion ? `?version=${selectedVersion.id}` : ""}`} className="rounded bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800">Schedule Readiness</Link></div>
      </header>

      <section className="grid gap-6 border-b border-slate-200 py-6 lg:grid-cols-2">
        <div><h2 className="text-lg font-semibold text-slate-950">Schedule versions</h2><p className="mt-1 text-sm text-slate-600">Create a new draft to revise a published schedule. Existing published versions remain unchanged.</p><div className="mt-3 flex flex-wrap gap-2">{versions.map((version) => <Link key={version.id} href={`?version=${version.id}`} className={`rounded border px-3 py-2 text-sm ${selectedVersion?.id === version.id ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 text-slate-700"}`}>v{version.version_number} · {version.name}</Link>)}</div></div>
        <form action={createScheduleVersionAction} className="grid gap-2 bg-slate-50 p-4 sm:grid-cols-2"><input type="hidden" name="eventId" value={id} /><input name="name" placeholder="Schedule name" className={inputClass} /><select name="sourceVersionId" className={inputClass} defaultValue={selectedVersion?.id ?? ""}><option value="">Start empty</option>{versions.map((version) => <option key={version.id} value={version.id}>Copy v{version.version_number}: {version.name}</option>)}</select><button className={`${buttonClass} sm:col-span-2`}>Create draft version</button></form>
      </section>

      <section className="grid gap-6 border-b border-slate-200 py-6 lg:grid-cols-2">
        <div><h2 className="text-lg font-semibold text-slate-950">Ballrooms and floors</h2><div className="mt-3 flex flex-wrap gap-2">{floors.map((floor) => <span key={floor.id} className="rounded border border-slate-200 px-3 py-2 text-sm text-slate-700">{floor.name} · capacity {floor.capacity}{floor.location_label ? ` · ${floor.location_label}` : ""}</span>)}</div></div>
        <form action={createScheduleFloorAction} className="grid gap-2 bg-slate-50 p-4 sm:grid-cols-2"><input type="hidden" name="eventId" value={id} /><input name="name" required placeholder="Floor name" className={inputClass} /><input name="locationLabel" placeholder="Ballroom or location" className={inputClass} /><input name="capacity" type="number" min="1" defaultValue="1" className={inputClass} /><button className={buttonClass}>Add floor</button></form>
      </section>

      {!selectedVersion ? <div className="mt-8 rounded border border-dashed border-slate-300 px-5 py-12 text-center text-sm text-slate-600">Create the first schedule draft to add sessions and blocks.</div> : (
        <>
          {editable ? <section className="border-b border-slate-200 py-6"><h2 className="text-lg font-semibold text-slate-950">Add session</h2><form action={createScheduleSessionAction} className="mt-3 grid gap-2 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-5"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="versionId" value={selectedVersion.id} /><input name="name" required placeholder="Session name" className={inputClass} /><input name="date" type="date" required className={inputClass} /><input name="startTime" type="time" required className={inputClass} /><input name="endTime" type="time" required className={inputClass} /><button className={buttonClass}>Add session</button></form></section> : null}

          <div className="mt-7 space-y-8">
            {sessions.map((session) => {
              const sessionBlocks = blocks.filter((block) => block.session_id === session.id);
              return <section key={session.id} className="border-b border-slate-300 pb-7"><div className="flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-xl font-semibold text-slate-950">{session.name}</h2><p className="mt-1 text-sm text-slate-600">{session.session_date} · {time(session.starts_at, timeZone)} to {time(session.ends_at, timeZone)}</p></div><span className="text-xs font-semibold text-slate-500">{sessionBlocks.length} blocks</span></div>
                {editable ? <form action={createScheduleBlockAction} className="mt-4 grid gap-2 bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-7"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="versionId" value={selectedVersion.id} /><input type="hidden" name="sessionId" value={session.id} /><input type="hidden" name="date" value={session.session_date} /><input name="name" required placeholder="Block name" className={inputClass} /><select name="blockType" className={inputClass} defaultValue="competition"><option value="competition">Competition</option><option value="awards">Awards</option><option value="break">Break</option><option value="meal">Meal</option><option value="showcase">Showcase</option><option value="workshop">Workshop</option><option value="practice">Practice</option><option value="registration">Registration</option><option value="other">Other</option></select><select name="floorId" className={inputClass} defaultValue=""><option value="">No floor</option>{floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}</select><input name="startTime" type="time" required className={inputClass} /><input name="endTime" type="time" required className={inputClass} /><button className={`${buttonClass} xl:col-span-2`}>Add block</button></form> : null}
                <div className="mt-4 divide-y divide-slate-200 border-y border-slate-200">{sessionBlocks.map((block) => {
                  const floor = floors.find((item) => item.id === block.floor_id);
                  const floorLabel = block.floor_name_snapshot ?? floor?.name ?? null;
                  const blockAssignments = assignments.filter((item) => item.block_id === block.id);
                  const blockHeats = heats.filter((heat) => heat.schedule_block_id === block.id);
                  return <div key={block.id} className="grid gap-4 py-4 lg:grid-cols-[240px_1fr]"><div><p className="font-semibold text-slate-950">{time(block.starts_at, timeZone)}–{time(block.ends_at, timeZone)} · {block.name}</p><p className="mt-1 text-xs text-slate-500">{label(block.block_type)}{floorLabel ? ` · ${floorLabel}` : ""}{block.floor_capacity_snapshot ? ` · capacity ${block.floor_capacity_snapshot}` : ""}</p></div><div><div className="flex flex-wrap gap-2">{blockAssignments.map((assignment) => { const contest = contests.find((item) => item.id === assignment.contest_id); return <span key={assignment.id} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">{contest?.name ?? "Competition event"} · {label(assignment.planned_round_type ?? "all")}</span>; })}</div>{editable && block.block_type === "competition" && blockHeats.length === 0 ? <form action={assignContestToBlockAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_160px_auto]"><input type="hidden" name="eventId" value={id} /><input type="hidden" name="versionId" value={selectedVersion.id} /><input type="hidden" name="blockId" value={block.id} /><select name="contestId" required className={inputClass} defaultValue=""><option value="" disabled>Select competition event</option>{contests.map((contest) => <option key={contest.id} value={contest.id}>{contest.program?.name ? `${contest.program.name}: ` : ""}{contest.name}</option>)}</select><select name="plannedRoundType" className={inputClass} defaultValue="all"><option value="all">All rounds</option><option value="preliminary">Preliminary</option><option value="quarterfinal">Quarterfinal</option><option value="semifinal">Semifinal</option><option value="final">Final</option><option value="proficiency">Proficiency</option><option value="feedback">Feedback</option><option value="exhibition">Exhibition</option><option value="custom">Custom</option></select><button className={buttonClass}>Assign</button></form> : null}{blockHeats.length > 0 ? <div className="mt-3 divide-y divide-slate-200 border-y border-slate-200">{blockHeats.map((heat) => { const dances = heatDances.filter((item) => item.heat_id === heat.id).sort((a, b) => a.sequence_number - b.sequence_number); const actualEntries = heatEntries.filter((item) => item.heat_id === heat.id).length; const expectedEntries = heat.configuration?.expected_entry_count ?? actualEntries; return <div key={heat.id} className="grid gap-2 py-3 sm:grid-cols-[100px_1fr_auto]"><p className="text-sm font-semibold text-slate-950">{time(heat.scheduled_at, timeZone)}</p><div><p className="text-sm font-semibold text-slate-900">{heat.name ?? "Competition heat"}</p><p className="mt-1 text-xs text-slate-600">{dances.map((dance) => dance.dance_label).join(", ") || "Dance pending"}</p></div><p className="text-xs text-slate-500 sm:text-right">{actualEntries > 0 ? `${actualEntries} entries` : `${expectedEntries} callback positions`}<br />{label(heat.status)}</p></div>; })}</div> : null}</div></div>;
                })}</div></section>;
            })}
          </div>

          {editable ? <section className="mt-8 border-t border-slate-200 pt-6"><div className="flex flex-wrap items-center justify-between gap-4"><div><h2 className="text-lg font-semibold text-slate-950">Publish tentative schedule</h2><p className="mt-1 text-sm text-slate-600">Publishing locks this version. Future changes begin in a copied draft.</p>{unassignedCompetitionBlocks.length > 0 ? <p className="mt-2 text-sm font-medium text-amber-700">{unassignedCompetitionBlocks.length} competition blocks still need an assigned competition event.</p> : null}</div><form action={publishScheduleVersionAction}><input type="hidden" name="eventId" value={id} /><input type="hidden" name="versionId" value={selectedVersion.id} /><button className={buttonClass}>Publish schedule</button></form></div></section> : null}
        </>
      )}
    </main>
  );
}
