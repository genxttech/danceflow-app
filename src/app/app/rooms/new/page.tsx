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
    <div className="mx-auto max-w-3xl space-y-8">
      <section className="rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
              DanceFlow Rooms
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              New Room
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              Add a room or floor space so lessons, rentals, and classes can be
              scheduled in the right place.
            </p>
          </div>

          <Link
            href="/app/rooms"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Rooms
          </Link>
        </div>
      </section>

      <form action={formAction} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Room Name
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="Main Floor"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="capacity" className="mb-1 block text-sm font-medium">
            Capacity
          </label>
          <input
            id="capacity"
            name="capacity"
            type="number"
            min="0"
            placeholder="20"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Room"}
          </button>

          <Link
            href="/app/rooms"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}