"use client";

import { useActionState } from "react";
import { setCompetitionRegistrationAction, type ActionState } from "./simpleActions";

const INITIAL: ActionState = { ok: false };

export default function RegistrationForm({
  eventId,
  programId,
  mode,
  label,
  variant = "primary",
}: {
  eventId: string;
  programId: string;
  mode: "open" | "close";
  label: string;
  variant?: "primary" | "secondary";
}) {
  const [state, action, pending] = useActionState(setCompetitionRegistrationAction, INITIAL);

  return (
    <form action={action}>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="programId" value={programId} />
      <input type="hidden" name="mode" value={mode} />
      <button
        type="submit"
        disabled={pending}
        className={
          variant === "primary"
            ? "inline-flex h-11 items-center rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
            : "inline-flex h-10 items-center rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-60"
        }
      >
        {pending ? (mode === "open" ? "Opening…" : "Closing…") : label}
      </button>
      {state.error ? (
        <p role="alert" className="mt-3 text-sm text-rose-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
