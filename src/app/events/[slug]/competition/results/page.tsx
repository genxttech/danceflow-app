import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { mergeViewerRounds, parseViewerRounds, placementLabel } from "@/lib/competition/results/viewer";

/*
  CF1 F3: competition results, READ ONLY. Everything shown comes from two SECURITY DEFINER readers; this page has no write path and no flag of its own.
    - competition_my_results(event): a signed-in entrant sees the current published result of the rounds their own entry competed in.
    - competition_event_results_public(event): anyone sees a current publication that the manager chose as `public`, and only for a published public event.
  Unpublished, withdrawn, superseded and unresolved results are never returned by either reader. An excluded couple is shown by number only to everyone but itself.
  Missing owner decision: there is no program-level "public results" setting in this tree; public visibility rests on the event's own published + public
  status plus the manager's per-publication choice.
*/

export const dynamic = "force-dynamic";

type Params = Promise<{ slug: string }>;

export const metadata: Metadata = { title: "Competition results", robots: { index: false, follow: false } };

export default async function CompetitionResultsPage({ params }: { params: Params }) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: event } = await supabase.from("events").select("id, name, slug").eq("slug", slug).eq("status", "published").maybeSingle();
  if (!event) notFound();

  const { data: userData } = await supabase.auth.getUser();
  const signedIn = Boolean(userData?.user);
  const [mine, pub] = await Promise.all([
    signedIn ? supabase.rpc("competition_my_results", { p_event_id: event.id }) : Promise.resolve({ data: [] as unknown }),
    supabase.rpc("competition_event_results_public", { p_event_id: event.id }),
  ]);
  const rounds = mergeViewerRounds(parseViewerRounds(mine.data), parseViewerRounds(pub.data));
  const hasMine = rounds.some((r) => r.rows.some((x) => x.mine) || r.excluded.some((x) => x.mine));

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="border-b border-slate-200 pb-5">
        <Link href={`/events/${encodeURIComponent(slug)}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">Back to event</Link>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">Results</h1>
        <p className="mt-1 text-sm text-slate-600">{event.name}</p>
      </header>

      {rounds.length === 0 ? (
        <p role="status" className="mt-6 border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
          {signedIn
            ? "No results have been published for your entries yet. They appear here as soon as the organizer publishes them."
            : "No public results have been published yet. If you entered this competition, sign in to see your own results once they are published."}
        </p>
      ) : (
        <div className="mt-6 space-y-8">
          {hasMine ? <p className="text-sm text-slate-700">Your couple is marked in each round below.</p> : null}
          {rounds.map((round) => (
            <section key={round.publicationId} aria-labelledby={`round-${round.roundId}`}>
              <h2 id={`round-${round.roundId}`} className="text-lg font-semibold text-slate-950">{round.roundName}</h2>
              <p className="text-xs text-slate-500">
                {[round.programName, round.divisionName].filter(Boolean).join(" / ")}
                {round.visibility === "entrants" ? " (visible to entrants only)" : ""}
                {round.publicationVersion > 1 ? ` (corrected result, publication ${round.publicationVersion})` : ""}
              </p>
              <table className="mt-3 w-full border-t border-slate-200 text-sm">
                <caption className="sr-only">{round.roundName} results</caption>
                <thead>
                  <tr className="text-left text-xs text-slate-500">
                    <th scope="col" className="py-2 pr-3 font-medium">Place</th>
                    <th scope="col" className="py-2 pr-3 font-medium">Number</th>
                    <th scope="col" className="py-2 font-medium">Couple</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {round.rows.map((row) => (
                    <tr key={row.entryNumber} className={row.mine ? "bg-emerald-50 font-semibold text-emerald-950" : "text-slate-800"}>
                      <td className="py-2 pr-3">{placementLabel(row)}</td>
                      <td className="py-2 pr-3">{row.entryNumber}</td>
                      <td className="py-2">{row.displayName ?? "-"}{row.mine ? " (you)" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {round.excluded.length > 0 ? (
                <p className="mt-2 text-xs text-slate-500">
                  Not placed: {round.excluded.map((x) => (x.mine && x.displayName ? `${x.entryNumber} (${x.displayName}, you)` : x.entryNumber)).join(", ")}.
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
