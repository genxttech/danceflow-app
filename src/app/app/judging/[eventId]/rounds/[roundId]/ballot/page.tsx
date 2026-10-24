import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { JudgeSheet } from "@/lib/competition/ballots/status";
import BallotMarksFields from "@/app/app/events/[id]/competition/ballots/BallotMarksFields";
import { submitJudgeBallotAction } from "@/app/app/events/[id]/competition/ballots/actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const buttonClass = "h-12 w-full rounded bg-slate-950 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-50";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Judge ballot (E2). Mobile-first: one card per heat, one large control per entry. The judge is derived from the session
 * on the server; nothing on this page can name another judge. The sheet shows only the caller's own current ballot.
 */
export default async function JudgeBallotPage({
  params,
  searchParams,
}: {
  params: Promise<{ eventId: string; roundId: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const { eventId, roundId } = await params;
  const query = await searchParams;
  if (!UUID.test(eventId) || !UUID.test(roundId)) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data, error } = await supabase.rpc("competition_judge_ballot_sheet", { p_round_id: roundId });
  if (error || !data) notFound();
  const sheet = data as JudgeSheet;
  const returnTo = `/app/judging/${eventId}/rounds/${roundId}/ballot`;
  const open = sheet.round.status === "active" && sheet.scheme_available && !sheet.absent;
  const rating = sheet.round.scoring_method === "proficiency_rating";

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-5">
      <Link href="/app/judging" className="text-sm font-medium text-slate-600 hover:text-slate-950">
        &larr; Judging
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-950">{sheet.round.name}</h1>
      <p className="text-sm text-slate-600">
        Judge {sheet.judge_letter} - {rating ? "Rate each entry Gold, Silver or Bronze." : "Rank every entry. 1 is your best. Use each number once."}
      </p>

      {query.saved ? <p role="status" className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{query.saved}</p> : null}
      {query.error ? <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{query.error}</p> : null}
      {!sheet.scheme_available ? (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Ballots for this kind of round are not available yet.</p>
      ) : sheet.absent ? (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">You are recorded absent for this round. Ask the chair or a manager if that is wrong.</p>
      ) : sheet.round.status === "ballots_locked" ? (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">Ballots are locked. You can no longer submit or correct.</p>
      ) : sheet.round.status !== "active" ? (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">This round is {label(sheet.round.status)}. Ballots open when it starts.</p>
      ) : null}

      <div className="mt-4 space-y-5">
        {sheet.heats.length === 0 ? <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">No heats are ready to judge yet.</p> : null}
        {sheet.heats.map((heat) => {
          const current = heat.ballot;
          return (
            <section key={heat.heat_id} aria-label={`Heat ${heat.heat_number}`} className="rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-slate-950">Heat {heat.heat_number}</h2>
                {current ? (
                  <span className="rounded bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-900">
                    Submitted v{current.version}
                    {current.source === "scorer_paper" ? " (paper)" : ""}
                  </span>
                ) : (
                  <span className="rounded bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-900">Not submitted</span>
                )}
              </div>
              {open ? (
                <form action={submitJudgeBallotAction} className="space-y-3">
                  <input type="hidden" name="roundId" value={roundId} />
                  <input type="hidden" name="heatId" value={heat.heat_id} />
                  <input type="hidden" name="requestId" value={randomUUID()} />
                  <input type="hidden" name="scoringMethod" value={sheet.round.scoring_method} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <BallotMarksFields scoringMethod={sheet.round.scoring_method} entries={heat.entries} current={current?.marks} />
                  {current ? (
                    <label className="block text-sm font-medium text-slate-900">
                      Why are you correcting this ballot?
                      <input name="reason" required maxLength={500} className="mt-1 block h-12 w-full rounded border border-slate-300 bg-white px-3 text-base" />
                    </label>
                  ) : null}
                  <button className={buttonClass}>{current ? "Submit correction" : "Submit ballot"}</button>
                </form>
              ) : (
                <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white text-sm">
                  {heat.entries.map((entry) => (
                    <li key={entry.entry_id} className="flex items-center justify-between gap-3 px-3 py-2">
                      <span>
                        <span className="mr-2 text-xs font-bold text-slate-700">{entry.entry_number ?? "-"}</span>
                        {entry.display_name}
                      </span>
                      <span className="font-semibold">{current ? String(current.marks[entry.entry_id] ?? "-") : "-"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
