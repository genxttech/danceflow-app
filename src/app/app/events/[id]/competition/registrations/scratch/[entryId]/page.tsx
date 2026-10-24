import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  classifyPlacements,
  entryStatusLabel,
  isScratchable,
  parseResolution,
  resolutionLabel,
  scratchDecision,
  SCRATCH_RESOLUTIONS,
} from "@/lib/competition/scratch/scratch";
import { createClient } from "@/lib/supabase/server";
import { scratchCompetitionEntryAction } from "../actions";

type Placement = { heat_id: string; status: string; heat: { name: string | null; heat_number: number; lock_state: string } | null };
type ScratchRow = { id: string; path: string; requested_resolution: string; policy_resolution: string; is_exception: boolean; reason: string | null; performed_at: string };

const LOCK_LABEL: Record<string, string> = { open: "Open", locked: "Locked", certified: "Certified" };

export default async function ScratchEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; entryId: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id, entryId } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event } = await supabase.from("events").select("id, name").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (!event) notFound();

  const { data: entry } = await supabase
    .from("event_competition_entries")
    .select("id, program_id, display_name, entry_number, status")
    .eq("id", entryId)
    .eq("event_id", id)
    .maybeSingle();
  if (!entry) notFound();

  const [placementResult, scratchResult, policyResult, officialResult] = await Promise.all([
    supabase.from("event_competition_heat_entries").select("heat_id, status, heat:event_competition_heats(name, heat_number, lock_state)").eq("entry_id", entryId).eq("event_id", id),
    supabase.from("event_competition_scratches").select("id, path, requested_resolution, policy_resolution, is_exception, reason, performed_at").eq("entry_id", entryId).order("performed_at", { ascending: false }),
    supabase.rpc("competition_scratch_effective_policy", { p_program_id: entry.program_id }),
    supabase.rpc("_paywh1_actor_can_manage_event", { p_event_id: id }),
  ]);
  const placements = (placementResult.data ?? []) as unknown as Placement[];
  const scratches = (scratchResult.data ?? []) as ScratchRow[];
  const policy = parseResolution(policyResult.data) ?? "no_refund";
  const isOfficial = officialResult.data === true;
  const placementClass = classifyPlacements(placements.map((p) => ({ heatLockState: p.heat?.lock_state ?? "open", placementStatus: p.status })));
  const baseDecision = scratchDecision({ placementClass, policy, resolution: policy, isOfficial });
  const scratchable = isScratchable(entry.status);
  const requestId = randomUUID();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href={`/app/events/${id}/competition/registrations`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Competition Registrations</Link>
      <h1 className="mt-2 text-2xl font-semibold text-slate-950">Scratch entry</h1>
      <p className="mt-1 text-sm text-slate-600">{event.name}</p>

      <section className="mt-6 border-y border-slate-200 py-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-slate-950">{entry.display_name}</h2>
          {entry.entry_number ? <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">#{entry.entry_number}</span> : null}
          <span className="rounded bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">{entryStatusLabel(entry.status)}</span>
        </div>
        <h3 className="mt-4 text-sm font-semibold text-slate-900">Heats</h3>
        {placements.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Not placed in any heat yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {placements.map((p) => (
              <li key={p.heat_id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-slate-800">{p.heat?.name ?? `Heat ${p.heat?.heat_number ?? ""}`}</span>
                <span className="text-slate-600">{LOCK_LABEL[p.heat?.lock_state ?? "open"] ?? p.heat?.lock_state} · {entryStatusLabel(p.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {query.error ? <p role="alert" className="mt-5 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{query.error}</p> : null}

      {!scratchable ? (
        <p className="mt-5 text-sm text-slate-700">This entry is {entryStatusLabel(entry.status).toLowerCase()} and cannot be scratched.</p>
      ) : !baseDecision.allowed && (placementClass === "certified" || placementClass === "danced" || (placementClass === "locked" && !isOfficial)) ? (
        <p className="mt-5 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{baseDecision.reason}</p>
      ) : (
        <form action={scratchCompetitionEntryAction} className="mt-6 space-y-5">
          <input type="hidden" name="eventId" value={id} />
          <input type="hidden" name="entryId" value={entry.id} />
          <input type="hidden" name="requestId" value={requestId} />
          {placementClass === "locked" ? (
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This entry is in a locked heat. As an official you can scratch it without reopening the heat. A reason is required and the scratch is recorded permanently.
            </p>
          ) : null}
          <fieldset>
            <legend className="text-sm font-semibold text-slate-900">Financial resolution</legend>
            <p className="mt-1 text-xs text-slate-600">
              Scratch policy: {resolutionLabel(policy)}. Scratching never refunds automatically.
              {isOfficial ? " Choosing a different resolution is recorded as an exception and needs a reason." : " Only an owner or admin can choose a different resolution."}
            </p>
            <div className="mt-3 space-y-2">
              {SCRATCH_RESOLUTIONS.map((r) => {
                const disabled = !r.available || (!isOfficial && r.key !== policy);
                return (
                  <label key={r.key} className={`flex gap-3 rounded border px-3 py-2 text-sm ${disabled ? "border-slate-100 text-slate-400" : "border-slate-200 text-slate-800"}`}>
                    <input type="radio" name="resolution" value={r.key} defaultChecked={r.key === policy} disabled={disabled} className="mt-1" />
                    <span>
                      <span className="font-semibold">{r.label}{r.key === policy ? " (policy)" : ""}</span>
                      <span className="block text-xs text-slate-600">{r.description}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
          <label className="block text-sm">
            <span className="font-semibold text-slate-900">Reason</span>
            <span className="block text-xs text-slate-600">
              {placementClass === "locked" ? "Required." : "Required for an exception; optional otherwise."}
            </span>
            <textarea name="reason" rows={3} required={placementClass === "locked"} maxLength={500} className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <button className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white">Scratch entry</button>
        </form>
      )}

      {scratches.length > 0 ? (
        <section className="mt-8">
          <h3 className="text-sm font-semibold text-slate-900">Scratch history</h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {scratches.map((s) => (
              <li key={s.id} className="py-2 text-slate-700">
                {new Date(s.performed_at).toLocaleString("en-US")} · {resolutionLabel(s.requested_resolution)}
                {s.is_exception ? ` (exception; policy ${resolutionLabel(s.policy_resolution)})` : ""}
                {s.path === "official_locked" ? " · locked heat" : ""}
                {s.reason ? ` · ${s.reason}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
