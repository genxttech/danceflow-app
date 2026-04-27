"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createClientAction } from "../actions";
import {
  CLIENT_REFERRAL_SOURCE_OPTIONS,
  CLIENT_SKILL_LEVEL_OPTIONS,
  CLIENT_STATUS_OPTIONS,
} from "@/lib/forms/options";

const initialState = { error: "" };

export default function NewClientPage() {
  const [state, formAction, pending] = useActionState(
    createClientAction,
    initialState
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
              DanceFlow CRM
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              Add Client or Lead
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              Create a clean client record with contact details, lead status,
              dance interests, and follow-up notes.
            </p>
          </div>

          <Link
            href="/app/clients"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Clients
          </Link>
        </div>
      </section>

      <form action={formAction} className="rounded-2xl border bg-white p-6 shadow-sm">
        <div className="grid gap-6 md:grid-cols-2">
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
              <option value="">Select skill level</option>
              {CLIENT_SKILL_LEVEL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="danceInterests"
              className="mb-1 block text-sm font-medium"
            >
              Dance Interests
            </label>
            <input
              id="danceInterests"
              name="danceInterests"
              placeholder="Country, ballroom, salsa..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div className="md:col-span-2">
            <label
              htmlFor="referralSource"
              className="mb-1 block text-sm font-medium"
            >
              Referral Source
            </label>
            <select
              id="referralSource"
              name="referralSource"
              defaultValue="manual"
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
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div className="mt-6 rounded-2xl border bg-slate-50 p-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="isIndependentInstructor"
              className="mt-1"
            />
            <div>
              <p className="font-medium text-slate-900">
                Independent Instructor
              </p>
              <p className="mt-1 text-sm text-slate-600">
                Enable this only if this client should also use floor rental and
                independent instructor workflows.
              </p>
            </div>
          </label>
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
    </div>
  );
}