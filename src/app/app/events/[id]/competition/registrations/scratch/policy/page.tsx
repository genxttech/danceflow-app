import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { parseResolution, resolutionLabel, scratchErrorMessage } from "@/lib/competition/scratch/scratch";
import { createClient } from "@/lib/supabase/server";
import { setCompetitionScratchPolicyAction, setCompetitionScratchPolicyDefaultAction } from "../actions";

type Program = { id: string; name: string };
type Override = { program_id: string; default_resolution: string };

export default async function ScratchPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const context = await getCurrentStudioContext();
  const { data: event } = await supabase.from("events").select("id, name, organizer_id").eq("id", id).eq("studio_id", context.studioId).maybeSingle();
  if (!event) notFound();

  const defaultQuery = supabase.from("competition_scratch_policy_defaults").select("default_resolution");
  const [programResult, overrideResult, officialResult, defaultResult] = await Promise.all([
    supabase.from("event_competition_programs").select("id, name").eq("event_id", id).order("created_at"),
    supabase.from("event_competition_scratch_policies").select("program_id, default_resolution").eq("event_id", id),
    supabase.rpc("_sc1_actor_owns_policy", { p_event_id: id }),
    (event.organizer_id ? defaultQuery.eq("organizer_id", event.organizer_id) : defaultQuery.eq("studio_id", context.studioId)).maybeSingle(),
  ]);
  const standard = parseResolution(defaultResult.data?.default_resolution) ?? "no_refund";
  const programs = (programResult.data ?? []) as Program[];
  const overrides = new Map(((overrideResult.data ?? []) as Override[]).map((o) => [o.program_id, o.default_resolution]));
  const isOfficial = officialResult.data === true;
  const effective = await Promise.all(
    programs.map(async (p) => {
      const { data } = await supabase.rpc("competition_scratch_effective_policy", { p_program_id: p.id });
      return parseResolution(data) ?? "no_refund";
    }),
  );
  const issuer = event.organizer_id ? "organizer" : "studio";

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href={`/app/events/${id}/competition/registrations`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to Competition Registrations</Link>
      <h1 className="mt-2 text-2xl font-semibold text-slate-950">Scratch policy</h1>
      <p className="mt-1 text-sm text-slate-600">{event.name}</p>
      <p className="mt-4 text-sm text-slate-700">
        The policy is the financial resolution a scratch uses by default. Scratching never refunds automatically. Owners and admins can record a
        different resolution for a single scratch, with a reason. Competition credit is not available yet.
      </p>

      {query.error ? <p role="alert" className="mt-5 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{query.error === "COMP_SC1_NOT_FOUND" ? "Only the event's organizer owners and admins (or the studio's, for a studio-run event) can change the scratch policy." : scratchErrorMessage(query.error)}</p> : null}
      {query.saved ? <p className="mt-5 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Saved.</p> : null}

      <section className="mt-6 border-t border-slate-200 pt-5">
        <h2 className="text-lg font-semibold text-slate-950">Standard policy</h2>
        <p className="mt-1 text-sm text-slate-600">Applies to every competition of this {issuer} unless a competition sets its own.</p>
        <form action={setCompetitionScratchPolicyDefaultAction} className="mt-3 flex flex-wrap gap-2">
          <input type="hidden" name="eventId" value={id} />
          <select name="resolution" defaultValue={standard} disabled={!isOfficial} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm">
            <option value="no_refund">No refund</option>
            <option value="refund">Refund</option>
          </select>
          <input name="reason" maxLength={300} placeholder="Reason for the change (optional)" disabled={!isOfficial} className="h-10 min-w-56 flex-1 rounded border border-slate-300 px-3 text-sm" />
          <button disabled={!isOfficial} className="rounded border border-slate-300 px-3 text-sm font-semibold text-slate-700 disabled:text-slate-400">Save standard policy</button>
        </form>
      </section>

      <section className="mt-8 border-t border-slate-200 pt-5">
        <h2 className="text-lg font-semibold text-slate-950">This event</h2>
        {programs.length === 0 ? <p className="mt-2 text-sm text-slate-600">No competition program yet.</p> : null}
        <ul className="mt-3 divide-y divide-slate-200">
          {programs.map((p, index) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div>
                <p className="font-semibold text-slate-900">{p.name}</p>
                <p className="text-xs text-slate-600">In effect: {resolutionLabel(effective[index])}{overrides.has(p.id) ? " (set for this competition)" : " (standard policy)"}</p>
              </div>
              <form action={setCompetitionScratchPolicyAction} className="flex gap-2">
                <input type="hidden" name="eventId" value={id} />
                <input type="hidden" name="programId" value={p.id} />
                <select name="resolution" defaultValue={overrides.get(p.id) ?? "inherit"} disabled={!isOfficial} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm">
                  <option value="inherit">Use standard policy</option>
                  <option value="no_refund">No refund</option>
                  <option value="refund">Refund</option>
                </select>
                <input name="reason" maxLength={300} placeholder="Reason (optional)" disabled={!isOfficial} className="h-10 w-44 rounded border border-slate-300 px-3 text-sm" />
                <button disabled={!isOfficial} className="rounded border border-slate-300 px-3 text-sm font-semibold text-slate-700 disabled:text-slate-400">Save</button>
              </form>
            </li>
          ))}
        </ul>
        {!isOfficial ? <p className="mt-3 text-xs text-slate-600">Only the event&apos;s organizer owners and admins (or the studio&apos;s, for a studio-run event) can change the scratch policy. Every change is recorded.</p> : null}
      </section>
    </main>
  );
}
