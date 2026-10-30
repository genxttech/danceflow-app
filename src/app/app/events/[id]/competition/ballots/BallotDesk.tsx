import { randomUUID } from "crypto";
import { lockBlockerSummary, type BallotBoard } from "@/lib/competition/ballots/status";
import { CORRECTION_BANNER, ballotsAccepting, inCorrectionWindow } from "@/lib/competition/ballots/window";
import { canReopenHeat, lockHeatHint, lockHeatKind, type HeatFloorInfo } from "@/lib/competition/ballots/heatLock";
import BallotMarksFields from "./BallotMarksFields";
import LockHeatButton from "./LockHeatButton";
import { enterPaperBallotAction, lockBallotsAction, recordAttendanceAction, reopenBallotsAction } from "./actions";

const inputClass = "h-11 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-11 rounded bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800";
const quietButtonClass = "h-10 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50";

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Ballot status board plus lock / reopen / attendance / paper-entry controls. Shared by the manager panel and the
 * scorer/chair desk. Which controls render only mirrors what the RPCs will allow; the RPCs refuse everyone else.
 */
export default function BallotDesk({ board, returnTo, heatFloor }: { board: BallotBoard; returnTo: string; heatFloor?: Record<string, HeatFloorInfo> }) {
  const role = board.viewer_role;
  const roundId = board.round.id;
  const canLock = role === "manager" || role === "chair";
  const canAttend = role === "manager" || role === "chair";
  const canPaper = role === "manager" || role === "scorer";
  const canReopen = role === "manager";
  const active = board.round.status === "active";
  const locked = board.round.status === "ballots_locked";
  // CX1: during an open results correction the round is ballots_locked but a corrected ballot may be entered. Attendance and
  // locking stay on the plain `active` window; reopen is refused by the database while a correction is open.
  const correcting = inCorrectionWindow(board.round);
  const accepting = ballotsAccepting(board.round);
  const blockers = lockBlockerSummary(board);
  const heatNumber = new Map(board.heats.map((heat) => [heat.heat_id, heat.heat_number]));

  return (
    <div className="space-y-5">
      <section aria-label="Round status" className="rounded border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-slate-950">{board.round.name}</h2>
            <p className="text-xs text-slate-600">
              {label(board.round.scoring_method)} - round {label(board.round.status)}
            </p>
          </div>
          <span
            className={`rounded px-2 py-1 text-xs font-semibold ${
              locked ? "bg-slate-900 text-white" : active ? "bg-emerald-100 text-emerald-900" : "bg-slate-100 text-slate-800"
            }`}
          >
            {correcting ? "Correction open" : locked ? "Ballots locked" : active ? "Accepting ballots" : label(board.round.status)}
          </span>
        </div>
        {correcting ? <p role="status" className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{CORRECTION_BANNER}</p> : null}
        {!board.scheme_available ? (
          <p className="mt-3 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            Ballots for {label(board.round.scoring_method)} rounds are not available yet. The owner still has to decide how callback marks work.
          </p>
        ) : null}
      </section>

      <section aria-label="Ballot grid" className="rounded border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-950">Ballots by judge and heat</h3>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[22rem] border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <th className="py-2 pr-3">Judge</th>
                {board.heats.map((heat) => (
                  <th key={heat.heat_id} className="px-2 py-2">
                    Heat {heat.heat_number}
                    <span className="block text-[10px] font-normal normal-case text-slate-500">{label(heat.lock_state)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.judges.map((judge) => (
                <tr key={judge.official_id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-3">
                    <span className="mr-2 inline-block min-w-6 rounded bg-slate-100 px-1.5 py-0.5 text-center text-xs font-bold text-slate-800">{judge.judge_letter}</span>
                    {judge.name}
                    {judge.absent ? <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-900">Absent</span> : null}
                  </td>
                  {board.heats.map((heat) => {
                    const ballot = judge.ballots.find((candidate) => candidate.heat_id === heat.heat_id || (board.round.scoring_method === "callback_tally" && candidate.heat_id === null));
                    return (
                      <td key={heat.heat_id} className="px-2 py-2 text-xs">
                        {ballot ? (
                          <span className="font-semibold text-emerald-800">
                            v{ballot.version}
                            <span className="block font-normal text-slate-600">{ballot.source === "scorer_paper" ? "paper" : "web"}</span>
                          </span>
                        ) : judge.absent ? (
                          <span className="text-slate-500">absent</span>
                        ) : (
                          <span className="font-semibold text-rose-700">missing</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {active && canAttend ? (
        <section aria-label="Attendance" className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Judge attendance</h3>
          <p className="mt-1 text-xs text-slate-600">An absent judge is recorded here so the round can lock without their ballots. The record is kept.</p>
          <ul className="mt-3 space-y-3">
            {board.judges.map((judge) => (
              <li key={judge.official_id} className="rounded border border-slate-100 p-3">
                <form action={recordAttendanceAction} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="roundId" value={roundId} />
                  <input type="hidden" name="officialId" value={judge.official_id} />
                  <input type="hidden" name="requestId" value={randomUUID()} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <span className="min-w-24 text-sm font-medium">{judge.judge_letter}: {judge.name}</span>
                  {judge.absent ? (
                    <>
                      <input type="hidden" name="status" value="present" />
                      <button className={quietButtonClass}>Mark present</button>
                    </>
                  ) : (
                    <>
                      <input type="hidden" name="status" value="absent" />
                      <input name="reason" required maxLength={500} placeholder="Reason for absence" className={`${inputClass} flex-1`} aria-label={`Absence reason for judge ${judge.judge_letter}`} />
                      <button className={quietButtonClass} disabled={judge.ballots.length > 0} title={judge.ballots.length > 0 ? "This judge already has ballots" : undefined}>
                        Mark absent
                      </button>
                    </>
                  )}
                </form>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {accepting && canPaper && board.scheme_available ? (
        <section aria-label="Paper ballots" className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Enter a paper ballot</h3>
          <p className="mt-1 text-xs text-slate-600">
            Enter what the judge wrote, on their behalf. Your name is recorded as the person who entered it. Entering again for the same judge and heat is a correction and needs a reason.
          </p>
          <div className="mt-3 space-y-4">
            {board.round.scoring_method === "callback_tally" ? (
              <details className="rounded border border-slate-100 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                  Callback ballot (select exactly {board.callback_target ?? "?"} across the round)
                </summary>
                <form action={enterPaperBallotAction} className="mt-3 space-y-3">
                  <input type="hidden" name="roundId" value={roundId} />
                  <input type="hidden" name="callback" value="1" />
                  <input type="hidden" name="requestId" value={randomUUID()} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label className="block text-sm font-medium text-slate-900">
                    Judge
                    <select name="officialId" required defaultValue="" className={`${inputClass} mt-1 block w-full`}>
                      <option value="" disabled>
                        Choose the judge
                      </option>
                      {board.judges.filter((judge) => !judge.absent).map((judge) => (
                        <option key={judge.official_id} value={judge.official_id}>
                          {judge.judge_letter}: {judge.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
                    {(board.callback_entries ?? []).map((entry) => (
                      <li key={entry.entry_id}>
                        <label className="flex min-h-11 items-center gap-3 px-3 py-2 text-sm">
                          <input type="checkbox" name="pick" value={entry.entry_id} className="h-5 w-5" />
                          <span className="text-xs font-bold">{entry.entry_number ?? "-"}</span> {entry.display_name}
                        </label>
                      </li>
                    ))}
                  </ul>
                  <label className="block text-sm font-medium text-slate-900">
                    Correction reason <span className="font-normal text-slate-500">(only when this judge already has a ballot)</span>
                    <input name="reason" maxLength={500} className={`${inputClass} mt-1 block w-full`} />
                  </label>
                  <button className={buttonClass}>Save paper ballot</button>
                </form>
              </details>
            ) : null}
            {board.round.scoring_method === "callback_tally" ? null : board.heats.map((heat) => (
              <details key={heat.heat_id} className="rounded border border-slate-100 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">Heat {heat.heat_number}</summary>
                <form action={enterPaperBallotAction} className="mt-3 space-y-3">
                  <input type="hidden" name="roundId" value={roundId} />
                  <input type="hidden" name="heatId" value={heat.heat_id} />
                  <input type="hidden" name="requestId" value={randomUUID()} />
                  <input type="hidden" name="scoringMethod" value={board.round.scoring_method} />
                  <input type="hidden" name="returnTo" value={returnTo} />
                  <label className="block text-sm font-medium text-slate-900">
                    Judge
                    <select name="officialId" required defaultValue="" className={`${inputClass} mt-1 block w-full`}>
                      <option value="" disabled>
                        Choose the judge
                      </option>
                      {board.judges.filter((judge) => !judge.absent).map((judge) => (
                        <option key={judge.official_id} value={judge.official_id}>
                          {judge.judge_letter}: {judge.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <BallotMarksFields scoringMethod={board.round.scoring_method} entries={heat.entries} />
                  <label className="block text-sm font-medium text-slate-900">
                    Correction reason <span className="font-normal text-slate-500">(only when this judge already has a ballot for the heat)</span>
                    <input name="reason" maxLength={500} className={`${inputClass} mt-1 block w-full`} />
                  </label>
                  <button className={buttonClass}>Save paper ballot</button>
                </form>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      {heatFloor ? (
        <section aria-label="Heats" className="rounded border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-950">Heats</h3>
          <p className="mt-1 text-xs text-slate-600">
            Every heat must be locked before the ballots can be locked. A heat can be locked once it has been danced, or earlier so officials can still scratch entries; the floor then refuses changes to it until it is reopened.
          </p>
          <ul className="mt-3 divide-y divide-slate-100">
            {board.heats.map((heat) => {
              const floorStatus = heatFloor[heat.heat_id]?.status ?? null;
              const facts = { viewerRole: role, roundStatus: board.round.status, heatStatus: floorStatus, lockState: heat.lock_state, hasDancedEntry: heatFloor[heat.heat_id]?.has_danced_entry };
              const lockKind = lockHeatKind(facts);
              const reopen = canReopenHeat(facts);
              const hint = lockHeatHint(facts);
              return (
                <li key={heat.heat_id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    <span className="font-medium text-slate-950">Heat {heat.heat_number}</span>
                    <span className="ml-2 text-xs text-slate-600">
                      Floor: {floorStatus ? label(floorStatus) : "Unknown"} - {label(heat.lock_state)}
                    </span>
                  </span>
                  {lockKind ? (
                    <LockHeatButton mode="lock" kind={lockKind} roundId={roundId} heatId={heat.heat_id} heatNumber={heat.heat_number} returnTo={returnTo} />
                  ) : reopen ? (
                    <LockHeatButton mode="reopen" roundId={roundId} heatId={heat.heat_id} heatNumber={heat.heat_number} returnTo={returnTo} />
                  ) : hint ? (
                    <span className="text-xs text-slate-500">{hint}</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label="Lock and reopen" className="rounded border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-950">Lock ballots</h3>
        {active ? (
          <>
            {blockers.length > 0 ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
                {blockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-emerald-900">Every present judge has a ballot for every heat, and every heat is locked.</p>
            )}
            {board.blockers.missing_ballots.length > 0 ? (
              <p className="mt-2 text-xs text-slate-600">
                Missing:{" "}
                {board.blockers.missing_ballots
                  .map((item) => `${item.judge_letter} / heat ${heatNumber.get(item.heat_id) ?? "?"}`)
                  .join(", ")}
              </p>
            ) : null}
            {canLock ? (
              <form action={lockBallotsAction} className="mt-3">
                <input type="hidden" name="roundId" value={roundId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <button className={buttonClass} disabled={!board.blockers.ready || !board.scheme_available}>
                  Lock ballots
                </button>
                <p className="mt-2 text-xs text-slate-600">Locking stops all new ballots and corrections until a manager reopens the round, with a reason.</p>
              </form>
            ) : (
              <p className="mt-2 text-xs text-slate-600">Only a manager or the designated chair can lock the ballots.</p>
            )}
          </>
        ) : locked ? (
          <>
            <p className="mt-2 text-sm text-slate-700">
              {correcting
                ? "A results correction is open. Corrected ballots can be entered above; the round cannot be reopened until the correction is resolved."
                : "Ballots are locked. No ballot or correction can be added."}
            </p>
            {correcting ? null : canReopen ? (
              <form action={reopenBallotsAction} className="mt-3 space-y-2">
                <input type="hidden" name="roundId" value={roundId} />
                <input type="hidden" name="requestId" value={randomUUID()} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label className="block text-sm font-medium text-slate-900">
                  Reason for reopening
                  <input name="reason" required maxLength={500} className={`${inputClass} mt-1 block w-full`} />
                </label>
                <button className={quietButtonClass}>Reopen ballots</button>
              </form>
            ) : (
              <p className="mt-2 text-xs text-slate-600">Only a manager can reopen locked ballots.</p>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-slate-700">This round is {label(board.round.status)}. Ballots open when the round starts.</p>
        )}
      </section>
    </div>
  );
}
