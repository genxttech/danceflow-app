"use client";

import { useActionState } from "react";
import { createPublicIntroBookingAction } from "./actions";

const initialState = { error: "" };

const inputClass =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-[#EC4899] focus:ring-4 focus:ring-pink-100";

const labelClass = "mb-2 block text-sm font-semibold text-slate-800";

export default function BookingRequestForm({
  studioSlug,
  slotStart,
  slotEnd,
  instructorId,
  roomId,
  selectedSlotLabel,
  ctaText,
}: {
  studioSlug: string;
  slotStart: string;
  slotEnd: string;
  instructorId: string;
  roomId: string | null;
  selectedSlotLabel: string;
  ctaText: string;
}) {
  const [state, formAction, pending] = useActionState(
    createPublicIntroBookingAction,
    initialState
  );

  return (
    <div className="mt-5 space-y-5">
      <div className="rounded-2xl border border-pink-100 bg-pink-50/70 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#BE185D]">
          Selected request time
        </p>
        <p className="mt-1 text-base font-semibold text-slate-950">{selectedSlotLabel}</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          This time will be sent to the studio for review before it becomes a confirmed appointment.
        </p>
      </div>

      <form action={formAction} className="space-y-5">
        <input type="hidden" name="studioSlug" value={studioSlug} />
        <input type="hidden" name="slotStart" value={slotStart} />
        <input type="hidden" name="slotEnd" value={slotEnd} />
        <input type="hidden" name="instructorId" value={instructorId} />
        <input type="hidden" name="roomId" value={roomId ?? ""} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="firstName" className={labelClass}>
              First name
            </label>
            <input
              id="firstName"
              name="firstName"
              required
              autoComplete="given-name"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="lastName" className={labelClass}>
              Last name
            </label>
            <input
              id="lastName"
              name="lastName"
              required
              autoComplete="family-name"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className={inputClass}
            />
          </div>

          <div>
            <label htmlFor="phone" className={labelClass}>
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              className={inputClass}
            />
          </div>
        </div>

        <div>
          <label htmlFor="danceInterests" className={labelClass}>
            Dance interests
          </label>
          <input
            id="danceInterests"
            name="danceInterests"
            placeholder="Two-step, ballroom, country swing..."
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor="notes" className={labelClass}>
            Notes for the studio
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Anything you'd like the studio to know before your intro lesson?"
            className={inputClass}
          />
        </div>

        {state?.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-5 text-slate-500">
            By submitting, you are asking the studio to review this requested time and contact you with confirmation.
          </p>
          <button
            type="submit"
            disabled={pending}
            className="inline-flex items-center justify-center rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-slate-300/60 transition hover:-translate-y-0.5 hover:bg-slate-800 disabled:translate-y-0 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {pending ? "Sending request..." : ctaText}
          </button>
        </div>
      </form>
    </div>
  );
}
