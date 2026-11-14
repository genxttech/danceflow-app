import type { BallotEntry } from "@/lib/competition/ballots/status";

const selectClass = "h-12 w-28 shrink-0 rounded border border-slate-300 bg-white px-2 text-base text-slate-950";

/**
 * One select per entry. Field names are `mark:<entryId>`; the server action turns them into the marks array and the
 * database decides whether the ballot is valid (this form only helps people fill it in).
 */
export default function BallotMarksFields({
  scoringMethod,
  entries,
  current,
}: {
  scoringMethod: string;
  entries: BallotEntry[];
  current?: Record<string, unknown>;
}) {
  const options: Array<{ value: string; label: string }> =
    scoringMethod === "proficiency_rating"
      ? [{ value: "Gold", label: "Gold" }, { value: "Silver", label: "Silver" }, { value: "Bronze", label: "Bronze" }]
      : entries.map((_, index) => ({ value: String(index + 1), label: String(index + 1) }));
  return (
    <ul className="divide-y divide-slate-100 rounded border border-slate-200 bg-white">
      {entries.map((entry) => {
        const existing = current?.[entry.entry_id];
        return (
          <li key={entry.entry_id} className="flex items-center justify-between gap-3 px-3 py-2">
            <label htmlFor={`mark-${entry.entry_id}`} className="min-w-0 flex-1 text-sm text-slate-900">
              <span className="mr-2 inline-block min-w-10 rounded bg-slate-100 px-1.5 py-0.5 text-center text-xs font-bold text-slate-800">
                {entry.entry_number ?? "-"}
              </span>
              <span className="break-words">{entry.display_name}</span>
            </label>
            <select
              id={`mark-${entry.entry_id}`}
              name={`mark:${entry.entry_id}`}
              defaultValue={existing === undefined || existing === null ? "" : String(existing)}
              className={selectClass}
              required
            >
              <option value="" disabled>
                {scoringMethod === "proficiency_rating" ? "Rating" : "Rank"}
              </option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </li>
        );
      })}
    </ul>
  );
}
