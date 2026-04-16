"use client";

import { useActionState } from "react";
import { createInstructorAction } from "../actions";

const initialState = { error: "" };

export default function NewInstructorPage() {
  const [state, formAction, pending] = useActionState(
    createInstructorAction,
    initialState
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-tight">New Instructor</h2>
      <p className="mt-2 text-slate-600">Add a new instructor to your studio.</p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
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
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
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
          <label htmlFor="specialties" className="mb-1 block text-sm font-medium">
            Specialties
          </label>
          <input
            id="specialties"
            name="specialties"
            placeholder="Country, Ballroom, Wedding Dance"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="bio" className="mb-1 block text-sm font-medium">
            Bio
          </label>
          <textarea
            id="bio"
            name="bio"
            rows={5}
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
            {pending ? "Saving..." : "Save Instructor"}
          </button>

          <a
            href="/app/instructors"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}