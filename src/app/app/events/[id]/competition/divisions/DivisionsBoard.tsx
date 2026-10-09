"use client";

import { useState } from "react";
import ResponsiveDetailPanel from "@/components/app/workspace/ResponsiveDetailPanel";
import { addDivisionAction, removeDivisionAction, updateDivisionAction, type ActionState } from "../simpleActions";

export type BoardDivision = {
  id: string;
  name: string;
  skillLabel: string | null;
  ageLabel: string | null;
  rounds: string[];
  dances: number;
  entries: number;
};

export type BoardCategory = {
  id: string;
  name: string;
  editable: boolean;
  divisions: BoardDivision[];
};

type Panel = { mode: "edit"; categoryId: string; divisionId: string } | { mode: "add"; categoryId: string } | null;

const fieldClass = "mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-950";

export default function DivisionsBoard({ eventId, categories }: { eventId: string; categories: BoardCategory[] }) {
  const [panel, setPanel] = useState<Panel>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const category = panel ? categories.find((item) => item.id === panel.categoryId) : undefined;
  const division = panel?.mode === "edit" ? category?.divisions.find((item) => item.id === panel.divisionId) : undefined;

  function close() {
    setPanel(null);
    setError(null);
  }

  async function run(formData: FormData, action: (formData: FormData) => Promise<ActionState>) {
    setBusy(true);
    setError(null);
    const result = await action(formData);
    setBusy(false);
    if (result.ok) close();
    else setError(result.error ?? "Something went wrong. Please try again.");
  }

  return (
    <>
      <div className="space-y-6">
        {categories.map((item) => (
          <section key={item.id} className="rounded-xl border border-slate-200 bg-white">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
              <h3 className="text-sm font-semibold text-slate-950">
                {item.name} <span className="ml-1 font-normal text-slate-500">{item.divisions.length} {item.divisions.length === 1 ? "division" : "divisions"}</span>
              </h3>
              {item.editable ? (
                <button type="button" onClick={() => setPanel({ mode: "add", categoryId: item.id })} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                  Add division
                </button>
              ) : null}
            </div>
            {item.divisions.length === 0 ? (
              <p className="px-5 py-4 text-sm text-amber-800">This category needs a division before the competition can be published.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {item.divisions.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      onClick={() => setPanel({ mode: "edit", categoryId: item.id, divisionId: entry.id })}
                      className="flex w-full items-center justify-between gap-3 px-5 py-3 text-left hover:bg-slate-50"
                    >
                      <span>
                        <span className="block text-sm font-medium text-slate-950">{entry.name}</span>
                        <span className="block text-xs text-slate-500">
                          {[entry.rounds.join(" → ") || "No round", entry.dances > 0 ? `${entry.dances} ${entry.dances === 1 ? "dance" : "dances"}` : null, entry.entries > 0 ? `${entry.entries} ${entry.entries === 1 ? "entry" : "entries"}` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      <span aria-hidden="true" className="text-slate-400">›</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>

      <ResponsiveDetailPanel
        open={Boolean(panel && category && (panel.mode === "add" || division))}
        title={panel?.mode === "add" ? `Add division to ${category?.name ?? ""}` : (division?.name ?? "Division")}
        description={category?.name}
        onClose={close}
      >
        {panel && category ? (
          <form
            key={panel.mode === "edit" ? panel.divisionId : `add-${panel.categoryId}`}
            action={(formData) => run(formData, panel.mode === "add" ? addDivisionAction : updateDivisionAction)}
            className="space-y-4 p-5"
          >
            <input type="hidden" name="eventId" value={eventId} />
            {panel.mode === "add" ? <input type="hidden" name="contestId" value={panel.categoryId} /> : <input type="hidden" name="divisionId" value={panel.divisionId} />}
            <label className="block text-sm font-medium text-slate-800">
              Division name
              <input name="name" required maxLength={200} defaultValue={division?.name ?? ""} className={fieldClass} />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Level (optional)
              <input name="skillLabel" maxLength={100} defaultValue={division?.skillLabel ?? ""} className={fieldClass} />
            </label>
            <label className="block text-sm font-medium text-slate-800">
              Age group (optional)
              <input name="ageLabel" maxLength={100} defaultValue={division?.ageLabel ?? ""} className={fieldClass} />
            </label>
            {panel.mode === "add" ? <p className="text-xs text-slate-500">The new division gets the same round and dances as the first division in this category.</p> : null}
            {error ? <p role="alert" className="text-sm text-rose-700">{error}</p> : null}
            <div className="flex items-center justify-between gap-3 pt-2">
              <button type="submit" disabled={busy || !category.editable} className="h-11 rounded-lg bg-slate-950 px-5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50">
                {busy ? "Saving…" : panel.mode === "add" ? "Add division" : "Save changes"}
              </button>
              {panel.mode === "edit" && category.editable ? (
                <button
                  type="button"
                  disabled={busy || (division?.entries ?? 0) > 0}
                  title={(division?.entries ?? 0) > 0 ? "Divisions with entries cannot be removed." : undefined}
                  onClick={() => {
                    const formData = new FormData();
                    formData.set("eventId", eventId);
                    formData.set("divisionId", panel.divisionId);
                    void run(formData, removeDivisionAction);
                  }}
                  className="text-sm font-semibold text-rose-700 hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Remove division
                </button>
              ) : null}
            </div>
            {!category.editable ? <p className="text-xs text-slate-500">This competition is running, so its divisions are locked.</p> : null}
          </form>
        ) : null}
      </ResponsiveDetailPanel>
    </>
  );
}
