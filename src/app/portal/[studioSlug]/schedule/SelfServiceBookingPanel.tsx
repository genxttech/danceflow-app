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

function formatSlotTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
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
  if (mode === "instant") {
    return "Your lesson was booked.";
  }
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
  const selectedSlot = useMemo(
    () => slots.find((slot) => `${slot.startsAt}|${slot.endsAt}` === selectedSlotKey),
    [selectedSlotKey, slots]
  );

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
      <div className="border-b border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--brand-primary-soft)_0%,#ffffff_72%)] p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-700">
              Self-service booking
            </p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">
              Find a lesson time
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Choose an available studio-approved window and send it to the studio.
            </p>
          </div>

          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold ${modeBadgeClass(bookingDecision?.mode ?? null)}`}
          >
            {modeLabel(bookingDecision?.mode ?? null)}
          </span>
        </div>
      </div>

      <div className="grid gap-4 p-5 md:grid-cols-3 md:p-6">
        <label className="text-sm font-medium text-slate-900">
          Lesson type
          <select
            value={lessonType}
            onChange={(event) => {
              setLessonType(event.target.value);
              setSelectedSlotKey("");
            }}
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
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
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
          >
            <option value="">Choose an instructor</option>
            {instructors.map((instructor) => (
              <option key={instructor.id} value={instructor.id}>
                {instructor.name}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm font-medium text-slate-900">
          Optional note
          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Anything the studio should know?"
            className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="px-5 md:px-6">
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
      </div>

      <div className="p-5 pt-4 md:p-6 md:pt-5">
        {loading ? (
          <p className="rounded-2xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/40 p-5 text-sm text-slate-600">
            Loading available times...
          </p>
        ) : !selectedInstructorId ? (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
            Choose an instructor to see their available lesson times.
          </p>
        ) : slots.length ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {slots.slice(0, 24).map((slot) => {
              const key = `${slot.startsAt}|${slot.endsAt}`;
              const selected = selectedSlotKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedSlotKey(key)}
                  className={`rounded-2xl border p-4 text-left text-sm shadow-sm transition ${
                    selected
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] text-slate-950 ring-2 ring-[var(--brand-primary)]/10"
                      : "border-slate-200 bg-white text-slate-700 hover:border-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]/35"
                  }`}
                >
                  <span className="block font-semibold">{formatSlotTime(slot.startsAt, studioTimeZone)}</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    Ends {formatSlotTime(slot.endsAt, studioTimeZone)}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5 text-sm text-slate-600">
            No available times are showing yet. Check back later or contact the studio.
          </p>
        )}
      </div>

      <div className="flex justify-end border-t border-[var(--brand-border)] bg-slate-50/70 p-5 md:p-6">
        <button
          type="button"
          onClick={submitRequest}
          disabled={!selectedSlot || isPending || bookingDecision?.allowed === false}
          className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
        >
          {isPending ? "Submitting..." : "Submit request"}
        </button>
      </div>
    </section>
  );
}
