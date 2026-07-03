import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  formatPartnerRole,
  formatPartnerSkill,
  getPublishedPartnerProfiles,
} from "@/lib/partnerSearch";
import { savePartnerSearchProfileAction } from "./actions";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type OwnProfileRow = {
  display_name: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  lead_follow_role: string;
  dance_styles: string[] | null;
  skill_level: string;
  goals: string[] | null;
  availability_notes: string | null;
  contact_preference: string;
  contact_email: string | null;
  contact_phone: string | null;
  visibility: string;
};

function listValue(value: string[] | null | undefined) {
  return (value ?? []).join(", ");
}

export default async function AppPartnerSearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const [{ data: ownProfile }, profiles] = await Promise.all([
    user
      ? supabase
          .from("dancer_partner_profiles")
          .select(
            "display_name, headline, bio, city, state, lead_follow_role, dance_styles, skill_level, goals, availability_notes, contact_preference, contact_email, contact_phone, visibility",
          )
          .eq("user_id", user.id)
          .maybeSingle<OwnProfileRow>()
      : Promise.resolve({ data: null }),
    getPublishedPartnerProfiles(),
  ]);

  return (
    <div className="space-y-8">
      {query.success === "saved" ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          Partner profile saved.
        </div>
      ) : null}
      {query.error ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          We could not save the partner profile. Check the required fields and try again.
        </div>
      ) : null}

      <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
              Partner Search
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
              Find or publish dance partner listings
            </h1>
            <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
              Add your own listing or browse dancers looking for practice,
              social dance, showcase, and competition partners.
            </p>
          </div>
          <Link
            href="/discover/partners"
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium hover:bg-slate-50"
          >
            Public View
          </Link>
        </div>
      </div>

      <form
        action={savePartnerSearchProfileAction}
        className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
      >
        <h2 className="text-xl font-semibold text-slate-950">
          Your Partner Listing
        </h2>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium text-slate-700">
            Display name
            <input
              name="displayName"
              defaultValue={ownProfile?.display_name ?? ""}
              required
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Headline
            <input
              name="headline"
              defaultValue={ownProfile?.headline ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Looking for a West Coast Swing practice partner"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            City
            <input
              name="city"
              defaultValue={ownProfile?.city ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            State
            <input
              name="state"
              defaultValue={ownProfile?.state ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Role
            <select
              name="leadFollowRole"
              defaultValue={ownProfile?.lead_follow_role ?? "either"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="either">Lead or Follow</option>
              <option value="lead">Lead</option>
              <option value="follow">Follow</option>
              <option value="switch">Switch</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Skill level
            <select
              name="skillLevel"
              defaultValue={ownProfile?.skill_level ?? "social"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="newcomer">Newcomer</option>
              <option value="beginner">Beginner</option>
              <option value="social">Social</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
              <option value="professional">Professional</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Dance styles
            <input
              name="danceStyles"
              defaultValue={listValue(ownProfile?.dance_styles)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Country Two Step, West Coast Swing, Ballroom"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Goals
            <input
              name="goals"
              defaultValue={listValue(ownProfile?.goals)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              placeholder="Practice, social dance, showcase, competition"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Bio
            <textarea
              name="bio"
              defaultValue={ownProfile?.bio ?? ""}
              rows={4}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700 md:col-span-2">
            Availability notes
            <textarea
              name="availabilityNotes"
              defaultValue={ownProfile?.availability_notes ?? ""}
              rows={3}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Contact preference
            <select
              name="contactPreference"
              defaultValue={ownProfile?.contact_preference ?? "message"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="message">DanceFlow message</option>
              <option value="email">Email</option>
              <option value="phone">Phone</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Visibility
            <select
              name="visibility"
              defaultValue={ownProfile?.visibility ?? "draft"}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            >
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="paused">Paused</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Contact email
            <input
              name="contactEmail"
              type="email"
              defaultValue={ownProfile?.contact_email ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            Contact phone
            <input
              name="contactPhone"
              defaultValue={ownProfile?.contact_phone ?? ""}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
            />
          </label>
        </div>
        <button
          type="submit"
          className="mt-5 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Save Partner Listing
        </button>
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        {profiles.slice(0, 8).map((profile) => (
          <article
            key={profile.id}
            className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold text-slate-950">
                  {profile.displayName}
                </h2>
                <p className="text-sm text-slate-500">{profile.location}</p>
              </div>
              <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700">
                {formatPartnerRole(profile.leadFollowRole)}
              </span>
            </div>
            <p className="mt-3 text-sm text-slate-600">
              {profile.headline || profile.bio || "Partner listing"}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">
                {formatPartnerSkill(profile.skillLevel)}
              </span>
              {profile.danceStyles.slice(0, 3).map((style) => (
                <span
                  key={style}
                  className="rounded-full bg-orange-50 px-3 py-1 text-xs text-orange-700"
                >
                  {style}
                </span>
              ))}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
