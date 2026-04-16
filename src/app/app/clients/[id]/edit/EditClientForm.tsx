"use client";

import { useActionState } from "react";
import { updateClientAction } from "../../actions";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
} from "@/lib/forms/options";

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  skill_level: string | null;
  dance_interests: string | null;
  referral_source: string | null;
  notes: string | null;
  is_independent_instructor: boolean | null;
  linked_instructor_id: string | null;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
  active: boolean;
};

const initialState = { error: "" };

export default function EditClientForm({
  client,
  instructors,
}: {
  client: ClientRow;
  instructors: InstructorOption[];
}) {
  const [state, formAction, pending] = useActionState(
    updateClientAction,
    initialState
  );

  return (
    <form action={formAction} className="rounded-2xl border bg-white p-6 shadow-sm">
      <input type="hidden" name="clientId" value={client.id} />

      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <label htmlFor="firstName" className="mb-1 block text-sm font-medium">
            First Name
          </label>
          <input
            id="firstName"
            name="firstName"
            required
            defaultValue={client.first_name}
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
            defaultValue={client.last_name}
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
            defaultValue={client.email ?? ""}
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
            defaultValue={client.phone ?? ""}
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
            defaultValue={client.status}
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
            defaultValue={client.skill_level ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Select skill level</option>
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
            defaultValue={client.dance_interests ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="md:col-span-2">
          <label htmlFor="referralSource" className="mb-1 block text-sm font-medium">
            Referral Source
          </label>
          <select
            id="referralSource"
            name="referralSource"
            defaultValue={client.referral_source ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Select referral source</option>
            {CLIENT_REFERRAL_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            defaultValue={client.notes ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>
      </div>

      <div className="mt-6 space-y-4 rounded-2xl border bg-slate-50 p-4">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="isIndependentInstructor"
            defaultChecked={!!client.is_independent_instructor}
            className="mt-1"
          />
          <div>
            <p className="font-medium text-slate-900">
              Independent Instructor
            </p>
            <p className="mt-1 text-sm text-slate-600">
              Enable this only if this client should use independent instructor / floor rental workflows.
            </p>
          </div>
        </label>

        <div>
          <label htmlFor="linkedInstructorId" className="mb-1 block text-sm font-medium">
            Linked Instructor Profile
          </label>
          <select
            id="linkedInstructorId"
            name="linkedInstructorId"
            defaultValue={client.linked_instructor_id ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">No linked instructor</option>
            {instructors.map((instructor) => (
              <option key={instructor.id} value={instructor.id}>
                {instructor.first_name} {instructor.last_name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Optional. Use when this client is also represented in the instructors table.
          </p>
        </div>
      </div>

      {state.error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save Client"}
        </button>
      </div>
    </form>
  );
}