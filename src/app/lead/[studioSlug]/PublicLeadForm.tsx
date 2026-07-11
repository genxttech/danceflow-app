"use client";

import { useActionState, useMemo } from "react";
import { useFormStatus } from "react-dom";
import {
  submitPublicLeadAction,
  type PublicLeadFormState,
} from "./actions";

type StudioBranding = {
  id: string;
  name: string;
  slug: string | null;
  public_lead_enabled: boolean | null;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_logo_url: string | null;
  public_primary_color: string | null;
  public_lead_cta_text: string | null;
  public_intro_booking_enabled?: boolean | null;
  intro_lesson_duration_minutes?: number | null;
  intro_booking_window_days?: number | null;
};

const BOT_HONEYPOT_FIELD = "df_website";
const BOT_STARTED_AT_FIELD = "df_started_at";

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
  studio: StudioBranding | null;
  successRedirect?: string;
}) {
  const [state, formAction] = useActionState(
    submitPublicLeadAction,
    initialState
  );
  const botStartedAt = useMemo(() => String(Date.now()), []);

  if (!studio) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        This studio is not available for inquiries right now.
      </div>
    );
  }

  if (!studio.public_lead_enabled) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600">
        This inquiry form is not currently available.
      </div>
    );
  }

  const accent = studio.public_primary_color?.trim() || "#0f172a";
  const introBookingEnabled = Boolean(studio.public_intro_booking_enabled);
  const ctaText = introBookingEnabled
    ? "Request Intro Lesson"
    : studio.public_lead_cta_text?.trim() || "Submit Inquiry";
  const introDuration = studio.intro_lesson_duration_minutes ?? null;
  const introWindowDays = studio.intro_booking_window_days ?? null;

  return (
    <div style={{ ["--studio-accent" as string]: accent }}>
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="studioSlug" value={studio.slug ?? ""} />
        <input
          type="hidden"
          name="successRedirect"
          value={successRedirect ?? ""}
        />
        <input
          type="hidden"
          name="inquiryIntent"
          value={introBookingEnabled ? "intro_lesson" : "general_inquiry"}
        />
        <input type="hidden" name={BOT_STARTED_AT_FIELD} value={botStartedAt} />
        <div className="hidden" aria-hidden="true">
          <label htmlFor="dfLeadWebsite">Website</label>
          <input
            id="dfLeadWebsite"
            name={BOT_HONEYPOT_FIELD}
            tabIndex={-1}
            autoComplete="off"
          />
        </div>

        {introBookingEnabled ? (
          <div className="rounded-2xl border border-violet-200 bg-white/70 px-4 py-4 text-sm leading-6 text-violet-950">
            <p className="font-semibold">Intro lesson request</p>
            <p className="mt-1">
              Share your contact details and what you are looking for. The
              studio can follow up to confirm a time
              {introDuration ? ` for a ${introDuration}-minute intro lesson` : ""}
              {introWindowDays ? ` within the next ${introWindowDays} days` : ""}.
            </p>
          </div>
        ) : null}

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
              maxLength={80}
              autoComplete="given-name"
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
              maxLength={80}
              autoComplete="family-name"
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
              autoComplete="email"
              maxLength={254}
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
              inputMode="tel"
              autoComplete="tel"
              maxLength={30}
              pattern="^[+0-9().\s-]{0,30}$"
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
              Dance interests {introBookingEnabled ? "*" : ""}
            </label>
            <input
              id="danceInterests"
              name="danceInterests"
              required={introBookingEnabled}
              placeholder="Wedding dance, salsa, ballroom..."
              maxLength={250}
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
              maxLength={120}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-200"
            />
          </div>
        </div>

        <div>
          <label
            htmlFor="notes"
            className="mb-1.5 block text-sm font-medium text-slate-700"
          >
            {introBookingEnabled
              ? "What kind of intro lesson are you looking for?"
              : "What are you looking for?"}
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={5}
            placeholder={
              introBookingEnabled
                ? "Tell us your goals, preferred days/times, and whether this is for social dancing, a wedding, competition, or something else."
                : "Tell us about your goals, timeline, event, or questions."
            }
            maxLength={2000}
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
