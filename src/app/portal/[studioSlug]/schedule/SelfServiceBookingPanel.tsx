"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

type BookingDecision = {
  allowed: boolean;
  mode: "request_only" | "approval_required" | "instant" | null;
  reason: string | null;
};

type BookingSlot = {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

type InstructorOption = {
  id: string;
  name: string;
};

type SlotsResponse = {
  bookingDecision?: BookingDecision;
  instructors?: InstructorOption[];
  slots?: BookingSlot[];
  error?: string;
};

const LESSON_TYPES = [
  ["private_lesson", "Private Lesson"],
  ["coaching", "Coaching"],
  ["practice_party", "Practice Party"],
  ["group_class", "Group Class"],
];

function dateKeyToUtcDate(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function addDays(dateKey: string, days: number) {
  const date = dateKeyToUtcDate(dateKey);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDayName(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(dateKeyToUtcDate(dateKey));
}

function formatDayNumber(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    day: "numeric",
  }).format(dateKeyToUtcDate(dateKey));
}

function formatMonthDay(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  }).format(dateKeyToUtcDate(dateKey));
}

function formatLongDate(dateKey: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(dateKeyToUtcDate(dateKey));
}

function formatTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function modeLabel(mode: BookingDecision["mode"]) {
  if (mode === "instant") return "Instant booking";
  if (mode === "approval_required") return "Approval required";
  if (mode === "request_only") return "Request only";
  return "Unavailable";
}

function modeBadgeClass(mode: BookingDecision["mode"]) {
  if (mode === "instant") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (mode === "approval_required") {
    return "border-amber-200 bg-amber-50 text-amber-800";
  }
  if (mode === "request_only") {
    return "border-[var(--brand-border)] bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function successMessage(mode: BookingDecision["mode"]) {
  if (mode === "instant") return "Your lesson was booked.";
  if (mode === "approval_required") {
    return "Your lesson request was sent for studio approval.";
  }
  return "Your schedule request was sent to the studio.";
}

export default function SelfServiceBookingPanel({
  studioSlug,
  studioTimeZone,
}: {
  studioSlug: string;
  studioTimeZone: string;
}) {
  const [lessonType, setLessonType] = useState("private_lesson");
  const [selectedInstructorId, setSelectedInstructorId] = useState("");
  const [slotsResponse, setSlotsResponse] = useState<SlotsResponse | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [visibleStartDate, setVisibleStartDate] = useState("");
  const [selectedSlotKey, setSelectedSlotKey] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function loadSlots() {
      setLoading(true);
      setError("");
      setSuccess("");
      setSelectedSlotKey("");
      setSelectedDate("");
      setVisibleStartDate("");

      try {
        const params = new URLSearchParams({
          studioSlug,
          lessonType,
        });

        if (selectedInstructorId) {
          params.set("instructorId", selectedInstructorId);
        }

        const response = await fetch(`/api/student/self-service/slots?${params}`, {
          signal: controller.signal,
        });
        const payload = (await response.json()) as SlotsResponse;

        if (!active) return;

        if (!response.ok) {
          setSlotsResponse(null);
          setError(payload.error ?? "Could not load available lesson times.");
          return;
        }

        setSlotsResponse(payload);
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setSlotsResponse(null);
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load available lesson times."
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadSlots();

    return () => {
      active = false;
      controller.abort();
    };
  }, [lessonType, selectedInstructorId, studioSlug]);

  const slots = slotsResponse?.slots ?? [];
  const instructors = slotsResponse?.instructors ?? [];
  const bookingDecision = slotsResponse?.bookingDecision ?? null;

  const slotsByDate = useMemo(() => {
    const grouped = new Map<string, BookingSlot[]>();

    for (const slot of slots) {
      const dateSlots = grouped.get(slot.date) ?? [];
      dateSlots.push(slot);
      grouped.set(slot.date, dateSlots);
    }

    for (const dateSlots of grouped.values()) {
      dateSlots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    }

    return grouped;
  }, [slots]);

  const availableDates = useMemo(
    () => Array.from(slotsByDate.keys()).sort(),
    [slotsByDate]
  );

  useEffect(() => {
    if (!availableDates.length) {
      setSelectedDate("");
      setVisibleStartDate("");
      return;
    }

    setSelectedDate((current) =>
      current && slotsByDate.has(current) ? current : availableDates[0]
    );
    setVisibleStartDate((current) => current || availableDates[0]);
  }, [availableDates, slotsByDate]);

  const visibleDates = useMemo(() => {
    if (!visibleStartDate) return [];
    return Array.from({ length: 7 }, (_, index) =>
      addDays(visibleStartDate, index)
    );
  }, [visibleStartDate]);

  const selectedDateSlots = selectedDate
    ? slotsByDate.get(selectedDate) ?? []
    : [];

  const selectedSlot = useMemo(
    () => slots.find((slot) => `${slot.startsAt}|${slot.endsAt}` === selectedSlotKey),
    [selectedSlotKey, slots]
  );

  function moveDateWindow(days: number) {
    setVisibleStartDate((current) => (current ? addDays(current, days) : current));
  }

  function submitRequest() {
    setError("");
    setSuccess("");

    if (!selectedSlot) {
      setError("Choose a lesson time first.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch("/api/student/self-service/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studioSlug,
            actionType: "book",
            lessonType,
            startsAt: selectedSlot.startsAt,
            endsAt: selectedSlot.endsAt,
            instructorId: selectedSlot.instructorId,
            roomId: selectedSlot.roomId,
            reason: note,
          }),
        });
        const payload = (await response.json()) as { error?: string };

        if (!response.ok) {
          setError(payload.error ?? "Could not submit your booking request.");
          return;
        }

        setSelectedSlotKey("");
        setNote("");
        setSuccess(successMessage(bookingDecision?.mode ?? null));
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Could not submit your booking request."
        );
      }
    });
  }

  return (
    <section
      id="self-service-booking"
      className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm ring-1 ring-black/[0.02]"
    >
      <div className="border-b border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--brand-primary-soft)_0%,#ffffff_72%)] p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
              Self-service booking
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              Request a lesson
            </h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Choose a lesson type, instructor, date, and available time.
            </p>
          </div>

          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${modeBadgeClass(
              bookingDecision?.mode ?? null
            )}`}
          >
            {modeLabel(bookingDecision?.mode ?? null)}
          </span>
        </div>
      </div>

      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-900">
            Lesson type
            <select
              value={lessonType}
              onChange={(event) => {
                setLessonType(event.target.value);
                setSelectedSlotKey("");
              }}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
            >
              {LESSON_TYPES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm font-medium text-slate-900">
            Instructor
            <select
              value={selectedInstructorId}
              onChange={(event) => {
                setSelectedInstructorId(event.target.value);
                setSelectedSlotKey("");
              }}
              className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5"
            >
              <option value="">Choose an instructor</option>
              {instructors.map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructor.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error ? (
          <p className="rounded-2xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            {error}
          </p>
        ) : null}

        {success ? (
          <p className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
            {success}
          </p>
        ) : null}

        {bookingDecision && !bookingDecision.allowed ? (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
            {bookingDecision.reason ?? "Self-service booking is not available."}
          </p>
        ) : null}

        {loading ? (
          <p className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/40 p-5 text-sm text-slate-600">
            Loading available times...
          </p>
        ) : !selectedInstructorId ? (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
            Choose an instructor to see available dates and times.
          </p>
        ) : availableDates.length ? (
          <>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Choose a date
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {visibleDates.length
                      ? `${formatMonthDay(visibleDates[0])} – ${formatMonthDay(
                          visibleDates[visibleDates.length - 1]
                        )}`
                      : "Available dates"}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => moveDateWindow(-7)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-lg text-slate-700 hover:border-[var(--brand-primary)]"
                    aria-label="Previous week"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    onClick={() => moveDateWindow(7)}
                    className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-lg text-slate-700 hover:border-[var(--brand-primary)]"
                    aria-label="Next week"
                  >
                    ›
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1.5">
                {visibleDates.map((dateKey) => {
                  const hasSlots = slotsByDate.has(dateKey);
                  const selected = selectedDate === dateKey;

                  return (
                    <button
                      key={dateKey}
                      type="button"
                      disabled={!hasSlots}
                      onClick={() => {
                        setSelectedDate(dateKey);
                        setSelectedSlotKey("");
                      }}
                      className={`rounded-xl border px-1 py-2 text-center transition ${
                        selected
                          ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white shadow-sm"
                          : hasSlots
                            ? "border-slate-200 bg-white text-slate-800 hover:border-[var(--brand-primary)]"
                            : "border-transparent bg-transparent text-slate-300"
                      }`}
                    >
                      <span className="block text-[10px] font-semibold uppercase tracking-wide">
                        {formatDayName(dateKey)}
                      </span>
                      <span className="mt-1 block text-base font-semibold">
                        {formatDayNumber(dateKey)}
                      </span>
                      {hasSlots ? (
                        <span
                          className={`mx-auto mt-1 block h-1.5 w-1.5 rounded-full ${
                            selected ? "bg-white" : "bg-[var(--brand-accent-dark)]"
                          }`}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="mb-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Available times
                </p>
                <h3 className="mt-1 text-base font-semibold text-slate-950">
                  {selectedDate ? formatLongDate(selectedDate) : "Choose a date"}
                </h3>
              </div>

              {selectedDateSlots.length ? (
                <div className="flex flex-wrap gap-2">
                  {selectedDateSlots.map((slot) => {
                    const key = `${slot.startsAt}|${slot.endsAt}`;
                    const selected = selectedSlotKey === key;

                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedSlotKey(key)}
                        className={`rounded-xl border px-3 py-2.5 text-sm font-semibold transition ${
                          selected
                            ? "border-[var(--brand-primary)] bg-[var(--brand-primary)] text-white shadow-sm"
                            : "border-slate-300 bg-white text-slate-700 hover:border-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]/35"
                        }`}
                      >
                        {formatTime(slot.startsAt, studioTimeZone)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
                  No available times on this date.
                </p>
              )}
            </div>
          </>
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
            No available times are showing yet. Check back later or contact the studio.
          </p>
        )}

        {selectedSlot ? (
          <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
              Selected lesson time
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-950">
              {formatLongDate(selectedSlot.date)} at{" "}
              {formatTime(selectedSlot.startsAt, studioTimeZone)}
            </p>
            <p className="mt-1 text-xs text-slate-600">
              Ends at {formatTime(selectedSlot.endsAt, studioTimeZone)}
            </p>
          </div>
        ) : null}

        <label className="block text-sm font-medium text-slate-900">
          Optional note
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Anything the studio should know?"
            rows={3}
            className="mt-2 w-full resize-none rounded-xl border border-slate-300 bg-white px-3 py-2.5"
          />
        </label>
      </div>

      <div className="flex justify-end border-t border-[var(--brand-border)] bg-slate-50/70 p-5">
        <button
          type="button"
          onClick={submitRequest}
          disabled={!selectedSlot || isPending || bookingDecision?.allowed === false}
          className="w-full rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50 sm:w-auto"
        >
          {isPending ? "Submitting..." : "Submit request"}
        </button>
      </div>
    </section>
  );
}