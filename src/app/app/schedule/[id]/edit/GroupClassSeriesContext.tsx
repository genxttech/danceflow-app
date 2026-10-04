import {
  describeOverriddenFields,
  seriesOccurrenceLabel,
} from "@/lib/schedule/groupClassOccurrenceEdit";

/**
 * GC-S1C-1: restrained, read-only context shown when the class being edited
 * belongs to a series. Edits here change only this one class; the series
 * itself is not editable from this page. Overrides are shown as plain
 * labels, never as raw stored values.
 */
export default function GroupClassSeriesContext({
  occurrenceIndex,
  overriddenFields,
}: {
  occurrenceIndex: number | null;
  overriddenFields: readonly string[];
}) {
  const occurrence = seriesOccurrenceLabel(occurrenceIndex);
  const customized = describeOverriddenFields(overriddenFields);

  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm text-slate-700">
      <p className="font-semibold text-slate-900">
        Part of a class series
        {occurrence ? <span className="font-normal text-slate-600"> · {occurrence}</span> : null}
      </p>
      <p className="mt-1 text-xs text-slate-600">
        Changes here apply to this class only. The rest of the series stays as it is.
      </p>
      {customized.length > 0 ? (
        <details className="mt-2 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-slate-700">
            Customized for this class
          </summary>
          <p className="mt-1">This class differs from the series: {customized.join(", ")}.</p>
        </details>
      ) : null}
    </div>
  );
}
