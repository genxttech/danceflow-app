"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createRoomAction } from "../actions";

const initialState = { error: "" };

export default function NewRoomPage() {
  const [state, formAction, pending] = useActionState(
    createRoomAction,
    initialState
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_26%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Studio Setup
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Add a Room
              </h1>
              <p className="mt-3 text-sm leading-7 text-white/85 md:text-base">
                Create a room, dance floor, or rentable space so your team can schedule lessons,
                classes, and rentals in the right location.
              </p>
            </div>

            <Link
              href="/app/rooms"
              className="inline-flex items-center justify-center rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              Back to Rooms
            </Link>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="text-sm font-medium text-slate-950">Tip</p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Use names staff already say out loud, such as “Main Floor,” “Studio B,” or
              “Small Ballroom.” Capacity is optional, but helpful for classes and rentals.
            </p>
          </div>
        </div>
      </section>

      <form action={formAction} className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm md:p-8">
        <div>
          <h2 className="text-xl font-semibold text-slate-950">Room details</h2>
          <p className="mt-1 text-sm leading-6 text-slate-500">
            These details are used internally by your team.
          </p>
        </div>

        <div className="mt-6 grid gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="name" className="mb-2 block text-sm font-medium text-slate-700">
              Room name
            </label>
            <input
              id="name"
              name="name"
              required
              placeholder="Main Floor"
              className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
            />
          </div>

          <div>
            <label htmlFor="capacity" className="mb-2 block text-sm font-medium text-slate-700">
              Capacity
            </label>
            <input
              id="capacity"
              name="capacity"
              type="number"
              min="0"
              placeholder="20"
              className="w-full rounded-2xl border border-slate-300 px-4 py-3 text-sm outline-none transition focus:border-slate-400"
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Optional. Use the comfortable class or rental capacity.
            </p>
          </div>
        </div>

        {state?.error ? (
          <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="mt-8 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Link
            href="/app/rooms"
            className="inline-flex justify-center rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>

          <button
            type="submit"
            disabled={pending}
            className="inline-flex justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Room"}
          </button>
        </div>
      </form>
    </div>
  );
}
