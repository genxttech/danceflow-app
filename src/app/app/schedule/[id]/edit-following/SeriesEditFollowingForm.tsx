"use client";

import { useActionState, useState } from "react";
import {
  submitGroupClassSeriesEditAction,
  type GroupClassSeriesEditState,
} from "@/app/app/schedule/actions";
import {
  applyAnchorCustomizedValues,
  describeSeriesEditFields,
  isSeriesEditReviewStale,
  SERIES_EDIT_GROUP_FIELDS,
  seriesEditReviewKey,
  type SeriesEditFormInput,
} from "@/lib/schedule/groupClassSeriesEdit";

type Option = { id: string; label: string };

type Props = {
  appointmentId: string;
  /** Generated once per page load; a double submit or retry of the same review replays instead of splitting twice. */
  requestId: string;
  occurrenceLabel: string | null;
  /** The series definition: the baseline the bulk edit is expressed against. */
  defaults: SeriesEditFormInput;
  /** The selected class's own values, and which tracked fields it has customized (empty when it follows the series). */
  anchorValues: SeriesEditFormInput;
  customizedGroups: string[];
  instructors: Option[];
  rooms: Option[];
  cancelHref: string;
};

const INITIAL: GroupClassSeriesEditState = { status: "idle" };

const FIELD_GROUP: Record<string, string> = Object.fromEntries(
  Object.entries(SERIES_EDIT_GROUP_FIELDS).flatMap(([group, fields]) => fields.map((field) => [field as string, group])),
);

const inputClass =
  "w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100";

/**
 * GC-S1C-5: "This and following classes" editor. Two steps in one form: "Review changes" asks the server for the
 * impact summary (nothing is written); "Apply" posts the same values with the request id and the fingerprint of what
 * was reviewed. Preserve customized values is the default; the overwrite choice appears only when the review found
 * customized classes. Recurrence, dates, notes and enrollment settings are deliberately not editable here.
 */
export default function SeriesEditFollowingForm({
  appointmentId,
  requestId,
  occurrenceLabel,
  defaults,
  anchorValues,
  customizedGroups,
  instructors,
  rooms,
  cancelHref,
}: Props) {
  const [state, formAction, pending] = useActionState(submitGroupClassSeriesEditAction, INITIAL);
  const [values, setValues] = useState(defaults);
  const [overwriteChoice, setOverwriteChoice] = useState(false);
  // Customized groups the owner chose to reset to the series values. A reset is an explicit overwrite of that group's
  // customization, so while any reset is selected the overwrite switch is on (and locked).
  const [resetGroups, setResetGroups] = useState<string[]>([]);
  const overwrite = overwriteChoice || resetGroups.length > 0;
  // The values + preserve/overwrite choice + reset selections the current review was run for (set when Review is clicked).
  const [reviewedKey, setReviewedKey] = useState<string | null>(null);
  const currentKey = seriesEditReviewKey(values, overwrite, resetGroups);
  const customizedLabels = describeSeriesEditFields(Object.fromEntries(customizedGroups.map((g) => [g, 1])));

  // Typing into a field of a group withdraws that group's reset (the owner is now choosing a value, not resetting).
  const set = (key: keyof typeof defaults) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    const group = FIELD_GROUP[key];
    if (group) setResetGroups((current) => current.filter((g) => g !== group));
  };

  const toggleReset = (group: string, on: boolean) => {
    setResetGroups((current) => (on ? [...current.filter((g) => g !== group), group] : current.filter((g) => g !== group)));
    if (on) {
      setValues((current) => {
        const next = { ...current };
        for (const field of SERIES_EDIT_GROUP_FIELDS[group] ?? []) next[field] = defaults[field];
        return next;
      });
    }
  };

  const preview = state.status === "preview" ? state.preview : undefined;
  const blocked = !!preview && (preview.conflictCount > 0 || preview.capacityBlockedCount > 0);
  const stale = !!preview && isSeriesEditReviewStale(reviewedKey, currentKey);
  const previewCustomizedLabels = preview ? describeSeriesEditFields(preview.customizedFields) : [];

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="requestId" value={requestId} />
      {overwrite ? <input type="hidden" name="overwriteCustomized" value="on" /> : null}
      {preview && state.fingerprint && !stale ? (
        <input type="hidden" name="reviewedFingerprint" value={state.fingerprint} />
      ) : null}

      <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3 text-sm text-slate-700">
        <p className="font-semibold text-slate-900">
          This and following classes
          {occurrenceLabel ? <span className="font-normal text-slate-600"> · starting with {occurrenceLabel}</span> : null}
        </p>
        <p className="mt-1 text-xs text-slate-600">
          Changes apply to this class and every later class in the series. Earlier classes stay as they are. To change the
          weekdays, repeat pattern or number of classes, cancel the remaining classes and create a new series.
        </p>
      </div>

      {customizedLabels.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <p className="font-semibold">This class is customized</p>
          <p className="mt-1 text-xs">
            It differs from the series in: {customizedLabels.join(", ").toLowerCase()}. The fields below start from the series values. To
            apply this class&apos;s own values to the following classes, use them here.
          </p>
          <button
            type="button"
            onClick={() => {
              setValues((current) => applyAnchorCustomizedValues(current, anchorValues, customizedGroups));
              setResetGroups((current) => current.filter((g) => !customizedGroups.includes(g)));
            }}
            className="mt-2 rounded-lg border border-amber-300 bg-white px-3 py-1 text-xs font-semibold text-amber-900 hover:bg-amber-100"
          >
            Use this class&apos;s values
          </button>
          <details className="mt-3 text-xs" open={resetGroups.length > 0}>
            <summary className="cursor-pointer font-semibold">Reset customizations to series values</summary>
            <p className="mt-1">
              Restores the series value for the fields you tick, for this and the following classes. Customized following
              classes in those fields return to the series value too.
            </p>
            <div className="mt-1 space-y-1">
              {customizedGroups.map((group) => (
                <label key={group} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="resetGroups"
                    value={group}
                    checked={resetGroups.includes(group)}
                    onChange={(event) => toggleReset(group, event.target.checked)}
                  />
                  <span>{describeSeriesEditFields({ [group]: 1 })[0] ?? group}</span>
                </label>
              ))}
            </div>
          </details>
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="md:col-span-2">
          <label htmlFor="title" className="mb-1 block text-sm font-medium">Title</label>
          <input id="title" name="title" value={values.title} onChange={set("title")} className={inputClass} required />
        </div>

        <div>
          <label htmlFor="instructorId" className="mb-1 block text-sm font-medium">Instructor</label>
          <select id="instructorId" name="instructorId" value={values.instructorId} onChange={set("instructorId")} className={inputClass}>
            <option value="">No instructor</option>
            {instructors.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="roomId" className="mb-1 block text-sm font-medium">Room</label>
          <select id="roomId" name="roomId" value={values.roomId} onChange={set("roomId")} className={inputClass}>
            <option value="">No room</option>
            {rooms.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="locationName" className="mb-1 block text-sm font-medium">Location</label>
          <input id="locationName" name="locationName" value={values.locationName} onChange={set("locationName")} className={inputClass} placeholder="Optional location or venue" />
        </div>

        <div>
          <label htmlFor="rosterCapacity" className="mb-1 block text-sm font-medium">Maximum students</label>
          <input
            id="rosterCapacity"
            name="rosterCapacity"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={values.rosterCapacity}
            onChange={set("rosterCapacity")}
            className={inputClass}
            placeholder="No limit"
          />
          <p className="mt-1 text-xs text-slate-500">Can&apos;t be lower than the students already booked in any of these classes.</p>
        </div>

        <div>
          <label htmlFor="startTime" className="mb-1 block text-sm font-medium">Start time</label>
          <input id="startTime" name="startTime" type="time" value={values.startTime} onChange={set("startTime")} className={inputClass} required />
        </div>

        <div>
          <label htmlFor="durationMinutes" className="mb-1 block text-sm font-medium">Length (minutes)</label>
          <input
            id="durationMinutes"
            name="durationMinutes"
            type="number"
            inputMode="numeric"
            min={5}
            max={720}
            step={5}
            value={values.durationMinutes}
            onChange={set("durationMinutes")}
            className={inputClass}
            required
          />
        </div>
      </div>

      {state.status === "error" && state.error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{state.error}</p>
      ) : null}

      {preview ? (
        <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">Review</p>
          <ul className="space-y-1 text-sm text-slate-700">
            {(state.lines ?? []).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          {preview.customizedCount > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={overwrite}
                  disabled={resetGroups.length > 0}
                  onChange={(event) => setOverwriteChoice(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="font-semibold">Replace customized values too</span>
                  <span className="block text-xs">
                    {preview.customizedCount} {preview.customizedCount === 1 ? "class has" : "classes have"} its own{" "}
                    {previewCustomizedLabels.join(", ").toLowerCase() || "values"}.{" "}
                    {resetGroups.length > 0
                      ? "Included because you are resetting customized fields."
                      : "Leave this off to keep them. Review again after changing it."}
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {stale ? (
            <p role="status" className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
              You changed something after this review. Review changes again before applying.
            </p>
          ) : null}

          {blocked && !stale ? (
            <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {preview.conflictCount > 0
                ? `${preview.conflictCount} ${preview.conflictCount === 1 ? "class conflicts" : "classes conflict"} with the schedule. Adjust the instructor, room or time.`
                : "Maximum students is lower than the students already booked in at least one class."}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          name="intent"
          value="preview"
          onClick={() => setReviewedKey(currentKey)}
          disabled={pending}
          className="rounded-xl border border-indigo-300 bg-white px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-60"
        >
          Review changes
        </button>
        {preview ? (
          <button
            type="submit"
            name="intent"
            value="apply"
            disabled={pending || blocked || stale}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            Apply to {preview.changedCount > 0 ? preview.changedCount : "following"}{" "}
            {preview.changedCount === 1 ? "class" : "classes"}
          </button>
        ) : null}
        <a href={cancelHref} className="text-sm font-medium text-slate-600 hover:text-slate-900">Back</a>
      </div>
    </form>
  );
}
