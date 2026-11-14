"use client";

import { lockHeatConfirm, reopenHeatConfirm, type LockKind } from "@/lib/competition/ballots/heatLock";
import { lockHeatAction, reopenHeatAction } from "./actions";

const noteClass = "h-10 min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950";
const buttonClass = "h-10 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50";

/** One heat's Lock heat / Reopen heat control. The confirm runs before the server action; cancelling submits nothing. */
export default function LockHeatButton({
  mode,
  kind = "danced",
  roundId,
  heatId,
  heatNumber,
  returnTo,
}: {
  mode: "lock" | "reopen";
  kind?: LockKind;
  roundId: string;
  heatId: string;
  heatNumber: number;
  returnTo: string;
}) {
  const reopen = mode === "reopen";
  return (
    <form
      action={reopen ? reopenHeatAction : lockHeatAction}
      onSubmit={(event) => {
        if (!window.confirm(reopen ? reopenHeatConfirm(heatNumber) : lockHeatConfirm(heatNumber, kind))) event.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="roundId" value={roundId} />
      <input type="hidden" name="heatId" value={heatId} />
      <input type="hidden" name="heatNumber" value={heatNumber} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input
        name="reason"
        required={reopen}
        maxLength={500}
        placeholder={reopen ? "Reason for reopening" : "Note (optional)"}
        aria-label={reopen ? `Reason for reopening heat ${heatNumber}` : `Note for locking heat ${heatNumber}`}
        className={noteClass}
      />
      <button aria-label={reopen ? `Reopen heat ${heatNumber}` : `Lock heat ${heatNumber}`} className={buttonClass}>
        {reopen ? "Reopen heat" : "Lock heat"}
      </button>
    </form>
  );
}
