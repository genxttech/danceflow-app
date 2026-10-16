"use client";

import { useState, useTransition } from "react";
import { cancelSmsSetupAction, type SmsSetupState } from "./actions";

/**
 * Cancel control for the studio owner. Shown whenever the database says the setup can still be cancelled (draft, submitted,
 * information needed, business verification), including after submission and while the platform switch is paused.
 * Cancelling removes the saved EIN at once.
 */
export default function SmsCancelSetup({ submitted }: { submitted: boolean }) {
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<SmsSetupState>({});
  const [pending, startTransition] = useTransition();

  if (result.ok) {
    return <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">{result.notice}</p>;
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-4 py-3" aria-label="Cancel setup">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-slate-700">
            {submitted ? "Cancel this submitted setup? " : "Cancel this setup? "}Your saved EIN will be removed.
          </span>
          <button
            type="button"
            disabled={pending}
            className="rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-semibold text-rose-800 hover:bg-rose-50 disabled:opacity-50"
            onClick={() => startTransition(async () => { setResult(await cancelSmsSetupAction()); setConfirming(false); })}
          >
            {pending ? "Cancelling…" : "Yes, cancel setup"}
          </button>
          <button type="button" className="text-sm font-semibold text-slate-600" onClick={() => setConfirming(false)}>Keep going</button>
        </div>
      ) : (
        <button type="button" className="text-sm font-semibold text-slate-600 hover:text-rose-700" onClick={() => setConfirming(true)}>Cancel setup</button>
      )}
      {result.error ? <p role="alert" className="mt-2 text-sm font-medium text-rose-700">{result.error}</p> : null}
    </section>
  );
}
