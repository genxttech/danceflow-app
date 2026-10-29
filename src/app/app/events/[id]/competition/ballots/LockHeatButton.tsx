"use client";

import { lockHeatConfirm } from "@/lib/competition/ballots/heatLock";
import { lockHeatAction } from "./actions";

/** One heat's Lock heat control. The confirm runs before the server action; cancelling submits nothing. */
export default function LockHeatButton({ roundId, heatId, heatNumber, returnTo }: { roundId: string; heatId: string; heatNumber: number; returnTo: string }) {
  return (
    <form
      action={lockHeatAction}
      onSubmit={(event) => {
        if (!window.confirm(lockHeatConfirm(heatNumber))) event.preventDefault();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input type="hidden" name="roundId" value={roundId} />
      <input type="hidden" name="heatId" value={heatId} />
      <input type="hidden" name="heatNumber" value={heatNumber} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input name="reason" maxLength={500} placeholder="Note (optional)" aria-label={`Note for locking heat ${heatNumber}`} className="h-10 min-w-0 flex-1 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950" />
      <button aria-label={`Lock heat ${heatNumber}`} className="h-10 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">
        Lock heat
      </button>
    </form>
  );
}
