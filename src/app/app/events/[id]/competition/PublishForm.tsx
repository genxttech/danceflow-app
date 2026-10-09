"use client";

import { useActionState } from "react";
import { publishCompetitionAction, type ActionState } from "./simpleActions";

const INITIAL: ActionState = { ok: false };

export default function PublishForm({
  eventId,
  programId,
  label,
}: {
  eventId: string;
  programId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState(publishCompetitionAction, INITIAL);

  return (
    <form action={action}>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="programId" value={programId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Publishing…" : label}
      </button>
      {state.error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
