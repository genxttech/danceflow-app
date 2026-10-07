"use client";

import { DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES, parseDirectPaymentAmount } from "@/lib/schedule/directPaymentAmount";

import { startTransition, useActionState, useReducer, useRef } from "react";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ChevronDown } from "lucide-react";

import {
  createGroupClassSeriesAction,
  previewGroupClassSeriesAction,
  type GroupClassSeriesCreateState,
  type GroupClassSeriesPreviewState,
} from "@/app/app/schedule/groupClassSeriesActions";
import GroupClassModeToggle, { type GroupClassMode } from "@/app/app/schedule/new/GroupClassModeToggle";
import {
  CREATE_OUTCOME_UNCONFIRMED,
  PREVIEW_ACTION_FAILED,
  createInFlightGuard,
  dispatchGuarded,
  runKeyedAction,
  type ClientFailureState,
  type InFlightGuard,
  type KeyedResult,
  type SeriesSubmission,
} from "@/lib/schedule/groupClassSeriesActionRunner";
import {
  CONFLICT_LABELS,
  WEEKDAY_OPTIONS,
  buildSeriesFormData,
  checkDefinition,
  definitionKey,
  deriveSeriesView,
  initSeriesFormState,
  seriesFormReducer,
  type SeriesFormValues,
  type SeriesRow,
} from "@/lib/schedule/groupClassSeriesFormModel";

type InstructorOption = { id: string; first_name: string | null; last_name: string | null };
type RoomOption = { id: string; name: string };

const FIELD =
  "w-full rounded-xl border border-slate-300 px-3 py-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1";
const LABEL = "mb-1.5 block text-sm font-medium text-slate-900";
const CARD = "rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6";

// ----------------------------------------------------------------------------
// Presentational pieces (exported for structural tests)
// ----------------------------------------------------------------------------

export function SeriesPreviewList({
  rows,
  summary,
  onSkip,
  onRestore,
  disabled,
}: {
  rows: SeriesRow[];
  summary: { instructor: string; place: string };
  onSkip: (index: number) => void;
  onRestore: (index: number) => void;
  disabled: boolean;
}) {
  const included = rows.filter((row) => !row.skipped).length;
  const attention = rows.filter((row) => !row.skipped && row.conflict).length;

  return (
    <section aria-labelledby="series-preview-heading" className={CARD}>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h3 id="series-preview-heading" className="text-lg font-semibold text-slate-900">
          {included} {included === 1 ? "class" : "classes"} in this series
        </h3>
        <p className="text-sm text-slate-600">
          {attention > 0
            ? `${attention} ${attention === 1 ? "date needs" : "dates need"} attention`
            : "No scheduling conflicts"}
        </p>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {summary.instructor}
        {summary.place ? ` · ${summary.place}` : ""}
      </p>

      <ol className="mt-4 divide-y divide-slate-100 rounded-2xl border border-slate-200">
        {rows.map((row) => (
          <li
            key={row.index}
            className={`flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between ${
              row.skipped ? "bg-slate-50" : ""
            }`}
          >
            <div className="min-w-0">
              <p className={`text-sm font-medium text-slate-900 ${row.skipped ? "line-through" : ""}`}>
                {row.dateLabel}
                <span className="ml-2 font-normal text-slate-600">{row.timeLabel}</span>
              </p>

              {row.skipped ? (
                <p className="mt-1 text-sm text-slate-600">
                  <strong className="font-semibold">Skipped</strong> — this class won&apos;t be created.
                </p>
              ) : null}

              {!row.skipped && row.conflict ? (
                <p className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-900">
                  <strong className="font-semibold">{CONFLICT_LABELS[row.conflict.category] ?? CONFLICT_LABELS.other}:</strong>{" "}
                  {row.conflict.message} Skip this date to continue.
                </p>
              ) : null}

              {row.dstGuidance ? (
                <p className="mt-1 text-sm text-slate-600">
                  <strong className="font-semibold">Daylight saving:</strong> {row.dstGuidance}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              disabled={disabled}
              onClick={() => (row.skipped ? onRestore(row.index) : onSkip(row.index))}
              aria-label={`${row.skipped ? "Restore" : "Skip"} ${row.dateLabel}`}
              className="shrink-0 self-start rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-1 disabled:opacity-60"
            >
              {row.skipped ? "Restore" : "Skip"}
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function SeriesActionBar({
  previewCurrent,
  canPreview,
  canCreate,
  previewPending,
  createPending,
  createCount,
  unresolvedConflicts,
  unconfirmedCreate = false,
  hint,
  onPreview,
  onCreate,
}: {
  previewCurrent: boolean;
  canPreview: boolean;
  canCreate: boolean;
  previewPending: boolean;
  createPending: boolean;
  createCount: number;
  unresolvedConflicts: number;
  /**
   * The last create ended without a confirmed outcome (it may have committed).
   * Re-previewing would show the possibly-created series' own classes as
   * conflicts, so "Check again" is withheld and the owner is steered to simply
   * retry Create (same request id), which is safe.
   */
  unconfirmedCreate?: boolean;
  hint: string | null;
  onPreview: () => void;
  onCreate: () => void;
}) {
  const primary = previewCurrent
    ? {
        label: createPending ? "Creating series…" : `Create series (${createCount} ${createCount === 1 ? "class" : "classes"})`,
        disabled: !canCreate,
        onClick: onCreate,
      }
    : {
        label: previewPending ? "Checking schedule…" : "Preview schedule",
        disabled: !canPreview,
        onClick: onPreview,
      };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <button
        type="submit"
        disabled={primary.disabled}
        aria-disabled={primary.disabled}
        onClick={(event) => {
          event.preventDefault();
          if (!primary.disabled) primary.onClick();
        }}
        className="inline-flex items-center justify-center rounded-xl bg-slate-900 px-5 py-3 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:opacity-60"
      >
        {primary.label}
      </button>

      {previewCurrent && !unconfirmedCreate ? (
        <button
          type="button"
          disabled={!canPreview}
          onClick={onPreview}
          className="inline-flex items-center justify-center rounded-xl border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {previewPending ? "Checking schedule…" : "Check again"}
        </button>
      ) : null}

      <p role="status" aria-live="polite" className="text-sm text-slate-600">
        {previewPending
          ? "Checking every date for conflicts…"
          : createPending
            ? "Creating your series — please wait."
            : unconfirmedCreate
              ? "Select Create series to try again. It's safe — nothing will be duplicated."
              : previewCurrent && unresolvedConflicts > 0
              ? `Skip or resolve ${unresolvedConflicts} conflicting ${unresolvedConflicts === 1 ? "date" : "dates"} to create the series.`
              : hint}
      </p>
    </div>
  );
}

// ----------------------------------------------------------------------------
// The form
// ----------------------------------------------------------------------------

function weekdayOf(isoDate: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
  return day === 0 ? 7 : day;
}

export default function GroupClassSeriesForm({
  instructors,
  rooms,
  studioTimeZone,
  initialDate = "",
  onChooseMode,
}: {
  instructors: InstructorOption[];
  rooms: RoomOption[];
  studioTimeZone: string;
  initialDate?: string;
  onChooseMode: (mode: GroupClassMode) => void;
}) {
  // One request id for the whole life of this form instance: created lazily on
  // first render and never touched by any reducer action (see the form model).
  const [state, dispatch] = useReducer(seriesFormReducer, undefined, () => {
    const initialWeekday = weekdayOf(initialDate);
    return initSeriesFormState(() => crypto.randomUUID(), {
      startsOn: initialDate,
      weekdays: initialWeekday ? [initialWeekday] : [],
    });
  });

  // Synchronous same-tick lock shared by preview and create. React's pending flag
  // is not guaranteed to flip before the next event, so this is the real guard;
  // the rendered disabled/pending states remain what the user sees.
  const guardRef = useRef<InFlightGuard | null>(null);
  if (guardRef.current === null) guardRef.current = createInFlightGuard();
  const guard = guardRef.current;

  // Every result is tagged with the definition key it was SUBMITTED for, and a
  // failed/rejected action becomes a safe state: the form (and its request id)
  // is never unmounted by an action failure.
  const [previewResult, previewDispatch, previewPending] = useActionState<
    KeyedResult<GroupClassSeriesPreviewState | ClientFailureState>,
    SeriesSubmission
  >(
    (_previous, submission) =>
      runKeyedAction({
        submission,
        call: (formData) => previewGroupClassSeriesAction({ status: "idle" }, formData),
        failure: PREVIEW_ACTION_FAILED,
        guard,
        isRedirect: isRedirectError,
        label: "preview",
      }),
    { key: null, state: { status: "idle" } },
  );
  const [createResult, createDispatch, createPending] = useActionState<
    KeyedResult<GroupClassSeriesCreateState | ClientFailureState>,
    SeriesSubmission
  >(
    (_previous, submission) =>
      runKeyedAction({
        submission,
        call: (formData) => createGroupClassSeriesAction({ status: "idle" }, formData),
        failure: CREATE_OUTCOME_UNCONFIRMED,
        guard,
        isRedirect: isRedirectError,
        label: "create",
      }),
    { key: null, state: { status: "idle" } },
  );

  const { values } = state;
  const key = definitionKey(values);
  const view = deriveSeriesView({
    state,
    previewResult,
    createResult,
    pending: { preview: previewPending, create: createPending },
    timeZone: studioTimeZone,
  });
  const definition = checkDefinition(state);

  function edit(patch: Partial<SeriesFormValues>) {
    dispatch({ type: "edit", patch });
  }

  function submit(dispatch: (submission: SeriesSubmission) => void, allowed: boolean) {
    dispatchGuarded({
      guard,
      allowed,
      buildSubmission: () => ({ formData: buildSeriesFormData(state), key }),
      dispatch: (submission) => startTransition(() => dispatch(submission)),
    });
  }

  function runPreview() {
    submit(previewDispatch, view.canPreview);
  }

  function runCreate() {
    submit(createDispatch, view.canCreate);
  }

  const instructorName = (() => {
    const found = instructors.find((i) => i.id === values.instructorId);
    return found ? `Instructor: ${[found.first_name, found.last_name].filter(Boolean).join(" ")}` : "No instructor assigned";
  })();
  const placeParts = [rooms.find((r) => r.id === values.roomId)?.name, values.locationName.trim()].filter(Boolean);

  // Results only apply to the definition they were requested for; once the
  // definition changes they are hidden and a fresh preview is required.
  const previewError =
    previewResult.key === key && previewResult.state.status === "error" ? previewResult.state.error : null;
  const createError =
    createResult.key === key && (createResult.state.status === "error" || createResult.state.status === "conflict")
      ? (createResult.state.error ?? null)
      : null;
  // Withhold "Check again" after a create whose outcome was never confirmed (see SeriesActionBar).
  const unconfirmedCreate =
    createResult.key === key && createResult.state.status === "error" && createResult.state.code === "action_failed";
  const previewStale = previewResult.state.status === "preview" && !view.previewCurrent;

  const fundingMissing =
    (values.allowSelfEnrollment || values.showToLinkedStudents) &&
    !values.packageEnabled &&
    !values.membershipEnabled &&
    !values.directPaymentEnabled;
  // GC-3.5-1: same validation as the server parser (shared module).
  const directPaymentCheck = values.directPaymentEnabled ? parseDirectPaymentAmount(values.directPaymentAmount) : null;
  const directPaymentError =
    directPaymentCheck && !directPaymentCheck.ok ? DIRECT_PAYMENT_AMOUNT_ERROR_MESSAGES[directPaymentCheck.code] : null;

  const hint = !definition.ok
    ? "Fill in the class name, start date, days and schedule to preview."
    : previewStale
      ? "You changed the schedule — preview it again before creating."
      : "We'll check every date for conflicts before anything is created.";

  return (
    <div className="space-y-5 md:space-y-6">
      <div className={CARD}>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900 md:text-3xl">New class series</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 md:text-base">
          Set the schedule once and DanceFlow creates every class. You can preview each date before anything is saved.
        </p>
        <div className="mt-4 max-w-xl">
          <GroupClassModeToggle mode="series" onChange={onChooseMode} />
        </div>
      </div>

      <form
        noValidate
        className="space-y-5 md:space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (view.previewCurrent) runCreate();
          else runPreview();
        }}
      >
        <section aria-labelledby="series-class-heading" className={CARD}>
          <h3 id="series-class-heading" className="text-lg font-semibold text-slate-900">
            Class
          </h3>
          <div className="mt-4 grid gap-4">
            <div>
              <label htmlFor="series-title" className={LABEL}>
                Class name
              </label>
              <input
                id="series-title"
                value={values.title}
                onChange={(e) => edit({ title: e.target.value })}
                maxLength={200}
                placeholder="Example: Beginner Salsa"
                className={FIELD}
              />
            </div>
            <div>
              <label htmlFor="series-description" className={LABEL}>
                Description <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <textarea
                id="series-description"
                value={values.description}
                onChange={(e) => edit({ description: e.target.value })}
                maxLength={2000}
                rows={2}
                className={FIELD}
              />
            </div>
          </div>
        </section>

        <section aria-labelledby="series-schedule-heading" className={CARD}>
          <h3 id="series-schedule-heading" className="text-lg font-semibold text-slate-900">
            Schedule
          </h3>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="series-starts-on" className={LABEL}>
                First class date
              </label>
              <input
                id="series-starts-on"
                type="date"
                value={values.startsOn}
                onChange={(e) => {
                  const next = e.target.value;
                  const weekday = weekdayOf(next);
                  // Convenience: a first date with no days chosen yet selects its own weekday.
                  edit({
                    startsOn: next,
                    ...(values.weekdays.length === 0 && weekday ? { weekdays: [weekday] } : {}),
                  });
                }}
                className={FIELD}
              />
            </div>

            <fieldset className="md:col-span-2">
              <legend className={LABEL}>Days of the week</legend>
              <div className="flex flex-wrap gap-2">
                {WEEKDAY_OPTIONS.map((day) => {
                  const checked = values.weekdays.includes(day.value);
                  return (
                    <label key={day.value} htmlFor={`series-day-${day.value}`} className="relative cursor-pointer">
                      <input
                        id={`series-day-${day.value}`}
                        type="checkbox"
                        checked={checked}
                        onChange={() => dispatch({ type: "toggleWeekday", day: day.value })}
                        aria-label={day.long}
                        className="peer sr-only"
                      />
                      <span
                        aria-hidden="true"
                        className={`inline-flex min-w-14 justify-center rounded-xl border px-3 py-2 text-sm font-medium peer-focus-visible:ring-2 peer-focus-visible:ring-slate-900 peer-focus-visible:ring-offset-2 ${
                          checked
                            ? "border-slate-900 bg-slate-900 text-white"
                            : "border-slate-300 bg-white text-slate-700 hover:border-slate-400"
                        }`}
                      >
                        {checked ? "✓ " : ""}
                        {day.short}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div>
              <label htmlFor="series-start-time" className={LABEL}>
                Start time
              </label>
              <input
                id="series-start-time"
                type="time"
                value={values.startTime}
                onChange={(e) => edit({ startTime: e.target.value })}
                className={FIELD}
              />
              <p className="mt-1 text-xs text-slate-500">In your studio&apos;s local time.</p>
            </div>

            <div>
              <label htmlFor="series-duration" className={LABEL}>
                Length (minutes)
              </label>
              <input
                id="series-duration"
                type="number"
                inputMode="numeric"
                min={5}
                max={720}
                step={5}
                value={values.durationMinutes}
                onChange={(e) => edit({ durationMinutes: e.target.value })}
                className={FIELD}
              />
            </div>

            <div>
              <label htmlFor="series-interval" className={LABEL}>
                Repeat every (weeks)
              </label>
              <input
                id="series-interval"
                type="number"
                inputMode="numeric"
                min={1}
                max={52}
                value={values.intervalWeeks}
                onChange={(e) => edit({ intervalWeeks: e.target.value })}
                className={FIELD}
              />
            </div>

            <fieldset className="md:col-span-2">
              <legend className={LABEL}>Series ends</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 p-3">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-900" htmlFor="series-end-count">
                    <input
                      id="series-end-count"
                      type="radio"
                      name="series-end-mode"
                      checked={values.endMode === "count"}
                      onChange={() => edit({ endMode: "count" })}
                      className="h-4 w-4"
                    />
                    After a number of classes
                  </label>
                  <label htmlFor="series-count" className="sr-only">
                    Number of classes
                  </label>
                  <input
                    id="series-count"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={104}
                    value={values.occurrenceCount}
                    disabled={values.endMode !== "count"}
                    onChange={(e) => edit({ occurrenceCount: e.target.value })}
                    className={`${FIELD} mt-2 disabled:bg-slate-100 disabled:text-slate-400`}
                  />
                  <p className="mt-1 text-xs text-slate-500">Up to 104 classes.</p>
                </div>

                <div className="rounded-xl border border-slate-200 p-3">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-900" htmlFor="series-end-date">
                    <input
                      id="series-end-date"
                      type="radio"
                      name="series-end-mode"
                      checked={values.endMode === "date"}
                      onChange={() => edit({ endMode: "date" })}
                      className="h-4 w-4"
                    />
                    On a date
                  </label>
                  <label htmlFor="series-ends-on" className="sr-only">
                    Last possible class date
                  </label>
                  <input
                    id="series-ends-on"
                    type="date"
                    value={values.endsOn}
                    disabled={values.endMode !== "date"}
                    onChange={(e) => edit({ endsOn: e.target.value })}
                    className={`${FIELD} mt-2 disabled:bg-slate-100 disabled:text-slate-400`}
                  />
                  <p className="mt-1 text-xs text-slate-500">Within two years of the first class.</p>
                </div>
              </div>
            </fieldset>
          </div>
        </section>

        <section aria-labelledby="series-where-heading" className={CARD}>
          <h3 id="series-where-heading" className="text-lg font-semibold text-slate-900">
            Who and where
          </h3>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="series-instructor" className={LABEL}>
                Instructor <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <select
                id="series-instructor"
                value={values.instructorId}
                onChange={(e) => edit({ instructorId: e.target.value })}
                className={FIELD}
              >
                <option value="">Select instructor</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {[instructor.first_name, instructor.last_name].filter(Boolean).join(" ")}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="series-room" className={LABEL}>
                Room <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <select
                id="series-room"
                value={values.roomId}
                onChange={(e) => edit({ roomId: e.target.value })}
                className={FIELD}
              >
                <option value="">Select room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="series-location" className={LABEL}>
                Location <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id="series-location"
                value={values.locationName}
                onChange={(e) => edit({ locationName: e.target.value })}
                maxLength={200}
                placeholder="Example: Rented ballroom"
                className={FIELD}
              />
            </div>

            <div>
              <label htmlFor="series-capacity" className={LABEL}>
                Maximum students <span className="font-normal text-slate-500">(optional)</span>
              </label>
              <input
                id="series-capacity"
                type="number"
                inputMode="numeric"
                min={1}
                value={values.rosterCapacity}
                onChange={(e) => edit({ rosterCapacity: e.target.value })}
                placeholder="No limit"
                className={FIELD}
              />
            </div>
          </div>

          <details className="group mt-5 rounded-2xl border border-slate-200">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl px-4 py-3 text-sm font-semibold text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 [&::-webkit-details-marker]:hidden">
              <span>
                Enrollment options
                <span className="ml-2 font-normal text-slate-500">Optional</span>
              </span>
              <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 transition-transform group-open:rotate-180" />
            </summary>

            <div className="space-y-4 border-t border-slate-200 px-4 py-4">
              <p className="text-sm text-slate-500">
                These apply to every class in the series, and you can change them for an individual class later. Everything is
                off by default.
              </p>

              <label className="flex items-start gap-3 text-sm text-slate-700" htmlFor="series-self-enroll">
                <input
                  id="series-self-enroll"
                  type="checkbox"
                  checked={values.allowSelfEnrollment}
                  onChange={(e) => edit({ allowSelfEnrollment: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium text-slate-900">Let students join from their portal</span>
                  <br />
                  Students with an eligible package or membership can enroll themselves.
                </span>
              </label>

              <label className="flex items-start gap-3 text-sm text-slate-700" htmlFor="series-linked-visible">
                <input
                  id="series-linked-visible"
                  type="checkbox"
                  checked={values.showToLinkedStudents}
                  onChange={(e) => edit({ showToLinkedStudents: e.target.checked })}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300"
                />
                <span>
                  <span className="font-medium text-slate-900">Show these classes to portal students</span>
                  <br />
                  Students with a linked portal account can see the classes in their schedule.
                </span>
              </label>

              {values.allowSelfEnrollment || values.showToLinkedStudents ? (
                <fieldset className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <legend className="px-1 text-sm font-medium text-slate-900">Accepted enrollment methods</legend>
                  <div className="mt-2 space-y-2">
                    <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="series-fund-package">
                      <input
                        id="series-fund-package"
                        type="checkbox"
                        checked={values.packageEnabled}
                        onChange={(e) => edit({ packageEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Packages
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="series-fund-membership">
                      <input
                        id="series-fund-membership"
                        type="checkbox"
                        checked={values.membershipEnabled}
                        onChange={(e) => edit({ membershipEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Memberships
                    </label>
                    <label className="flex items-center gap-2 text-sm text-slate-700" htmlFor="series-fund-direct">
                      <input
                        id="series-fund-direct"
                        type="checkbox"
                        checked={values.directPaymentEnabled}
                        onChange={(e) => edit({ directPaymentEnabled: e.target.checked })}
                        className="h-4 w-4 rounded border-slate-300"
                      />
                      Direct payment
                    </label>
                  </div>
                  {values.directPaymentEnabled ? (
                    <div className="mt-3">
                      <label htmlFor="series-direct-price" className="text-sm font-medium text-slate-900">
                        Direct payment price
                      </label>
                      <div className="mt-1 flex max-w-[12rem] items-center rounded-lg border border-slate-300 bg-white px-3">
                        <span aria-hidden="true" className="text-sm text-slate-500">
                          $
                        </span>
                        <input
                          id="series-direct-price"
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="25.00"
                          value={values.directPaymentAmount}
                          onChange={(e) => edit({ directPaymentAmount: e.target.value })}
                          aria-invalid={directPaymentError ? true : undefined}
                          className="w-full border-0 bg-transparent py-2 pl-1 text-sm text-slate-900 outline-none"
                        />
                      </div>
                      <p className="mt-1 text-xs text-slate-500">USD, per class. Applies to every class in this series.</p>
                      {directPaymentError ? (
                        <p role="alert" className="mt-1 text-sm font-medium text-red-700">
                          {directPaymentError}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {fundingMissing ? (
                    <p role="alert" className="mt-3 text-sm font-medium text-red-700">
                      Choose at least one option to show these classes or let students join.
                    </p>
                  ) : null}
                </fieldset>
              ) : null}
            </div>
          </details>
        </section>

        {previewError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {previewError}
          </div>
        ) : null}

        {createError ? (
          <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {createError}
          </div>
        ) : null}

        {view.previewCurrent ? (
          <SeriesPreviewList
            rows={view.rows}
            summary={{ instructor: instructorName, place: placeParts.join(" · ") }}
            disabled={previewPending || createPending}
            onSkip={(index) => dispatch({ type: "skip", index })}
            onRestore={(index) => dispatch({ type: "restore", index })}
          />
        ) : null}

        {/* With a preview showing, the action stays reachable while scrolling a long list. */}
        <div className={`${CARD} ${view.previewCurrent ? "sticky bottom-2 z-10 shadow-lg md:bottom-4" : ""}`}>
          <SeriesActionBar
            previewCurrent={view.previewCurrent}
            canPreview={view.canPreview}
            canCreate={view.canCreate}
            previewPending={previewPending}
            createPending={createPending}
            createCount={view.createCount}
            unresolvedConflicts={view.unresolvedConflicts}
            unconfirmedCreate={unconfirmedCreate}
            hint={fundingMissing ? "Choose a credit option in Enrollment options, or turn those settings off." : hint}
            onPreview={runPreview}
            onCreate={runCreate}
          />
        </div>
      </form>
    </div>
  );
}
