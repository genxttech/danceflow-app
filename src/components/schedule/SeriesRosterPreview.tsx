import {
  SERIES_ROSTER_STATE_LABELS,
  isBlockedState,
  isSkippedState,
  seriesRosterBlockers,
  seriesRosterClassLabel,
  seriesRosterSummary,
  type SeriesRosterKind,
  type SeriesRosterResult,
} from "@/lib/schedule/groupClassSeriesRoster";

const TONE_CLASS = {
  ready: "border-emerald-200 bg-emerald-50 text-emerald-900",
  info: "border-slate-200 bg-slate-50 text-slate-800",
  blocked: "border-amber-300 bg-amber-50 text-amber-900",
} as const;

/**
 * GC-S1D-2: the compact preview for "This and following classes". One plain headline, a few detail lines, the classes that
 * block the operation (named, with the reason) and a collapsed list of every class. "Skipped" classes never stop the operation;
 * "needs attention" classes do (nothing is enrolled when any class needs attention). Advisory only: apply re-checks everything.
 */
export default function SeriesRosterPreview({
  result,
  kind,
  name,
  timeZone,
}: {
  result: SeriesRosterResult;
  kind: SeriesRosterKind;
  name: string;
  timeZone: string;
}) {
  const summary = seriesRosterSummary(result, kind, name);
  const blockers = seriesRosterBlockers(result);

  return (
    <div role="status" aria-live="polite" className={`space-y-2 rounded-xl border p-3 text-xs ${TONE_CLASS[summary.tone]}`}>
      <p className="text-sm font-semibold">{summary.headline}</p>

      {summary.details.length > 0 ? (
        <ul className="list-disc space-y-0.5 pl-4">
          {summary.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {blockers.length > 0 ? (
        <div>
          <p className="font-semibold">Needs attention</p>
          <ul aria-label="Classes that need attention" className="mt-1 space-y-0.5">
            {blockers.map((item) => (
              <li key={item.appointmentId}>
                <span className="font-medium">{seriesRosterClassLabel(item.startsAt, timeZone)}</span> — {SERIES_ROSTER_STATE_LABELS[item.state]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.classes.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium underline">Show all {result.classes.length} {result.classes.length === 1 ? "class" : "classes"}</summary>
          <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto pr-1">
            {result.classes.map((item) => (
              <li key={item.appointmentId} className="flex flex-wrap justify-between gap-x-3">
                <span>{seriesRosterClassLabel(item.startsAt, timeZone)}</span>
                <span
                  className={
                    isBlockedState(item.state)
                      ? "font-semibold text-amber-800"
                      : isSkippedState(item.state) || item.state === "already_enrolled" || item.state === "not_enrolled"
                        ? "text-slate-500"
                        : "font-medium"
                  }
                >
                  {SERIES_ROSTER_STATE_LABELS[item.state]}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
