import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OFFICIAL_ROLE_LABELS, type OfficialRole } from "@/lib/competition/officials/contract";
import { groupJudgingAssignments, type JudgingAssignmentRow } from "@/lib/competition/officials/judging";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Judge-facing shell (E1, read-only). Shows only the signed-in official's own events and rounds through
 * my_competition_judging_assignments(); it exposes no other official, no entries and no results. Ballot pages are
 * added by E2 under /app/judging/[eventId]/rounds/[roundId]/ballot.
 */
export default async function JudgingHomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("my_competition_judging_assignments");
  if (error) throw new Error(`Could not load your assignments: ${error.message}`);
  const events = groupJudgingAssignments((data ?? []) as JudgingAssignmentRow[]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <h1 className="text-xl font-semibold text-slate-950">Judging</h1>
      <p className="mt-1 text-sm text-slate-600">Competitions you are an official for, and the rounds you are assigned to.</p>

      {events.length === 0 ? (
        <p className="mt-6 rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">
          You have no judging assignments. A competition manager adds officials and assigns panels.
        </p>
      ) : (
        <div className="mt-6 space-y-5">
          {events.map((event) => (
            <section key={event.eventId} aria-label={event.eventName} className="rounded border border-slate-200 bg-white p-4">
              <h2 className="text-base font-semibold text-slate-950">{event.eventName}</h2>
              <p className="text-xs text-slate-600">
                {event.eventStartDate ? `${event.eventStartDate} - ` : ""}
                {OFFICIAL_ROLE_LABELS[event.officialRole as OfficialRole] ?? label(event.officialRole)}
              </p>
              {event.rounds.length === 0 ? (
                <p className="mt-3 text-sm text-slate-600">No rounds assigned yet.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-100">
                  {event.rounds.map((round) => (
                    <li key={round.roundId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                      <span>
                        <span className="mr-2 inline-block min-w-6 rounded bg-slate-100 px-1.5 py-0.5 text-center text-xs font-bold text-slate-800">{round.judgeLetter ?? "-"}</span>
                        {round.divisionName ? `${round.divisionName} - ` : ""}
                        {round.roundName}
                      </span>
                      <span className="text-xs text-slate-600">{label(round.roundStatus)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
