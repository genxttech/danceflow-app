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

type SlotsResponse = {
  bookingDecision?: BookingDecision;
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
  }, [lessonType, studioSlug]);

  const slots = slotsResponse?.slots ?? [];
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
      className="overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-white"
    >
      <div className="border-b border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/45 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-950">
              Book a lesson
            </h2>
            <p className="mt-1 text-xs leading-5 text-slate-600">
              Pick an open studio-approved time.
            </p>
          </div>

          <span
            className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${modeBadgeClass(bookingDecision?.mode ?? null)}`}
          >
            {modeLabel(bookingDecision?.mode ?? null)}
          </span>
        </div>
      </div>

      <div className="grid gap-3 p-4">
        <label className="text-sm font-medium text-slate-900">
          Lesson type
          <select
            value={lessonType}
            onChange={(event) => setLessonType(event.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          >
            {LESSON_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
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
            className="mt-1.5 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>

      <div className="px-4">
        {error ? (
          <p className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            {error}
          </p>
        ) : null}

        {success ? (
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
            {success}
          </p>
        ) : null}

        {bookingDecision && !bookingDecision.allowed ? (
          <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm font-medium text-amber-800">
            {bookingDecision.reason ?? "Self-service booking is not available."}
          </p>
        ) : null}
      </div>

      <div className="p-4 pt-3">
        {loading ? (
          <p className="rounded-xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/40 p-4 text-sm text-slate-600">
            Loading available times...
          </p>
        ) : slots.length ? (
          <div className="max-h-[360px] space-y-2 overflow-y-auto pr-1">
            {slots.slice(0, 12).map((slot) => {
              const key = `${slot.startsAt}|${slot.endsAt}`;
              const selected = selectedSlotKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelectedSlotKey(key)}
                  className={`w-full rounded-xl border p-3 text-left text-sm transition ${
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
          <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600">
            No available times are showing yet. Check back later or contact the studio.
          </p>
        )}
      </div>

      <div className="border-t border-[var(--brand-border)] bg-slate-50/70 p-4">
        <button
          type="button"
          onClick={submitRequest}
          disabled={!selectedSlot || isPending || bookingDecision?.allowed === false}
          className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
        >
          {isPending ? "Submitting..." : "Submit request"}
        </button>
      </div>
    </section>
  );
}
