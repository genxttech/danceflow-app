"use client";

import { useActionState } from "react";
import { configureStudioScoringAction, type ScoringActionState } from "../scoringActions";

export type PresetOption = { key: string; label: string; description: string };

const initial: ScoringActionState = { ok: false };

/**
 * SS1: choose an approved studio scoring setup for one division (or, without a division, every division of the competition).
 * The options are the registry presets the server reports as approved + selectable; the server re-resolves the choice, so
 * this list is a convenience, not the gate.
 */
export default function StudioScoringForm({
  eventId,
  programId,
  divisionId,
  presets,
  disclosure,
  submitLabel,
}: {
  eventId: string;
  programId: string;
  divisionId?: string;
  presets: PresetOption[];
  disclosure: string;
  submitLabel: string;
}) {
  const [state, action, pending] = useActionState(configureStudioScoringAction, initial);
  const idBase = `studio-scoring-${divisionId ?? programId}`;
  return (
    <form action={action} className="mt-2 bg-slate-50 p-3" aria-describedby={`${idBase}-note`}>
      <input type="hidden" name="eventId" value={eventId} />
      <input type="hidden" name="programId" value={programId} />
      {divisionId ? <input type="hidden" name="divisionId" value={divisionId} /> : null}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs font-semibold text-slate-700" htmlFor={`${idBase}-preset`}>Scoring setup</label>
        <select id={`${idBase}-preset`} name="presetKey" required defaultValue="" className="h-10 rounded border border-slate-300 bg-white px-3 text-sm text-slate-950">
          <option value="" disabled>Choose a studio scoring setup</option>
          {presets.map((preset) => <option key={preset.key} value={preset.key}>{preset.label}</option>)}
        </select>
        <button disabled={pending} className="h-10 rounded border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-white disabled:opacity-60">{pending ? "Saving…" : submitLabel}</button>
      </div>
      <ul className="mt-2 space-y-1 text-xs text-slate-600">{presets.map((preset) => <li key={preset.key}><span className="font-semibold">{preset.label}:</span> {preset.description}</li>)}</ul>
      <p id={`${idBase}-note`} className="mt-2 text-xs text-slate-600">{disclosure}</p>
      {state.error ? <p role="alert" className="mt-2 text-xs font-semibold text-red-700">{state.error}</p> : null}
      {state.ok && state.message ? <p role="status" className="mt-2 text-xs font-semibold text-emerald-800">{state.message}</p> : null}
    </form>
  );
}
