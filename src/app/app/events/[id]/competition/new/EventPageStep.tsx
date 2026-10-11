"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { EventCoverImage, EventDescriptionBody, EventHeroText, EventHighlights, EventRegistrationInfo } from "@/components/public/EventPresentation";
import {
  OPERATIONS_PERMISSION_TEXT,
  PRESENTATION_LIMITS,
  addHighlight,
  presentationChanges,
  removeHighlight,
  setHighlight,
  setPresentation,
  type EventPresentation,
  type SetupAnswers,
} from "@/lib/competition/setup/draft";
import type { EventOperationsLocks } from "@/lib/competition/setup/eventPresentationServer";
import { formatEventDates, formatEventTimes, formatEventVenue } from "@/lib/events/eventDisplay";
import { TIMEZONE_OPTIONS, US_STATE_OPTIONS } from "@/lib/forms/options";
import { uploadCompetitionCoverImageAction } from "../simpleActions";

export type EventPageSummary = { dates: string | null; times: string | null; venue: string | null };

/** The preview's date, time and venue line, from the pending (not yet saved) values. */
export function presentationSummary(presentation: EventPresentation): EventPageSummary {
  return {
    dates: formatEventDates(presentation.startDate, presentation.endDate),
    times: formatEventTimes(presentation.startTime, presentation.endTime),
    venue: formatEventVenue(presentation.venueName, presentation.city, presentation.state),
  };
}

const fieldClass = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950";
const labelClass = "block text-sm font-semibold text-slate-950";

/**
 * The event page as the public event page renders it, built from the same shared components
 * (src/components/public/EventPresentation). A preview only: draft events are not public.
 */
export function EventPagePreview({ presentation, summary }: { presentation: EventPresentation; summary: EventPageSummary }) {
  const when = [summary.dates, summary.times].filter(Boolean).join(" · ");
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label="Event page preview">
      <div className="relative">
        <EventCoverImage url={presentation.coverImageUrl || null} alt={presentation.name} />
        <div className="absolute inset-0 bg-gradient-to-t from-slate-950/75 via-slate-950/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-5">
          <EventHeroText name={presentation.name || "Event title"} summary={presentation.summary.trim() || null} description={presentation.description.trim() || null} />
        </div>
      </div>
      <div className="p-5">
        {when || summary.venue ? <p className="text-sm text-slate-600">{[when, summary.venue].filter(Boolean).join(" · ")}</p> : null}
        <EventDescriptionBody description={presentation.description.trim() || null} />
        <EventHighlights highlights={presentation.highlights} />
        <EventRegistrationInfo info={presentation.registrationInfo} />
      </div>
    </div>
  );
}

/**
 * Event Details & Presentation: the event's venue, dates and time zone plus its page content, starting from the
 * event's current values. Only what the organizer changes is written, in the same transaction as the draft.
 * Venue, dates, times and time zone need an owner/admin role and are refused (here, by the server action and by
 * the database) when registrations, extra locations or dated records depend on them.
 */
export function EventPageStep({
  eventId,
  answers,
  baseline,
  canEditOperations,
  locks,
  update,
}: {
  eventId: string;
  answers: SetupAnswers;
  baseline: EventPresentation;
  canEditOperations: boolean;
  locks: EventOperationsLocks;
  update: (change: (current: SetupAnswers) => SetupAnswers) => void;
}) {
  const presentation = answers.presentation;
  const summary = presentationSummary(presentation);
  const venueLocked = !canEditOperations || locks.activeRegistrations || locks.additionalLocations;
  const datesLocked = !canEditOperations || locks.activeRegistrations || locks.datedRecords;
  const reasons = [
    !canEditOperations ? OPERATIONS_PERMISSION_TEXT : null,
    canEditOperations && locks.activeRegistrations ? "This event already has registrations, so its venue, dates and time zone are changed in Edit event, which notifies registrants." : null,
    canEditOperations && !locks.activeRegistrations && locks.additionalLocations ? "This event lists additional locations; change its venue in Edit event." : null,
    canEditOperations && !locks.activeRegistrations && locks.datedRecords ? "This event already has dated schedule items or sessions that a date or time zone change would strand; change its dates in Edit event." : null,
  ].filter((reason): reason is string => Boolean(reason));
  const field = (key: "venueName" | "addressLine1" | "addressLine2" | "city" | "postalCode", label: string, maxLength: number) => (
    <label className="block">
      <span className="block text-xs font-semibold text-slate-700">{label}</span>
      <input
        value={presentation[key]}
        maxLength={maxLength}
        disabled={venueLocked}
        onChange={(changeEvent) => update((current) => setPresentation(current, { [key]: changeEvent.target.value }))}
        className={`mt-1 ${fieldClass} disabled:bg-slate-100 disabled:text-slate-500`}
      />
    </label>
  );
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, startUpload] = useTransition();
  const changed = Object.keys(presentationChanges(presentation, baseline));

  function upload(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    const data = new FormData();
    data.set("eventId", eventId);
    data.set("coverImage", file);
    startUpload(async () => {
      const result = await uploadCompetitionCoverImageAction(data);
      if (result.ok && result.url) update((current) => setPresentation(current, { coverImageUrl: result.url as string }));
      else setUploadError(result.error ?? "The image could not be uploaded.");
    });
  }

  return (
    <div className="space-y-5">
      <fieldset className="rounded-xl border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-950">Venue, dates and time zone</legend>
        <p className="text-xs text-slate-500">Times are local to the event&apos;s time zone. The registration dates you chose are read in this time zone.</p>
        {reasons.length > 0 ? (
          <div role="note" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            {reasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
            {canEditOperations ? (
              <p className="mt-1">
                <Link href={`/app/events/${eventId}/edit`} className="font-semibold underline">
                  Edit event
                </Link>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {field("venueName", "Venue", PRESENTATION_LIMITS.venue)}
          {field("addressLine1", "Address", PRESENTATION_LIMITS.address)}
          {field("addressLine2", "Address line 2", PRESENTATION_LIMITS.address)}
          {field("city", "City", PRESENTATION_LIMITS.city)}
          <label className="block">
            <span className="block text-xs font-semibold text-slate-700">State</span>
            <select
              value={presentation.state}
              disabled={venueLocked}
              onChange={(changeEvent) => update((current) => setPresentation(current, { state: changeEvent.target.value }))}
              className={`mt-1 ${fieldClass} disabled:bg-slate-100 disabled:text-slate-500`}
            >
              <option value="">—</option>
              {US_STATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          {field("postalCode", "Postal code", PRESENTATION_LIMITS.postalCode)}
          {(
            [
              ["startDate", "Start date", "date"],
              ["endDate", "End date", "date"],
              ["startTime", "Start time", "time"],
              ["endTime", "End time", "time"],
            ] as const
          ).map(([key, label, type]) => (
            <label key={key} className="block">
              <span className="block text-xs font-semibold text-slate-700">{label}</span>
              <input
                type={type}
                value={presentation[key]}
                disabled={datesLocked}
                onChange={(changeEvent) => update((current) => setPresentation(current, { [key]: changeEvent.target.value }))}
                className={`mt-1 ${fieldClass} disabled:bg-slate-100 disabled:text-slate-500`}
              />
            </label>
          ))}
          <label className="block sm:col-span-2">
            <span className="block text-xs font-semibold text-slate-700">Time zone</span>
            <select
              value={presentation.timezone}
              disabled={datesLocked}
              onChange={(changeEvent) => update((current) => setPresentation(current, { timezone: changeEvent.target.value }))}
              className={`mt-1 ${fieldClass} disabled:bg-slate-100 disabled:text-slate-500`}
            >
              {presentation.timezone ? null : <option value="">Not set</option>}
              {TIMEZONE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-slate-500">The event&apos;s URL, publication status, visibility and registration settings are not changed here.</p>
      </fieldset>

      <div>
        <span className={labelClass}>Cover image</span>
        <p className="text-xs text-slate-500">JPG, PNG or WebP, up to 5 MB. It is uploaded now and shown on the event page once the draft is created.</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            aria-label="Upload a cover image"
            disabled={uploading}
            onChange={(changeEvent) => upload(changeEvent.target.files?.[0])}
            className="text-sm"
          />
          {presentation.coverImageUrl ? (
            <button type="button" className="text-xs font-semibold text-slate-600 underline" onClick={() => update((current) => setPresentation(current, { coverImageUrl: "" }))}>
              Remove cover image
            </button>
          ) : null}
          {presentation.coverImageUrl !== baseline.coverImageUrl && baseline.coverImageUrl ? (
            <button type="button" className="text-xs font-semibold text-slate-600 underline" onClick={() => update((current) => setPresentation(current, { coverImageUrl: baseline.coverImageUrl }))}>
              Keep the current image
            </button>
          ) : null}
        </div>
        {uploading ? <p className="mt-1 text-xs text-slate-500">Uploading…</p> : null}
        {uploadError ? <p className="mt-1 text-xs text-red-700">{uploadError}</p> : null}
      </div>

      <label className="block">
        <span className={labelClass}>Event title</span>
        <input value={presentation.name} maxLength={PRESENTATION_LIMITS.name} onChange={(changeEvent) => update((current) => setPresentation(current, { name: changeEvent.target.value }))} className={`mt-1 ${fieldClass}`} />
      </label>

      <label className="block">
        <span className={labelClass}>Short summary</span>
        <span className="block text-xs text-slate-500">One or two sentences shown under the title.</span>
        <textarea rows={2} value={presentation.summary} maxLength={PRESENTATION_LIMITS.summary} onChange={(changeEvent) => update((current) => setPresentation(current, { summary: changeEvent.target.value }))} className={`mt-1 ${fieldClass}`} />
      </label>

      <label className="block">
        <span className={labelClass}>Description</span>
        <span className="block text-xs text-slate-500">Plain text; line breaks are kept, as on every DanceFlow event page.</span>
        <textarea rows={6} value={presentation.description} maxLength={PRESENTATION_LIMITS.description} onChange={(changeEvent) => update((current) => setPresentation(current, { description: changeEvent.target.value }))} className={`mt-1 ${fieldClass}`} />
      </label>

      <div>
        <span className={labelClass}>Event highlights</span>
        <span className="block text-xs text-slate-500">Optional, up to {PRESENTATION_LIMITS.highlights}. For example: &quot;Live band for the evening session&quot;.</span>
        <div className="mt-2 space-y-2">
          {presentation.highlights.map((item, index) => (
            <div key={index} className="flex gap-2">
              <input
                value={item}
                maxLength={PRESENTATION_LIMITS.highlight}
                aria-label={`Highlight ${index + 1}`}
                onChange={(changeEvent) => update((current) => setHighlight(current, index, changeEvent.target.value))}
                className={fieldClass}
              />
              <button type="button" aria-label={`Remove highlight ${index + 1}`} className="shrink-0 rounded-lg border border-slate-300 px-3 text-sm" onClick={() => update((current) => removeHighlight(current, index))}>
                ×
              </button>
            </div>
          ))}
        </div>
        {presentation.highlights.length < PRESENTATION_LIMITS.highlights ? (
          <button type="button" className="mt-2 text-sm font-semibold text-slate-700 underline" onClick={() => update((current) => addHighlight(current))}>
            Add a highlight
          </button>
        ) : null}
      </div>

      <label className="block">
        <span className={labelClass}>Important registration information</span>
        <span className="block text-xs text-slate-500">Optional. For example deadlines, what to bring, or entry rules your event uses.</span>
        <textarea rows={4} value={presentation.registrationInfo} maxLength={PRESENTATION_LIMITS.registrationInfo} onChange={(changeEvent) => update((current) => setPresentation(current, { registrationInfo: changeEvent.target.value }))} className={`mt-1 ${fieldClass}`} />
      </label>

      <p className="text-xs text-slate-500">
        {changed.length === 0 ? "No changes to the event page yet." : `Changes to the event page when the draft is created: ${changed.length}.`} Fields you leave unchanged keep their current values.
      </p>

      <div>
        <p className={labelClass}>Preview</p>
        <p className="text-xs text-slate-500">How the event page will look. Creating the competition draft does not publish the event or open registration.</p>
        <div className="mt-2">
          <EventPagePreview presentation={presentation} summary={summary} />
        </div>
      </div>
    </div>
  );
}
