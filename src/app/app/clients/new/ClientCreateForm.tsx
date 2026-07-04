"use client";

import { useActionState, useState } from "react";
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

const DANCE_STYLE_GROUPS = [
  {
    label: "American Smooth",
    options: [
      "American Smooth",
      "American Smooth - Waltz",
      "American Smooth - Tango",
      "American Smooth - Foxtrot",
      "American Smooth - Viennese Waltz",
    ],
  },
  {
    label: "American Rhythm",
    options: [
      "American Rhythm",
      "American Rhythm - Cha Cha",
      "American Rhythm - Rumba",
      "American Rhythm - East Coast Swing",
      "American Rhythm - Bolero",
      "American Rhythm - Mambo",
    ],
  },
  {
    label: "International Ballroom",
    options: [
      "International Ballroom",
      "International Ballroom - Waltz",
      "International Ballroom - Tango",
      "International Ballroom - Viennese Waltz",
      "International Ballroom - Foxtrot",
      "International Ballroom - Quickstep",
    ],
  },
  {
    label: "International Latin",
    options: [
      "International Latin",
      "International Latin - Cha Cha",
      "International Latin - Samba",
      "International Latin - Rumba",
      "International Latin - Paso Doble",
      "International Latin - Jive",
    ],
  },
  {
    label: "Country",
    options: [
      "Country",
      "Country - Two Step",
      "Country - West Coast Swing",
      "Country - Nightclub Two Step",
      "Country - Waltz",
      "Country - Polka",
    ],
  },
  {
    label: "Social / Club",
    options: [
      "Social / Club",
      "Social / Club - Salsa",
      "Social / Club - Bachata",
      "Social / Club - Merengue",
      "Social / Club - Hustle",
      "Social / Club - Argentine Tango",
    ],
  },
];

const DANCE_GOALS = [
  "Social dancing",
  "Practice partner",
  "Wedding dance",
  "Date night",
  "Showcase",
  "Competition",
  "Confidence",
  "Fitness",
  "New hobby",
  "Meet people",
  "Improve technique",
  "Prepare for an event",
];

function CheckboxGroup({
  name,
  groups,
}: {
  name: string;
  groups: { label: string; options: string[] }[];
}) {
  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={`${name}-${group.label}`} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-semibold text-slate-900">{group.label}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.options.map((option) => (
              <label key={`${name}-${group.label}-${option}`} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-slate-700">
                <input type="checkbox" name={name} value={option} className="h-4 w-4 rounded border-slate-300" />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function GoalCheckboxes({ name }: { name: string }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {DANCE_GOALS.map((goal) => (
        <label key={`${name}-${goal}`} className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <input type="checkbox" name={name} value={goal} className="h-4 w-4 rounded border-slate-300" />
          <span>{goal}</span>
        </label>
      ))}
    </div>
  );
}

export default function ClientCreateForm({
  instructors,
}: {
  instructors: InstructorOption[];
}) {
  const [state, formAction, pending] = useActionState(
    createClientAction,
    initialState
  );
  const [includePartner, setIncludePartner] = useState(false);

  return (
    <form action={formAction} encType="multipart/form-data" className="space-y-8 rounded-2xl border bg-white p-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">New Client</h2>
        <p className="mt-1 text-sm text-slate-600">
          Create a standard client record or mark the person as an independent
          instructor with limited floor-rental access.
        </p>
      </div>

      <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
        <label htmlFor="clientPhoto" className="block text-sm font-semibold text-slate-800">
          Client headshot
        </label>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Choose an existing photo or take a new one, depending on your device. This helps staff verify the client during check-ins and future QR workflows.
        </p>
        <input
          id="clientPhoto"
          name="clientPhoto"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="mt-3 block w-full text-sm text-slate-700 file:mr-4 file:rounded-xl file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
        />
        <p className="mt-2 text-xs text-slate-500">JPG, PNG, or WebP up to 5MB.</p>
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
          <p className="mb-1 text-sm font-medium">Dance Styles</p>
          <p className="mb-3 text-xs text-slate-500">
            Select style categories and any specific dances they want to learn.
          </p>
          <CheckboxGroup name="danceStyles" groups={DANCE_STYLE_GROUPS} />
        </div>

        <div className="md:col-span-2">
          <p className="mb-1 text-sm font-medium">Dance Goals</p>
          <p className="mb-3 text-xs text-slate-500">
            Select why they are coming in for lessons.
          </p>
          <GoalCheckboxes name="danceGoals" />
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

      <div className="rounded-2xl border border-purple-200 bg-purple-50 p-5">
        <h3 className="text-lg font-semibold text-purple-950">
          Optional Partner
        </h3>
        <p className="mt-1 text-sm text-purple-900">
          Create and link a second client record when a couple comes in together.
        </p>

        <label className="mt-5 flex items-start gap-3 rounded-xl border bg-white p-4">
          <input
            type="checkbox"
            name="createPartner"
            checked={includePartner}
            onChange={(event) => setIncludePartner(event.target.checked)}
            className="mt-1"
          />
          <div>
            <p className="font-medium text-slate-900">
              Add this client's partner now
            </p>
            <p className="mt-1 text-sm text-slate-600">
              The two records will be linked after both are created.
            </p>
          </div>
        </label>

        {includePartner ? (
          <div className="mt-5 space-y-5 rounded-2xl border bg-white p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="partnerFirstName" className="mb-1 block text-sm font-medium">
                  Partner First Name
                </label>
                <input
                  id="partnerFirstName"
                  name="partnerFirstName"
                  required={includePartner}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="partnerLastName" className="mb-1 block text-sm font-medium">
                  Partner Last Name
                </label>
                <input
                  id="partnerLastName"
                  name="partnerLastName"
                  required={includePartner}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="partnerEmail" className="mb-1 block text-sm font-medium">
                  Partner Email
                </label>
                <input
                  id="partnerEmail"
                  name="partnerEmail"
                  type="email"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <div>
                <label htmlFor="partnerPhone" className="mb-1 block text-sm font-medium">
                  Partner Phone
                </label>
                <input
                  id="partnerPhone"
                  name="partnerPhone"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>
            </div>

            <div>
              <p className="mb-1 text-sm font-medium">Partner Dance Styles</p>
              <p className="mb-3 text-xs text-slate-500">
                Leave blank to use the first client's selected styles.
              </p>
              <CheckboxGroup name="partnerDanceStyles" groups={DANCE_STYLE_GROUPS} />
            </div>

            <div>
              <p className="mb-1 text-sm font-medium">Partner Dance Goals</p>
              <p className="mb-3 text-xs text-slate-500">
                Leave blank to use the first client's selected goals.
              </p>
              <GoalCheckboxes name="partnerDanceGoals" />
            </div>
          </div>
        ) : null}
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
