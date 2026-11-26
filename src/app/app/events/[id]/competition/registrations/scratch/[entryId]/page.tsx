import Link from "next/link";
import { notFound } from "next/navigation";
import RosterSubmitButton from "@/components/schedule/RosterSubmitButton";
import { requireCompetitionWorkspace } from "@/lib/competition/workspaceServer";
import {
  classifyPlacements,
  entryStatusLabel,
  formatChangeTime,
  hasOpenPlacement,
  heatEntryStatusLabel,
  isAlreadyScratched,
  scratchErrorMessage,
  scratchPreflight,
  SCRATCH_REASON_MAX,
} from "@/lib/competition/scratch/scratch";
import { scratchCompetitionEntryAction } from "../actions";

type Placement = { heat_id: string; status: string; heat: { name: string | null; heat_number: number; lock_state: string | null; status: string | null } | null };
type ChangeRow = { id: string; change_type: string; reason: string | null; performed_at: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCK_LABEL: Record<string, string> = { open: "Open", locked: "Locked", certified: "Certified" };

export default async function ScratchEntryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; entryId: string }>;
  searchParams: Promise<{ error?: string; done?: string; already?: string }>;
}) {
  const { id, entryId } = await params;
  const query = await searchParams;
  if (!UUID.test(id) || !UUID.test(entryId)) notFound();
  // 404 for anyone who cannot manage this competition (the database re-checks as the signed-in user).
  const { supabase, event } = await requireCompetitionWorkspace(id);

  const { data: entry } = await supabase
    .from("event_competition_entries")
    .select("id, display_name, entry_number, status")
    .eq("id", entryId)
    .eq("event_id", id)
    .maybeSingle();
  if (!entry) notFound();

  const [placementResult, changeResult] = await Promise.all([
    supabase
      .from("event_competition_heat_entries")
      .select("heat_id, status, heat:event_competition_heats(name, heat_number, lock_state, status)")
      .eq("entry_id", entryId)
      .eq("event_id", id),
    supabase
      .from("event_competition_entry_changes")
      .select("id, change_type, reason, performed_at")
      .eq("entry_id", entryId)
      .in("change_type", ["scratch", "withdraw"])
      .order("performed_at", { ascending: false }),
  ]);
  const placements = (placementResult.data ?? []) as unknown as Placement[];
  const changes = (changeResult.data ?? []) as ChangeRow[];
  const placementClass = classifyPlacements(
    placements.map((p) => ({ heatLockState: p.heat?.lock_state ?? "open", placementStatus: p.status, heatStatus: p.heat?.status })),
  );
  const decision = scratchPreflight({ entryStatus: entry.status, placementClass });
  const out = isAlreadyScratched(entry.status);
  const stranded = out && hasOpenPlacement(placements.map((p) => p.status));
  const loadFailed = Boolean(placementResult.error || changeResult.error);

  return (
    <main className="mx-auto w-full min-w-0 max-w-3xl px-4 py-8">
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
        {placementResult.error ? (
          <p className="mt-1 text-sm text-slate-600">Heats could not be loaded.</p>
        ) : placements.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Not placed in any heat yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {placements.map((p) => (
              <li key={p.heat_id} className="flex flex-wrap justify-between gap-2 py-2">
                <span className="text-slate-800">{p.heat?.name ?? `Heat ${p.heat?.heat_number ?? ""}`}</span>
                <span className="text-slate-600">{LOCK_LABEL[p.heat?.lock_state ?? "open"] ?? p.heat?.lock_state} · {heatEntryStatusLabel(p.status)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {query.done && out ? <p role="status" className="mt-5 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Entry scratched. Its open heat placements were scratched with it. No refund, credit or fee was changed.</p> : null}
      {query.already && !query.done && out ? <p role="status" className="mt-5 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{query.already === "withdrawn" ? "This entry was already withdrawn." : "This entry was already scratched."} Nothing was changed.</p> : null}
      {loadFailed ? <p role="alert" className="mt-5 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">Some details could not be loaded. Reload before scratching.</p> : null}
      {query.error ? <p role="alert" className="mt-5 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{scratchErrorMessage(query.error)}</p> : null}

      {loadFailed ? null : stranded ? (
        <p className="mt-5 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{scratchErrorMessage("COMP_SC1_STRANDED")}</p>
      ) : out ? (
        <p className="mt-5 text-sm text-slate-700">This entry is {entryStatusLabel(entry.status).toLowerCase()}. Restoring a scratched or withdrawn entry is a correction, not part of this workflow.</p>
      ) : !decision.allowed ? (
        <p className="mt-5 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">{scratchErrorMessage(decision.code)}</p>
      ) : (
        <form action={scratchCompetitionEntryAction} className="mt-6 space-y-5">
          <input type="hidden" name="eventId" value={id} />
          <input type="hidden" name="entryId" value={entry.id} />
          <p className="text-sm text-slate-700">
            A scratch takes this entry out of the competition before it dances. It is not a no-show, an organizer exclusion or a disqualification. It is left out of scoring and is never placed last; a ballot that already ranks it must be corrected.
            Scratching does not refund, credit or change any fee; refunds are a separate step on the Registrations page.
          </p>
          <label className="block text-sm">
            <span className="font-semibold text-slate-900">Reason (required)</span>
            <span className="block text-xs text-slate-600">Recorded permanently with who scratched the entry and when.</span>
            <textarea name="reason" rows={3} required maxLength={SCRATCH_REASON_MAX} className="mt-2 w-full rounded border border-slate-300 px-3 py-2 text-sm" />
          </label>
          {/* Disabled while pending: the live RPC has no idempotency guard against a double click. */}
          <RosterSubmitButton label="Scratch entry" pendingLabel="Scratching..." className="rounded bg-slate-950 px-4 py-2 text-sm font-semibold text-white" />
        </form>
      )}

      {changes.length > 0 ? (
        <section className="mt-8">
          <h3 className="text-sm font-semibold text-slate-900">Scratch history</h3>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">
            {changes.map((c) => (
              <li key={c.id} className="py-2 text-slate-700">
                {formatChangeTime(c.performed_at, event.timezone)} · {c.change_type === "scratch" ? "Scratched" : "Withdrawn"}
                {c.reason ? ` · ${c.reason}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
