"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  ArrowLeft,
  GraduationCap,
  Sparkles,
  UserPlus,
  Users,
} from "lucide-react";
import { createClientAction } from "../actions";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
} from "@/lib/forms/options";

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
              <label key={`${name}-${group.label}-${option}`} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2 text-sm text-slate-700 shadow-sm">
                <input
                  type="checkbox"
                  name={name}
                  value={option}
                  className="h-4 w-4 rounded border-slate-300 text-[#5B197A] focus:ring-[#7C2D92]"
                />
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
          <input
            type="checkbox"
            name={name}
            value={goal}
            className="h-4 w-4 rounded border-slate-300 text-[#5B197A] focus:ring-[#7C2D92]"
          />
          <span>{goal}</span>
        </label>
      ))}
    </div>
  );
}

export default function NewClientPage() {
  const [state, formAction, pending] = useActionState(
    createClientAction,
    initialState
  );
  const [includePartner, setIncludePartner] = useState(false);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[28px] border border-[#E9D5FF] bg-gradient-to-r from-[#2D0B45] via-[#5B197A] to-[#7C2D92] text-white shadow-sm">
        <div className="flex flex-col gap-6 px-6 py-6 md:flex-row md:items-start md:justify-between md:px-8">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#F3D7FF]">
              DanceFlow CRM
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight md:text-4xl">
              Add Client or Lead
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/85 md:text-base">
              Create a client record, save contact details, track dance
              styles and goals, and keep follow-up notes in one clean place.
            </p>
          </div>

          <Link
            href="/app/clients"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white transition hover:bg-white/15"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Clients
          </Link>
        </div>

        <div className="grid gap-3 border-t border-white/10 bg-black/10 px-6 py-4 md:grid-cols-3 md:px-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Use for
            </p>
            <p className="mt-1 text-sm font-semibold">Leads and clients</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Best next step
            </p>
            <p className="mt-1 text-sm font-semibold">Add notes, styles, and goals</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-white/65">
              Optional
            </p>
            <p className="mt-1 text-sm font-semibold">Independent instructor</p>
          </div>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#F3E8FF] text-[#6B21A8]">
            <Users className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-slate-950">
            Client record
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Save the basic contact information your team needs for follow-up.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#FEF3C7] text-[#92400E]">
            <Sparkles className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-slate-950">
            Dance details
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Track level, dance styles, goals, referral source, and notes from the first
            conversation.
          </p>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#DBEAFE] text-[#1D4ED8]">
            <GraduationCap className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-slate-950">
            Instructor option
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Mark independent instructors when they need floor rental or limited
            instructor workflows.
          </p>
        </div>
      </section>

      <form action={formAction} encType="multipart/form-data" className="space-y-6">
        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Contact details
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Who are you adding?
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                First and last name are required. Email and phone help with
                follow-up and portal invitations later.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <label
                htmlFor="firstName"
                className="block text-sm font-medium text-slate-700"
              >
                First name *
              </label>
              <input
                id="firstName"
                name="firstName"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div>
              <label
                htmlFor="lastName"
                className="block text-sm font-medium text-slate-700"
              >
                Last name *
              </label>
              <input
                id="lastName"
                name="lastName"
                required
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div>
              <label
                htmlFor="email"
                className="block text-sm font-medium text-slate-700"
              >
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                placeholder="name@example.com"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div>
              <label
                htmlFor="phone"
                className="block text-sm font-medium text-slate-700"
              >
                Phone
              </label>
              <input
                id="phone"
                name="phone"
                placeholder="(555) 555-5555"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>
          </div>
        </section>


        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Personal details
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Birthday and mailing address
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            These details help studios send birthday cards, holiday mailers, and printed account notices.
          </p>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <label
                htmlFor="birthday"
                className="block text-sm font-medium text-slate-700"
              >
                Birthday
              </label>
              <input
                id="birthday"
                name="birthday"
                type="date"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Used for birthday reminders and card lists.
              </p>
            </div>

            <div>
              <label
                htmlFor="country"
                className="block text-sm font-medium text-slate-700"
              >
                Country
              </label>
              <input
                id="country"
                name="country"
                defaultValue="United States"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="addressLine1"
                className="block text-sm font-medium text-slate-700"
              >
                Mailing address
              </label>
              <input
                id="addressLine1"
                name="addressLine1"
                placeholder="Street address"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="addressLine2"
                className="block text-sm font-medium text-slate-700"
              >
                Apartment, suite, or unit
              </label>
              <input
                id="addressLine2"
                name="addressLine2"
                placeholder="Optional"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div>
              <label
                htmlFor="city"
                className="block text-sm font-medium text-slate-700"
              >
                City
              </label>
              <input
                id="city"
                name="city"
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="state"
                  className="block text-sm font-medium text-slate-700"
                >
                  State / Region
                </label>
                <input
                  id="state"
                  name="state"
                  className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                />
              </div>

              <div>
                <label
                  htmlFor="postalCode"
                  className="block text-sm font-medium text-slate-700"
                >
                  ZIP / Postal code
                </label>
                <input
                  id="postalCode"
                  name="postalCode"
                  className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                />
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Photo verification
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Add a client headshot
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Add a photo now so staff can visually confirm the client during check-ins, lessons, and future QR workflows.
          </p>

          <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
            <label htmlFor="clientPhoto" className="block text-sm font-semibold text-slate-800">
              Upload or take photo
            </label>
            <input
              id="clientPhoto"
              name="clientPhoto"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="mt-3 block w-full text-sm text-slate-700 file:mr-4 file:rounded-xl file:border-0 file:bg-[#5B197A] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-[#4A1363]"
            />
            <p className="mt-3 text-xs leading-5 text-slate-500">
              JPG, PNG, or WebP up to 5MB. On supported mobile devices, choose
              a photo from the library or take a new one.
            </p>
          </div>
                </section>  
        <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm md:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
            Client profile
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Add status, dance styles, goals, and source
          </h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            These fields help your team know where the relationship stands and
            why they want to dance.
          </p>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <label
                htmlFor="status"
                className="block text-sm font-medium text-slate-700"
              >
                Status
              </label>
              <select
                id="status"
                name="status"
                defaultValue="lead"
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              >
                {CLIENT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="skillLevel"
                className="block text-sm font-medium text-slate-700"
              >
                Skill level
              </label>
              <select
                id="skillLevel"
                name="skillLevel"
                defaultValue=""
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
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
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-slate-700">
                  Dance Styles
                </p>
                <p className="text-xs leading-5 text-slate-500">
                  Select style categories and any specific dances they want to learn.
                </p>
              </div>
              <div className="mt-3">
                <CheckboxGroup name="danceStyles" groups={DANCE_STYLE_GROUPS} />
              </div>
            </div>

            <div className="md:col-span-2">
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-slate-700">
                  Dance Goals
                </p>
                <p className="text-xs leading-5 text-slate-500">
                  Select the reasons they are coming in. These will support conversion analytics later.
                </p>
              </div>
              <div className="mt-3">
                <GoalCheckboxes name="danceGoals" />
              </div>
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="referralSource"
                className="block text-sm font-medium text-slate-700"
              >
                Referral source
              </label>
              <select
                id="referralSource"
                name="referralSource"
                defaultValue="manual"
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              >
                <option value="">Not set</option>
                {CLIENT_REFERRAL_SOURCE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="notes"
                className="block text-sm font-medium text-slate-700"
              >
                Notes
              </label>
              <textarea
                id="notes"
                name="notes"
                rows={5}
                placeholder="Add goals, follow-up details, preferred dances, or anything the team should know."
                className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
              />
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-[#E9D5FF] bg-[#FAF5FF] p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#6B21A8]">
                Optional partner
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Add this client's partner
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
                Use this when a couple comes in together and both people need client records.
                You can still link two existing accounts separately later.
              </p>
            </div>

            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white text-[#6B21A8] shadow-sm">
              <Users className="h-6 w-6" />
            </div>
          </div>

          <label className="mt-5 flex items-start gap-3 rounded-2xl border border-[#E9D5FF] bg-white p-4 shadow-sm">
            <input
              type="checkbox"
              name="createPartner"
              checked={includePartner}
              onChange={(event) => setIncludePartner(event.target.checked)}
              className="mt-1 h-4 w-4 rounded border-slate-300 text-[#5B197A] focus:ring-[#7C2D92]"
            />
            <div>
              <p className="font-medium text-slate-950">
                Create a second linked client record
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                The two records will be linked as partners after both are created.
              </p>
            </div>
          </label>

          {includePartner ? (
            <div className="mt-6 space-y-6 rounded-3xl border border-[#E9D5FF] bg-white p-5">
              <div className="grid gap-5 md:grid-cols-2">
                <div>
                  <label
                    htmlFor="partnerFirstName"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Partner first name *
                  </label>
                  <input
                    id="partnerFirstName"
                    name="partnerFirstName"
                    required={includePartner}
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="partnerLastName"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Partner last name *
                  </label>
                  <input
                    id="partnerLastName"
                    name="partnerLastName"
                    required={includePartner}
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="partnerEmail"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Partner email
                  </label>
                  <input
                    id="partnerEmail"
                    name="partnerEmail"
                    type="email"
                    placeholder="partner@example.com"
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                  />
                </div>

                <div>
                  <label
                    htmlFor="partnerPhone"
                    className="block text-sm font-medium text-slate-700"
                  >
                    Partner phone
                  </label>
                  <input
                    id="partnerPhone"
                    name="partnerPhone"
                    placeholder="(555) 555-5555"
                    className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm outline-none transition focus:border-[#7C2D92] focus:ring-2 focus:ring-[#E9D5FF]"
                  />
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-700">
                  Partner Dance Styles
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Leave blank to use the first client's selected styles.
                </p>
                <div className="mt-3">
                  <CheckboxGroup name="partnerDanceStyles" groups={DANCE_STYLE_GROUPS} />
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-slate-700">
                  Partner Dance Goals
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-500">
                  Leave blank to use the first client's selected goals.
                </p>
                <div className="mt-3">
                  <GoalCheckboxes name="partnerDanceGoals" />
                </div>
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-[28px] border border-[#BFDBFE] bg-[#EFF6FF] p-5 shadow-sm md:p-6">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#1D4ED8]">
                Optional access type
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Independent instructor
              </h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-700">
                Use this only when this person is a client/contact who should
                also use independent instructor workflows, like floor rentals.
              </p>
            </div>

            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white text-[#1D4ED8] shadow-sm">
              <GraduationCap className="h-6 w-6" />
            </div>
          </div>

          <label className="mt-5 flex items-start gap-3 rounded-2xl border border-[#BFDBFE] bg-white p-4 shadow-sm">
            <input
              type="checkbox"
              name="isIndependentInstructor"
              className="mt-1 h-4 w-4 rounded border-slate-300 text-[#5B197A] focus:ring-[#7C2D92]"
            />
            <div>
              <p className="font-medium text-slate-950">
                Mark this client as an independent instructor
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                This keeps the person in your client records while enabling
                limited instructor-related workflows as those features expand.
              </p>
            </div>
          </label>
        </section>

        {state.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="sticky bottom-0 z-10 -mx-1 border-t border-slate-200 bg-white/90 px-1 py-4 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0">
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Link
              href="/app/clients"
              className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
            >
              Cancel
            </Link>

            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-[#5B197A] px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#4A1363] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <UserPlus className="h-4 w-4" />
              {pending ? "Creating..." : "Create Client"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
