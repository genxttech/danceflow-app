"use client";

import { useActionState } from "react";
import Link from "next/link";
import { createClientAction } from "../actions";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
} from "@/lib/forms/options";

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type ActionState = {
  error: string;
};

const initialState: ActionState = {
  error: "",
};

export default function ClientCreateForm({
  instructors,
}: {
  instructors: InstructorOption[];
}) {
  const [state, formAction, pending] = useActionState(
    createClientAction,
    initialState
  );

  return (
    <form action={formAction} className="space-y-8 rounded-2xl border bg-white p-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">New Client</h2>
        <p className="mt-1 text-sm text-slate-600">
          Create a standard client record or mark the person as an independent
          instructor with limited floor-rental access.
        </p>
      </div>

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

        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium">
            Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue="lead"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            {CLIENT_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="skillLevel" className="mb-1 block text-sm font-medium">
            Skill Level
          </label>
          <select
            id="skillLevel"
            name="skillLevel"
            defaultValue=""
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Not set</option>
            {CLIENT_SKILL_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label htmlFor="danceInterests" className="mb-1 block text-sm font-medium">
            Dance Interests
          </label>
          <input
            id="danceInterests"
            name="danceInterests"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Ballroom, Country, Wedding dance..."
          />
        </div>

        <div className="md:col-span-2">
          <label htmlFor="referralSource" className="mb-1 block text-sm font-medium">
            Referral Source
          </label>
          <select
            id="referralSource"
            name="referralSource"
            defaultValue=""
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Not set</option>
            {CLIENT_REFERRAL_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
        <h3 className="text-lg font-semibold text-indigo-900">
          Independent Instructor Access
        </h3>
        <p className="mt-1 text-sm text-indigo-800">
          Use this when the person is primarily a client/contact, but should also
          be treated as an independent instructor for rentals and future limited
          portal access.
        </p>

        <div className="mt-5 space-y-4">
          <label className="flex items-start gap-3 rounded-xl border bg-white p-4">
            <input
              type="checkbox"
              name="isIndependentInstructor"
              className="mt-1"
            />
            <div>
              <p className="font-medium text-slate-900">
                Mark this client as an independent instructor
              </p>
              <p className="mt-1 text-sm text-slate-600">
                This enables independent-instructor settings and keeps the record
                ready for restricted instructor workflows.
              </p>
            </div>
          </label>

          <div>
            <label
              htmlFor="linkedInstructorId"
              className="mb-1 block text-sm font-medium text-slate-900"
            >
              Linked Instructor Profile
            </label>
            <select
              id="linkedInstructorId"
              name="linkedInstructorId"
              defaultValue=""
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">No linked instructor</option>
              {instructors.map((instructor) => (
                <option key={instructor.id} value={instructor.id}>
                  {instructor.first_name} {instructor.last_name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Optional. Link this client to an existing instructor profile for future
              scheduling and portal-role handoff.
            </p>
          </div>
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="mb-1 block text-sm font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={5}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      {state.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Creating..." : "Create Client"}
        </button>

        <Link
          href="/app/clients"
          className="rounded-xl border px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}