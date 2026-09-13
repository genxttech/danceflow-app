"use client";

import { useActionState } from "react";
import {
  resolvePaymentSettlementConflictAction,
  addPaymentSettlementConflictNoteAction,
} from "@/app/app/clients/[id]/actions";

const initialState = { error: "" };

export default function ConflictRowActions({ conflictId }: { conflictId: string }) {
  const [noteState, noteFormAction, notePending] = useActionState(
    addPaymentSettlementConflictNoteAction,
    initialState,
  );
  const [resolveState, resolveFormAction, resolvePending] = useActionState(
    resolvePaymentSettlementConflictAction,
    initialState,
  );

  return (
    <div className="mt-3 space-y-2">
      <form action={noteFormAction} className="flex gap-2">
        <input type="hidden" name="conflictId" value={conflictId} />
        <input
          type="text"
          name="note"
          placeholder="Add a note (e.g. checked Stripe, still investigating)"
          className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={notePending}
          className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {notePending ? "Saving..." : "Add note"}
        </button>
      </form>
      {noteState?.error ? <p className="text-xs text-red-700">{noteState.error}</p> : null}

      <form action={resolveFormAction} className="flex gap-2">
        <input type="hidden" name="conflictId" value={conflictId} />
        <input
          type="text"
          name="resolutionNote"
          required
          placeholder="Resolution note (required) -- what did you verify/do in Stripe?"
          className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={resolvePending}
          className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {resolvePending ? "Resolving..." : "Mark resolved"}
        </button>
      </form>
      {resolveState?.error ? <p className="text-xs text-red-700">{resolveState.error}</p> : null}
    </div>
  );
}
