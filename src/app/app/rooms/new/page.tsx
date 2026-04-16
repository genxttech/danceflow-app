"use client";

import { useActionState } from "react";
import { createRoomAction } from "../actions";

const initialState = { error: "" };

export default function NewRoomPage() {
  const [state, formAction, pending] = useActionState(
    createRoomAction,
    initialState
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-tight">New Room</h2>
      <p className="mt-2 text-slate-600">Add a new room to your studio.</p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
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

          <a
            href="/app/rooms"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}