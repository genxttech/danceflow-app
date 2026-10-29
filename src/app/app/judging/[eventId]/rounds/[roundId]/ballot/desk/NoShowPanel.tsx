import { randomUUID } from "crypto";
import { canMarkNoShow } from "@/lib/competition/noShow";
import { deskNoShowAction } from "./actions";

export type FloorEntries = {
  round_status: string;
  heats: Array<{
    heat_id: string;
    heat_number: number;
    heat_status: string;
    window_open: boolean;
    entries: Array<{
      heat_entry_id: string;
      entry_id: string;
      entry_number: string | null;
      display_name: string;
      status: string;
      no_show: boolean;
      no_show_reason: string | null;
    }>;
  }>;
};

/** NS1: chair / manager no-show controls on the ballot desk. Mobile first; the database enforces the window and authority. */
export default function NoShowPanel({ floor, returnTo }: { floor: FloorEntries; returnTo: string }) {
  const open = floor.round_status === "active";
  return (
    <section aria-label="No-shows" className="min-w-0 rounded border border-slate-200 bg-white p-3">
      <h2 className="text-base font-semibold text-slate-950">No-shows</h2>
      <p className="mt-1 text-sm text-slate-600">
        {open
          ? "Mark an entry that did not dance. Judges then rank only the entries who danced. Allowed while ballots are open."
          : "Ballots are not open, so no-shows cannot be changed here."}
      </p>
      {floor.heats.length === 0 ? <p className="mt-2 text-sm text-slate-600">No heats in the running order yet.</p> : null}
      <div className="mt-2 space-y-3">
        {floor.heats.map((heat) => (
          <div key={heat.heat_id} className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">Heat {heat.heat_number}</h3>
            <ul className="mt-1 divide-y divide-slate-100 rounded border border-slate-200">
              {heat.entries.map((entry) => {
                const canMark = canMarkNoShow({ roundStatus: floor.round_status, heatStatus: heat.heat_status, entryStatus: entry.status });
                return (
                  <li key={entry.heat_entry_id} className="min-w-0 px-3 py-2 text-sm">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className={`min-w-0 break-words ${entry.no_show ? "text-slate-500 line-through" : ""}`}>
                        {entry.entry_number ? `#${entry.entry_number} ` : ""}
                        {entry.display_name}
                      </span>
                      {entry.no_show ? <span className="shrink-0 rounded bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-900">No-show</span> : null}
                      {entry.status === "scratched" ? <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">Scratched</span> : null}
                    </div>
                    {entry.no_show || (heat.window_open && canMark) ? (
                      <details className="mt-1">
                        <summary className="flex min-h-11 cursor-pointer items-center text-xs font-semibold text-slate-700 underline">
                          {entry.no_show ? "Undo no-show" : "Mark no-show"}
                        </summary>
                        <form action={deskNoShowAction} className="mt-2 flex min-w-0 flex-col gap-2">
                          <input type="hidden" name="heatEntryId" value={entry.heat_entry_id} />
                          <input type="hidden" name="kind" value={entry.no_show ? "void" : "mark"} />
                          <input type="hidden" name="requestId" value={randomUUID()} />
                          <input type="hidden" name="returnTo" value={returnTo} />
                          {entry.no_show && entry.no_show_reason ? <p className="break-words text-xs text-slate-600">Reason given: {entry.no_show_reason}</p> : null}
                          <input name="reason" required maxLength={500} placeholder={entry.no_show ? "Why undo this no-show?" : "Reason (required)"} aria-label={entry.no_show ? "Reason for undoing the no-show" : "No-show reason"} className="h-11 min-w-0 rounded border border-slate-300 bg-white px-3 text-sm" />
                          <button className="h-11 rounded border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 hover:bg-slate-50">
                            {entry.no_show ? "Undo no-show" : "Mark no-show"}
                          </button>
                        </form>
                      </details>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
