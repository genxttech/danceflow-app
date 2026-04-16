"use client";

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

export default function InstructorEditForm({
  instructor,
}: {
  instructor: InstructorRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updateInstructorAction,
    initialState
  );

  return (
    <div className="max-w-2xl">
      <h2 className="text-3xl font-semibold tracking-tight">Edit Instructor</h2>
      <p className="mt-2 text-slate-600">Update instructor details.</p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
        <input type="hidden" name="instructorId" value={instructor.id} />

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="firstName" className="mb-1 block text-sm font-medium">
              First Name
            </label>
            <input
              id="firstName"
              name="firstName"
              defaultValue={instructor.first_name}
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
              defaultValue={instructor.last_name}
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
              defaultValue={instructor.email ?? ""}
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
              defaultValue={instructor.phone ?? ""}
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
            defaultValue={instructor.specialties ?? ""}
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
            defaultValue={instructor.bio ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="active" className="mb-1 block text-sm font-medium">
            Status
          </label>
          <select
            id="active"
            name="active"
            defaultValue={instructor.active ? "true" : "false"}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>
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
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/instructors/${instructor.id}`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}