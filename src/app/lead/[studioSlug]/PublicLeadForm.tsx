"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import {
  submitPublicLeadAction,
  type PublicLeadFormState,
} from "./actions";

type StudioBranding = {
  id: string;
  name: string;
  slug: string;
  public_lead_enabled: boolean;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_logo_url: string | null;
  public_primary_color: string | null;
  public_lead_cta_text: string | null;
};

const initialState: PublicLeadFormState = {
  error: "",
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-60"
      style={{ backgroundColor: "var(--studio-accent, #0f172a)" }}
    >
      {pending ? "Submitting..." : label}
    </button>
  );
}

export default function PublicLeadForm({
  studio,
  successRedirect,
}: {
  studio: StudioBranding;
  successRedirect?: string;
}) {
  const [state, formAction] = useActionState(
    submitPublicLeadAction,
    initialState
  );

  const accent = studio.public_primary_color?.trim() || "#0f172a";
  const ctaText = studio.public_lead_cta_text?.trim() || "Submit Inquiry";
  const headline =
    studio.public_lead_headline?.trim() || `Get started with ${studio.name}`;
  const description =
    studio.public_lead_description?.trim() ||
    "Tell us a little about yourself and what you are looking for.";

  if (!studio.public_lead_enabled) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
        This inquiry form is not currently available.
      </div>
    );
  }

  return (
    <div style={{ ["--studio-accent" as string]: accent }}>
      <div className="mb-5">
        <h3 className="text-lg font-semibold text-slate-950">{headline}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
      </div>

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="studioSlug" value={studio.slug} />
        <input
          type="hidden"
          name="successRedirect"
          value={successRedirect ?? ""}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="firstName"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              First name
            </label>
            <input
              id="firstName"
              name="firstName"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div>
            <label
              htmlFor="lastName"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Last name
            </label>
            <input
              id="lastName"
              name="lastName"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="email"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div>
            <label
              htmlFor="phone"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Phone
            </label>
            <input
              id="phone"
              name="phone"
              type="tel"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="danceInterests"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Dance interests
            </label>
            <input
              id="danceInterests"
              name="danceInterests"
              placeholder="Wedding dance, salsa, ballroom..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>

          <div>
            <label
              htmlFor="skillLevel"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Skill level
            </label>
            <select
              id="skillLevel"
              name="skillLevel"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            >
              <option value="">Select one</option>
              <option value="beginner">Beginner</option>
              <option value="returning">Returning</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label
              htmlFor="preferredContactMethod"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              Preferred contact method
            </label>
            <select
              id="preferredContactMethod"
              name="preferredContactMethod"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            >
              <option value="">No preference</option>
              <option value="phone">Phone</option>
              <option value="text">Text</option>
              <option value="email">Email</option>
            </select>
          </div>

          <div>
            <label
              htmlFor="referralSource"
              className="mb-1.5 block text-sm font-medium text-slate-700"
            >
              How did you hear about us?
            </label>
            <input
              id="referralSource"
              name="referralSource"
              placeholder="Google, Instagram, friend..."
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="notes"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            What are you looking for?
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            placeholder="Tell us about your goals, timeline, event, or questions."
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
          />
        </div>

        {state.error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {state.error}
          </div>
        ) : null}

        <SubmitButton label={ctaText} />
      </form>
    </div>
  );
}