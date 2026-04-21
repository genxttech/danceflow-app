"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { CalendarDays, Globe2, MapPin, Sparkles, Users } from "lucide-react";
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

function FieldLabel({
  htmlFor,
  children,
}: {
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-sm font-medium text-slate-800"
    >
      {children}
    </label>
  );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={[
        "w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition",
        "placeholder:text-slate-400 focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary)]/10",
        props.className ?? "",
      ].join(" ")}
    />
  );
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
    <form
      action={formAction}
      className="space-y-8 overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm"
    >
      <section className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
        <div className="max-w-3xl">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
            DanceFlow Organizer Workspace
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
            Create Organizer
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
            Build the public-facing organizer identity that powers event discovery,
            branding, registrations, and public event pages.
          </p>
        </div>

        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-white/15 bg-white/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white/10 p-3">
                <Sparkles className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">Brand Identity</p>
                <p className="mt-1 text-sm text-white/75">
                  Organizer name, description, and public profile basics.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white/10 p-3">
                <Globe2 className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">Public Discovery</p>
                <p className="mt-1 text-sm text-white/75">
                  Power public event pages and searchable organizer listings.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/10 p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white/10 p-3">
                <CalendarDays className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-medium">Event Ownership</p>
                <p className="mt-1 text-sm text-white/75">
                  Link events to the right organizer from the start.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="space-y-8 px-6 pb-8 md:px-8">
        <section className="rounded-[28px] border border-slate-200 bg-[var(--brand-primary-soft)]/35 p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Organizer Basics
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Start with the organizer identity
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Use a clear public-facing organizer name and slug. This becomes the
                foundation for event publishing and discovery.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <FieldLabel htmlFor="name">Organizer Name</FieldLabel>
              <TextInput
                id="name"
                name="name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="O Hi Yall Dance"
              />
            </div>

            <div>
              <FieldLabel htmlFor="slug">Slug</FieldLabel>
              <TextInput
                id="slug"
                name="slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder={suggestedSlug || "o-hi-yall-dance"}
              />
              <p className="mt-2 text-xs text-slate-500">
                Leave blank to use:{" "}
                <span className="font-medium text-slate-700">
                  {suggestedSlug || "generated-from-name"}
                </span>
              </p>
            </div>

            <div className="md:col-span-2">
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <textarea
                id="description"
                name="description"
                rows={5}
                className="w-full rounded-2xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary)]/10"
                placeholder="Describe the organizer, brand, audience, and event focus."
              />
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Globe2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Contact & Public Links
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Connect the public-facing details
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                These fields help dancers recognize the organizer and know how to
                reach them.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <FieldLabel htmlFor="contactEmail">Contact Email</FieldLabel>
              <TextInput
                id="contactEmail"
                name="contactEmail"
                type="email"
                placeholder="info@example.com"
              />
            </div>

            <div>
              <FieldLabel htmlFor="contactPhone">Contact Phone</FieldLabel>
              <TextInput
                id="contactPhone"
                name="contactPhone"
                placeholder="Optional"
              />
            </div>

            <div>
              <FieldLabel htmlFor="websiteUrl">Website URL</FieldLabel>
              <TextInput
                id="websiteUrl"
                name="websiteUrl"
                placeholder="https://example.com"
              />
            </div>

            <div>
              <FieldLabel htmlFor="logoUrl">Logo URL</FieldLabel>
              <TextInput
                id="logoUrl"
                name="logoUrl"
                placeholder="Optional"
              />
            </div>

            <div className="md:col-span-2">
              <FieldLabel htmlFor="coverImageUrl">Cover Image URL</FieldLabel>
              <TextInput
                id="coverImageUrl"
                name="coverImageUrl"
                placeholder="Optional"
              />
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <MapPin className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Location
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Add organizer location details
              </h2>
              <p className="mt-2 text-sm leading-7 text-slate-600">
                Location helps public listings feel grounded and helps dancers know
                where the organizer operates.
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-5 md:grid-cols-2">
            <div>
              <FieldLabel htmlFor="city">City</FieldLabel>
              <TextInput id="city" name="city" placeholder="Optional" />
            </div>

            <div>
              <FieldLabel htmlFor="state">State</FieldLabel>
              <TextInput id="state" name="state" placeholder="Optional" />
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-slate-50 p-6">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="active"
              defaultChecked
              className="mt-1 h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)] focus:ring-[var(--brand-primary)]"
            />
            <div>
              <p className="font-medium text-slate-900">Active organizer</p>
              <p className="mt-1 text-sm leading-7 text-slate-600">
                Inactive organizers stay in the system but should not be featured
                publicly until they are ready.
              </p>
            </div>
          </label>
        </section>

        {state.error ? (
          <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-wrap gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-medium text-white hover:opacity-95 disabled:opacity-60"
          >
            {pending ? "Creating..." : "Create Organizer"}
          </button>

          <Link
            href="/app/organizers"
            className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </div>
    </form>
  );
}