"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { createOrganizerAction } from "./actions";

type ActionState = {
  error: string;
};

const initialState: ActionState = {
  error: "",
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function OrganizerForm() {
  const [state, formAction, pending] = useActionState(
    createOrganizerAction,
    initialState
  );

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const suggestedSlug = useMemo(() => slugify(name), [name]);

  return (
    <form action={formAction} className="space-y-8 rounded-2xl border bg-white p-6">
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Organizer Name
          </label>
          <input
            id="name"
            name="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Buckeye Dance Festival"
          />
        </div>

        <div>
          <label htmlFor="slug" className="mb-1 block text-sm font-medium">
            Slug
          </label>
          <input
            id="slug"
            name="slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder={suggestedSlug || "buckeye-dance-festival"}
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to use: {suggestedSlug || "generated-from-name"}
          </p>
        </div>

        <div>
          <label htmlFor="contactEmail" className="mb-1 block text-sm font-medium">
            Contact Email
          </label>
          <input
            id="contactEmail"
            name="contactEmail"
            type="email"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="info@example.com"
          />
        </div>

        <div>
          <label htmlFor="contactPhone" className="mb-1 block text-sm font-medium">
            Contact Phone
          </label>
          <input
            id="contactPhone"
            name="contactPhone"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>

        <div>
          <label htmlFor="websiteUrl" className="mb-1 block text-sm font-medium">
            Website URL
          </label>
          <input
            id="websiteUrl"
            name="websiteUrl"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="https://example.com"
          />
        </div>

        <div>
          <label htmlFor="logoUrl" className="mb-1 block text-sm font-medium">
            Logo URL
          </label>
          <input
            id="logoUrl"
            name="logoUrl"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>

        <div>
          <label htmlFor="coverImageUrl" className="mb-1 block text-sm font-medium">
            Cover Image URL
          </label>
          <input
            id="coverImageUrl"
            name="coverImageUrl"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>

        <div>
          <label htmlFor="city" className="mb-1 block text-sm font-medium">
            City
          </label>
          <input
            id="city"
            name="city"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>

        <div>
          <label htmlFor="state" className="mb-1 block text-sm font-medium">
            State
          </label>
          <input
            id="state"
            name="state"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            placeholder="Optional"
          />
        </div>
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm font-medium">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={5}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="Describe the organizer, brand, and event focus."
        />
      </div>

      <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
        <input
          type="checkbox"
          name="active"
          defaultChecked
          className="mt-1"
        />
        <div>
          <p className="font-medium text-slate-900">Active organizer</p>
          <p className="mt-1 text-sm text-slate-600">
            Inactive organizers stay in the system but should not be featured publicly.
          </p>
        </div>
      </label>

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
          {pending ? "Creating..." : "Create Organizer"}
        </button>

        <Link
          href="/app/organizers"
          className="rounded-xl border px-4 py-2 hover:bg-slate-50"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}