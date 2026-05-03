"use client";

import Link from "next/link";
import { useActionState } from "react";
import { updateInstructorAction } from "../../actions";

const initialState = { error: "" };

type InstructorRecord = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  specialties: string | null;
  bio: string | null;
  active: boolean;
};

function RequiredMark() {
  return <span className="ml-1 text-red-600">*</span>;
}

export default function InstructorEditForm({
  instructor,
}: {
  instructor: InstructorRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updateInstructorAction,
    initialState
  );

  const instructorName = `${instructor.first_name} ${instructor.last_name}`.trim();

  return (
    <div className="max-w-5xl space-y-8">
      <section className="overflow-hidden rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800 shadow-sm">
        <div className="p-6 text-white md:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-start md:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">
                DanceFlow Instructor Setup
              </p>
              <h1 className="mt-3 text-3xl font-bold tracking-tight md:text-4xl">
                Edit {instructorName || "Instructor"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-200 md:text-base">
                Keep instructor details accurate so staff can schedule lessons, assign classes,
                manage floor rentals, and support instructor workflows without extra clicks.
              </p>
            </div>

            <div className="flex flex-wrap gap-3 md:justify-end">
              <Link
                href={`/app/instructors/${instructor.id}`}
                className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm hover:bg-slate-100"
              >
                View Profile
              </Link>
              <Link
                href="/app/instructors"
                className="rounded-2xl border border-white/25 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10"
              >
                Back to Instructors
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-2 border-b border-slate-100 pb-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-cyan-700">
              Instructor Details
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
              Profile information
            </h2>
          </div>
          <p className="max-w-xl text-sm text-slate-600">
            Fields marked with <span className="font-semibold text-red-600">*</span> are required.
            Use specialties to describe what this instructor teaches or handles most often.
          </p>
        </div>

        <form action={formAction} className="mt-6 space-y-6">
          <input type="hidden" name="instructorId" value={instructor.id} />

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="firstName"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                First Name <RequiredMark />
              </label>
              <input
                id="firstName"
                name="firstName"
                defaultValue={instructor.first_name}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>

            <div>
              <label
                htmlFor="lastName"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Last Name <RequiredMark />
              </label>
              <input
                id="lastName"
                name="lastName"
                defaultValue={instructor.last_name}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label
                htmlFor="email"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={instructor.email ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>

            <div>
              <label
                htmlFor="phone"
                className="mb-1 block text-sm font-semibold text-slate-800"
              >
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                defaultValue={instructor.phone ?? ""}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="specialties"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Specialties
            </label>
            <input
              id="specialties"
              name="specialties"
              defaultValue={instructor.specialties ?? ""}
              placeholder="Example: Two Step, Ballroom, coaching, floor rentals"
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            />
            <p className="mt-2 text-sm text-slate-500">
              Add practical teaching focus areas so staff can match the right instructor to the right lesson or class.
            </p>
          </div>

          <div>
            <label
              htmlFor="bio"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Bio
            </label>
            <textarea
              id="bio"
              name="bio"
              rows={5}
              defaultValue={instructor.bio ?? ""}
              placeholder="Add a short instructor bio, teaching background, or notes staff should know."
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            />
          </div>

          <div>
            <label
              htmlFor="active"
              className="mb-1 block text-sm font-semibold text-slate-800"
            >
              Status <RequiredMark />
            </label>
            <select
              id="active"
              name="active"
              defaultValue={instructor.active ? "true" : "false"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2 text-slate-950 shadow-sm outline-none focus:border-cyan-600 focus:ring-2 focus:ring-cyan-100"
            >
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
            <p className="mt-2 text-sm text-slate-500">
              Set inactive when this instructor should no longer appear in active scheduling workflows.
            </p>
          </div>

          {state?.error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
              {state.error}
            </div>
          ) : null}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-6 sm:flex-row">
            <button
              type="submit"
              disabled={pending}
              className="rounded-2xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "Saving..." : "Save Changes"}
            </button>

            <Link
              href={`/app/instructors/${instructor.id}`}
              className="rounded-2xl border border-slate-200 px-5 py-2.5 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Link>
          </div>
        </form>
      </section>
    </div>
  );
}
