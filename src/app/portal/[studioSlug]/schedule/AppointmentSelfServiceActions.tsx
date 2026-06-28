"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

type BookingSlot = {
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

type SlotsResponse = {
  slots?: BookingSlot[];
  error?: string;
  bookingDecision?: {
    allowed: boolean;
    mode: "request_only" | "approval_required" | "instant" | null;
    reason: string | null;
  };
};

type Props = {
  studioSlug: string;
  appointmentId: string;
  appointmentType: string;
  status: string;
  startsAt: string;
  studioTimeZone: string;
};

function formatDateTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function resultText(action: "reschedule" | "cancel", mode: string | null | undefined) {
  if (action === "cancel") {
    return mode === "instant"
      ? "Your lesson was cancelled."
      : "Your cancellation request was sent to the studio.";
  }

  return mode === "instant"
    ? "Your lesson was rescheduled."
    : "Your reschedule request was sent to the studio.";
}

export default function AppointmentSelfServiceActions({
  studioSlug,
  appointmentId,
  appointmentType,
  status,
  startsAt,
  studioTimeZone,
}: Props) {
  const [mode, setMode] = useState<"idle" | "reschedule" | "cancel">("idle");
  const [slotsResponse, setSlotsResponse] = useState<SlotsResponse | null>(null);
  const [selectedSlotKey, setSelectedSlotKey] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [isPending, startTransition] = useTransition();

  const canRequestChange =
    ["scheduled", "rescheduled"].includes(status) && new Date(startsAt) > new Date();

  useEffect(() => {
    if (mode !== "reschedule") return;

    let active = true;
    const controller = new AbortController();

    async function loadSlots() {
      setLoadingSlots(true);
      setError("");
      setSelectedSlotKey("");

      try {
        const params = new URLSearchParams({
          studioSlug,
          lessonType: appointmentType,
          action: "reschedule",
        });
        const response = await fetch(`/api/student/self-service/slots?${params}`, {
          signal: controller.signal,
        });
        const payload = (await response.json()) as SlotsResponse;

        if (!active) return;

        if (!response.ok) {
          setSlotsResponse(null);
          setError(payload.error ?? "Could not load reschedule times.");
          return;
        }

        setSlotsResponse(payload);
      } catch (loadError) {
        if (!active || controller.signal.aborted) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load reschedule times."
        );
      } finally {
        if (active) setLoadingSlots(false);
      }
    }

    void loadSlots();

    return () => {
      active = false;
      controller.abort();
    };
  }, [appointmentType, mode, studioSlug]);

  const slots = slotsResponse?.slots ?? [];
  const selectedSlot = useMemo(
    () => slots.find((slot) => `${slot.startsAt}|${slot.endsAt}` === selectedSlotKey),
    [selectedSlotKey, slots]
  );

  function submit(action: "reschedule" | "cancel") {
    setError("");
    setSuccess("");

    if (action === "reschedule" && !selectedSlot) {
      setError("Choose a new lesson time first.");
      return;
    }

    startTransition(async () => {
      try {
        const response = await fetch("/api/student/self-service/actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studioSlug,
            appointmentId,
            actionType: action,
            lessonType: appointmentType,
            startsAt: selectedSlot?.startsAt,
            endsAt: selectedSlot?.endsAt,
            instructorId: selectedSlot?.instructorId ?? null,
            roomId: selectedSlot?.roomId ?? null,
            reason: note,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          bookingDecision?: { mode: string | null };
        };

        if (!response.ok) {
          setError(payload.error ?? "Could not submit your request.");
          return;
        }

        setNote("");
        setSelectedSlotKey("");
        setSuccess(resultText(action, payload.bookingDecision?.mode));
        setMode("idle");
      } catch (submitError) {
        setError(
          submitError instanceof Error
            ? submitError.message
            : "Could not submit your request."
        );
      }
    });
  }

  if (!canRequestChange) return null;

  return (
    <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/30 p-4">
      <div className="mb-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--brand-primary)]">
          Lesson changes
        </p>
        <p className="mt-1 text-sm text-slate-600">
          Request a new time or cancellation based on studio policy.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setMode(mode === "reschedule" ? "idle" : "reschedule")}
          className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm ${
            mode === "reschedule"
              ? "border-[var(--brand-primary)] bg-white text-[var(--brand-primary)]"
              : "border-slate-300 bg-white text-slate-700 hover:border-[var(--brand-primary)]"
          }`}
        >
          Reschedule
        </button>
        <button
          type="button"
          onClick={() => setMode(mode === "cancel" ? "idle" : "cancel")}
          className={`rounded-xl border px-3 py-2 text-sm font-semibold shadow-sm ${
            mode === "cancel"
              ? "border-rose-300 bg-rose-50 text-rose-800"
              : "border-rose-200 bg-white text-rose-700 hover:bg-rose-50"
          }`}
        >
          Cancel
        </button>
      </div>

      {error ? (
        <p className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          {error}
        </p>
      ) : null}
      {success ? (
        <p className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700">
          {success}
        </p>
      ) : null}

      {mode !== "idle" ? (
        <div className="mt-3 space-y-3">
          {mode === "reschedule" ? (
            <div>
              {loadingSlots ? (
                <p className="text-sm text-slate-600">Loading times...</p>
              ) : slots.length ? (
                <div className="grid gap-2 md:grid-cols-2">
                  {slots.slice(0, 12).map((slot) => {
                    const key = `${slot.startsAt}|${slot.endsAt}`;
                    const selected = selectedSlotKey === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelectedSlotKey(key)}
                        className={`rounded-xl border p-3 text-left text-sm shadow-sm ${
                          selected
                            ? "border-[var(--brand-primary)] bg-white text-slate-950 ring-2 ring-[var(--brand-primary)]/10"
                            : "border-slate-200 bg-white text-slate-700 hover:border-[var(--brand-primary)]"
                        }`}
                      >
                        {formatDateTime(slot.startsAt, studioTimeZone)}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-slate-300 bg-white p-3 text-sm text-slate-600">
                  No reschedule times available.
                </p>
              )}
            </div>
          ) : null}

          <input
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Optional note for the studio"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
          />

          <button
            type="button"
            disabled={isPending || (mode === "reschedule" && !selectedSlot)}
            onClick={() => submit(mode === "cancel" ? "cancel" : "reschedule")}
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95 disabled:opacity-50"
          >
            {isPending
              ? "Submitting..."
              : mode === "cancel"
                ? "Submit cancellation"
                : "Submit reschedule"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
