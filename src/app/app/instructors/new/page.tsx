"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createInstructorAction } from "../actions";

const initialState = { error: "" };

export default function NewInstructorPage() {
  const [state, formAction, pending] = useActionState(
    createInstructorAction,
    initialState
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <section className="rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
              DanceFlow Staff
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              New Instructor
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              Add an instructor profile so they can appear on schedules,
              lessons, and studio workflows.
            </p>
          </div>

          <Link
            href="/app/instructors"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Instructors
          </Link>
        </div>
      </section>

      <form action={formAction} className="space-y-4 rounded-2xl border bg-white p-6 shadow-sm">
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


        <details className="rounded-2xl border border-violet-100 bg-violet-50/50 p-4" open>
          <summary className="cursor-pointer text-sm font-semibold text-slate-950">
            Public Staff Profile
          </summary>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Optional. Turn this on when you want this instructor to appear on the public studio Staff tab.
          </p>

          <div className="mt-4 flex items-start gap-3 rounded-xl border border-white bg-white p-3">
            <input
              id="publicProfileEnabled"
              name="publicProfileEnabled"
              type="checkbox"
              value="true"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-violet-700"
            />
            <div>
              <label htmlFor="publicProfileEnabled" className="text-sm font-semibold text-slate-950">
                Show this instructor on the public studio page
              </label>
              <p className="mt-1 text-xs leading-5 text-slate-500">
                Public profiles only show when this is checked and the instructor is active.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="publicTitle" className="mb-1 block text-sm font-medium">
                Public Title / Role
              </label>
              <input
                id="publicTitle"
                name="publicTitle"
                placeholder="Owner, Instructor, Coach"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div>
              <label htmlFor="publicPhotoUrl" className="mb-1 block text-sm font-medium">
                Headshot URL
              </label>
              <input
                id="publicPhotoUrl"
                name="publicPhotoUrl"
                type="url"
                placeholder="https://..."
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="publicSpecialties" className="mb-1 block text-sm font-medium">
                Public Specialties
              </label>
              <input
                id="publicSpecialties"
                name="publicSpecialties"
                placeholder="Country Two Step, Ballroom, Wedding Dance"
                className="w-full rounded-xl border border-slate-300 px-3 py-2"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="yearsExperience" className="mb-1 block text-sm font-medium">
                  Years Experience
                </label>
                <input
                  id="yearsExperience"
                  name="yearsExperience"
                  type="number"
                  min="0"
                  step="1"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="displayOrder" className="mb-1 block text-sm font-medium">
                  Display Order
                </label>
                <input
                  id="displayOrder"
                  name="displayOrder"
                  type="number"
                  min="0"
                  step="1"
                  defaultValue="0"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
            </div>
          </div>

          <div className="mt-4">
            <label htmlFor="publicBio" className="mb-1 block text-sm font-medium">
              Public Bio
            </label>
            <textarea
              id="publicBio"
              name="publicBio"
              rows={4}
              placeholder="Short public-facing bio for the studio Staff tab."
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </details>

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

          <Link
            href="/app/instructors"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}