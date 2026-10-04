"use client";

import { useActionState, useState } from "react";
import {
  submitGroupClassSeriesEditAction,
  type GroupClassSeriesEditState,
} from "@/app/app/schedule/actions";
import { describeSeriesEditFields } from "@/lib/schedule/groupClassSeriesEdit";

type Option = { id: string; label: string };

type Props = {
  appointmentId: string;
  /** Generated once per page load; a double submit or retry of the same review replays instead of splitting twice. */
  requestId: string;
  occurrenceLabel: string | null;
  defaults: {
    title: string;
    instructorId: string;
    roomId: string;
    locationName: string;
    rosterCapacity: string;
    startTime: string;
    durationMinutes: string;
  };
  instructors: Option[];
  rooms: Option[];
  cancelHref: string;
};

const INITIAL: GroupClassSeriesEditState = { status: "idle" };

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
  instructors,
  rooms,
  cancelHref,
}: Props) {
  const [state, formAction, pending] = useActionState(submitGroupClassSeriesEditAction, INITIAL);
  const [values, setValues] = useState(defaults);
  const [overwrite, setOverwrite] = useState(false);

  const set = (key: keyof typeof defaults) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const preview = state.status === "preview" ? state.preview : undefined;
  const blocked = !!preview && (preview.conflictCount > 0 || preview.capacityBlockedCount > 0);
  const customizedLabels = preview ? describeSeriesEditFields(preview.customizedFields) : [];

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="requestId" value={requestId} />
      {preview && state.fingerprint ? (
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
                  name="overwriteCustomized"
                  checked={overwrite}
                  onChange={(event) => setOverwrite(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  <span className="font-semibold">Replace customized values too</span>
                  <span className="block text-xs">
                    {preview.customizedCount} {preview.customizedCount === 1 ? "class has" : "classes have"} its own{" "}
                    {customizedLabels.join(", ").toLowerCase() || "values"}. Leave this off to keep them. Review again after changing it.
                  </span>
                </span>
              </label>
            </div>
          ) : null}

          {blocked ? (
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
            disabled={pending || blocked}
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
