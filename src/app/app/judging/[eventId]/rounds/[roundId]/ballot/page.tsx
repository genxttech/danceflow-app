import { randomUUID } from "crypto";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { JudgeSheet } from "@/lib/competition/ballots/status";
import { CORRECTION_BANNER, ballotsAccepting, inCorrectionWindow } from "@/lib/competition/ballots/window";
import { activeNoShows, ballotNeedsCorrection, type NoShowRow } from "@/lib/competition/noShow";
import BallotMarksFields from "@/app/app/events/[id]/competition/ballots/BallotMarksFields";
import { saveCallbackDraftAction, submitJudgeBallotAction } from "@/app/app/events/[id]/competition/ballots/actions";

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
  // NS1: entries an official marked as no-show are already out of this sheet; say so, and flag a ballot they made out of date.
  const { data: noShowData } = await supabase.rpc("competition_round_no_shows", { p_round_id: roundId });
  const noShows = Array.from(activeNoShows(noShowData as NoShowRow[] | null).values());
  const returnTo = `/app/judging/${eventId}/rounds/${roundId}/ballot`;
  const open = ballotsAccepting(sheet.round) && sheet.scheme_available && !sheet.absent;
  const correcting = inCorrectionWindow(sheet.round);
  const rating = sheet.round.scoring_method === "proficiency_rating";
  const callback = sheet.callback;
  const picked = new Set<string>(callback?.ballot ? Object.keys(callback.ballot.marks) : (callback?.draft ?? []));

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-5">
      <Link href="/app/judging" className="text-sm font-medium text-slate-600 hover:text-slate-950">
        &larr; Judging
      </Link>
      <h1 className="mt-2 text-xl font-semibold text-slate-950">{sheet.round.name}</h1>
      <p className="text-sm text-slate-600">
        Judge {sheet.judge_letter} - {callback
          ? `Select exactly ${callback.target ?? "?"} couples to call back, across all heats.`
          : rating
            ? "Rate each entry Gold, Silver or Bronze."
            : "Rank every entry. 1 is your best. Use each number once."}
      </p>

      {query.saved ? <p role="status" className="mt-3 rounded border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">{query.saved}</p> : null}
      {query.error ? <p role="alert" className="mt-3 rounded border border-rose-300 bg-rose-50 p-3 text-sm text-rose-950">{query.error}</p> : null}
      {!sheet.scheme_available ? (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">Ballots for this kind of round are not available yet.</p>
      ) : sheet.absent ? (
        <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">You are recorded absent for this round. Ask the chair or a manager if that is wrong.</p>
      ) : correcting ? (
        <p role="status" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{CORRECTION_BANNER}</p>
      ) : sheet.round.status === "ballots_locked" ? (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">Ballots are locked. You can no longer submit or correct.</p>
      ) : sheet.round.status !== "active" ? (
        <p className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">This round is {label(sheet.round.status)}. Ballots open when it starts.</p>
      ) : null}

      {noShows.length > 0 ? (
        <p role="status" className="mt-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">
          {noShows.length === 1 ? "An entry was" : `${noShows.length} entries were`} marked as no-show by an official and {noShows.length === 1 ? "is" : "are"} not on your sheet: {noShows.map((row) => `${row.entry_number ? `#${row.entry_number} ` : ""}${row.display_name} (heat ${row.heat_number})`).join(", ")}. {callback ? "Choose only among the entries shown." : "Rank only the entries shown. An entry that is a no-show in one heat still appears in its other heats."}
        </p>
      ) : null}

      {callback?.ballot && open && Array.from(picked).some((id) => !sheet.heats.some((heat) => heat.entries.some((entry) => entry.entry_id === id))) ? (
        <p role="alert" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          One of the couples you called back was marked no-show after you submitted. Pick your couples again and submit a correction.
        </p>
      ) : null}

      {callback ? (
        <form className="mt-4 space-y-4">
          <input type="hidden" name="roundId" value={roundId} />
          <input type="hidden" name="callback" value="1" />
          <input type="hidden" name="scoringMethod" value={sheet.round.scoring_method} />
          <input type="hidden" name="returnTo" value={returnTo} />
          <input type="hidden" name="requestId" value={randomUUID()} />
          <p className="text-sm text-slate-700">
            {callback.target === null
              ? "The organizer has not set how many couples to call back yet."
              : callback.target >= callback.eligible
                ? "Everyone advances, so no ballot is needed."
                : `${callback.eligible} couples are eligible. You can save your picks and finish later; the final ballot needs exactly ${callback.target}.`}
            {callback.ballot ? ` Submitted as version ${callback.ballot.version}.` : ""}
          </p>
          {sheet.heats.map((heat) => (
            <section key={heat.heat_id} aria-label={`Heat ${heat.heat_number}`} className="rounded border border-slate-200 bg-slate-50 p-3">
              <h2 className="mb-2 text-base font-semibold text-slate-950">Heat {heat.heat_number}</h2>
              <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
                {heat.entries.map((entry) => (
                  <li key={entry.entry_id}>
                    <label className="flex min-h-12 items-center gap-3 px-3 py-2 text-sm">
                      <input type="checkbox" name="pick" value={entry.entry_id} defaultChecked={picked.has(entry.entry_id)} disabled={!open} className="h-6 w-6" />
                      <span className="mr-1 text-xs font-bold text-slate-700">{entry.entry_number ?? "-"}</span>
                      <span className="break-words">{entry.display_name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {open && callback.target !== null && callback.target < callback.eligible ? (
            <div className="space-y-3">
              {callback.ballot ? (
                <label className="block text-sm font-medium text-slate-900">
                  Why are you correcting this ballot?
                  <input name="reason" maxLength={500} className="mt-1 block h-12 w-full rounded border border-slate-300 bg-white px-3 text-base" />
                </label>
              ) : correcting ? null : (
                // A callback draft can be saved only while the round is active (the database refuses it in a correction).
                <button formAction={saveCallbackDraftAction} className="h-12 w-full rounded border border-slate-300 bg-white px-4 text-base font-semibold text-slate-900">
                  Save selections (not submitted)
                </button>
              )}
              <button formAction={submitJudgeBallotAction} className={buttonClass}>
                {callback.ballot ? "Submit correction" : "Submit final ballot"}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}

      <div className="mt-4 space-y-5">
        {callback ? null : sheet.heats.length === 0 ? <p className="rounded border border-slate-200 bg-white p-4 text-sm text-slate-700">No heats are ready to judge yet.</p> : null}
        {callback ? null : sheet.heats.map((heat) => {
          const current = heat.ballot;
          const needsCorrection = Boolean(current) && open && ballotNeedsCorrection(heat.entries.map((entry) => entry.entry_id), Object.keys(current?.marks ?? {}));
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
              {needsCorrection ? (
                <p role="alert" className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">
                  The entries in this heat changed after you submitted (a no-show was recorded or undone). Rank the entries below again and submit a correction.
                </p>
              ) : null}
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
