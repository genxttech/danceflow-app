"use client";

import { useActionState } from "react";
import { createPublicIntroBookingAction } from "./actions";

const initialState = { error: "" };

export default function BookingRequestForm({
  studioSlug,
  slotStart,
  selectedSlotLabel,
  ctaText,
}: {
  studioSlug: string;
  slotStart: string;
  selectedSlotLabel: string;
  ctaText: string;
}) {
  const [state, formAction, pending] = useActionState(
    createPublicIntroBookingAction,
    initialState
  );

  return (
    <>
      <p className="mt-3 text-slate-600">
        Selected time:{" "}
        <span className="font-medium text-slate-900">{selectedSlotLabel}</span>
      </p>

      <form action={formAction} className="mt-6 space-y-4">
        <input type="hidden" name="studioSlug" value={studioSlug} />
        <input type="hidden" name="slotStart" value={slotStart} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="firstName" className="mb-1 block text-sm font-medium">
              First Name
            </label>
            <input
              id="firstName"
              name="firstName"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="lastName" className="mb-1 block text-sm font-medium">
              Last Name
            </label>
            <input
              id="lastName"
              name="lastName"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="phone" className="mb-1 block text-sm font-medium">
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div>
          <label htmlFor="danceInterests" className="mb-1 block text-sm font-medium">
            Dance Interests
          </label>
          <input
            id="danceInterests"
            name="danceInterests"
            placeholder="Two-step, ballroom, country swing..."
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            placeholder="Anything you'd like the studio to know before your intro lesson?"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="pt-2">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Booking..." : ctaText}
          </button>
        </div>
      </form>
    </>
  );
}