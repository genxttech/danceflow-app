"use client";

import { useActionState, useState } from "react";
import { completeCategoryPricingAction, type ActionState } from "./simpleActions";

const INITIAL: ActionState = { ok: false };
const LABELS: Record<string, string> = { per_dance: "Per dance", per_entry: "Per entry", free: "Free" };

/** 10C.5: finishes "Configure later" pricing for one category. */
export default function PricingCompletionForm({
  eventId,
  contestId,
  label,
  models,
}: {
  eventId: string;
  contestId: string;
  label: string;
  models: string[];
}) {
  const [state, action, pending] = useActionState(completeCategoryPricingAction, INITIAL);
  const [model, setModel] = useState(models[0] ?? "free");

  return (
    <form action={action} className="rounded-lg border border-amber-200 bg-white p-3">
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="contestId" value={contestId} />
      <input type="hidden" name="model" value={model} />
      <p className="text-sm font-semibold text-slate-950">{label}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {models.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={model === item}
            onClick={() => setModel(item)}
            className={`rounded-full border px-3 py-1.5 text-sm ${model === item ? "border-slate-950 bg-slate-950 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-slate-500"}`}
          >
            {LABELS[item] ?? item}
          </button>
        ))}
        {model !== "free" ? (
          <label className="flex items-center gap-1 text-sm text-slate-700">
            $
            <input
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              aria-label={`${label} price ${model === "per_dance" ? "per dance" : "per entry"}`}
              className="h-10 w-28 rounded-lg border border-slate-300 px-3 text-right text-sm"
            />
          </label>
        ) : null}
        <button type="submit" disabled={pending} className="inline-flex h-10 items-center rounded-lg bg-slate-950 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60">
          {pending ? "Saving…" : "Save price"}
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="mt-2 text-sm text-rose-700">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
