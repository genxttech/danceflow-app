import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { savePartnerSearchProfileAction } from "./actions";
import { BOT_HONEYPOT_FIELD, BOT_STARTED_AT_FIELD } from "@/lib/security/bot-protection";

type SearchParams = Promise<{
  success?: string;
  error?: string;
}>;

type DancerProfileRow = {
  first_name: string | null;
  last_name: string | null;
  preferred_name: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  skill_level: string | null;
};

type OwnProfileRow = {
  display_name: string;
  headline: string | null;
  bio: string | null;
  city: string | null;
  state: string | null;
  lead_follow_role: string | null;
  dance_styles: string[] | null;
  skill_level: string | null;
  goals: string[] | null;
  listing_intent: string | null;
  availability_notes: string | null;
  visibility: string | null;
  moderation_status: string | null;
  moderation_reason: string | null;
};

const roleOptions = [
  { label: "Lead or Follow", value: "either" },
  { label: "Lead", value: "lead" },
  { label: "Follow", value: "follow" },
  { label: "Switch", value: "switch" },
];


const goalOptions = [
  { label: "Practice", value: "Practice", intent: "practice" },
  { label: "Social", value: "Social", intent: "social" },
  { label: "Showcase", value: "Showcase", intent: "showcase" },
  { label: "Competition", value: "Competition", intent: "competition" },
];




const danceStyleGroups = [
  {
    label: "American Smooth",
    styles: ["Waltz", "Tango", "Foxtrot", "Viennese Waltz"],
  },
  {
    label: "American Rhythm",
    styles: ["Cha Cha", "Rumba", "East Coast Swing", "Bolero", "Mambo"],
  },
  {
    label: "International Ballroom",
    styles: ["Waltz", "Tango", "Viennese Waltz", "Foxtrot", "Quickstep"],
  },
  {
    label: "International Latin",
    styles: ["Cha Cha", "Samba", "Rumba", "Paso Doble", "Jive"],
  },
  {
    label: "Country",
    styles: [
      "Country Two Step",
      "West Coast Swing",
      "East Coast Swing",
      "Nightclub Two Step",
      "Country Waltz",
      "Polka",
    ],
  },
  {
    label: "Social / Club",
    styles: ["Salsa", "Bachata", "Argentine Tango", "Hustle", "Lindy Hop", "Zouk", "Kizomba"],
  },
];

function checked(values: string[] | null | undefined, value: string) {
  return (values ?? []).includes(value);
}

function successMessage(success: string | undefined) {
  if (success === "hidden") return "Partner profile hidden from search.";
  if (success === "submitted") return "Partner profile submitted for review.";
  if (success === "draft_review") {
    return "Saved as a draft. Remove lesson ads, service offers, outside links, phone numbers, or booking language before submitting.";
  }
  return null;
}

export default async function AccountPartnerSearchPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/partner-search");
  }

  const [
    { data: ownProfile, error },
    { data: dancerProfile, error: dancerProfileError },
  ] = await Promise.all([
    supabase
      .from("dancer_partner_profiles")
      .select(
        "display_name, headline, bio, city, state, lead_follow_role, dance_styles, skill_level, goals, listing_intent, availability_notes, visibility, moderation_status, moderation_reason",
      )
      .eq("user_id", user.id)
      .maybeSingle<OwnProfileRow>(),
    supabase
      .from("dancer_profiles")
      .select("first_name, last_name, preferred_name, bio, city, state, skill_level")
      .eq("user_id", user.id)
      .maybeSingle<DancerProfileRow>(),
  ]);

  if (error) {
    throw new Error(`Failed to load partner profile: ${error.message}`);
  }

  if (dancerProfileError) {
    throw new Error(`Failed to load DanceFlow profile: ${dancerProfileError.message}`);
  }

  const sharedDisplayName =
    dancerProfile?.preferred_name?.trim() ||
    [dancerProfile?.first_name, dancerProfile?.last_name].filter(Boolean).join(" ").trim() ||
    user.email?.split("@")[0] ||
    "DanceFlow dancer";
  const sharedLocation = [dancerProfile?.city, dancerProfile?.state].filter(Boolean).join(", ");
  const sharedSkill = dancerProfile?.skill_level || "Not set";

  const message = successMessage(query.success);
  const isVisible = ownProfile?.visibility === "published";

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {message ? (
          <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
            {message}
          </div>
        ) : null}
        {query.error ? (
          <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            We could not save your partner profile. Check the required fields and try again.
          </div>
        ) : null}

        <section className="rounded-[28px] border border-indigo-100 bg-gradient-to-br from-white via-white to-indigo-50/60 p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
                Partner Search
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                Create your Partner Search listing
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
                Use your DanceFlow profile as the starting point, then add only the details that matter for finding a practice, social, showcase, or competition partner. Contact stays inside DanceFlow.
              </p>
            </div>
            <Link
              href="/discover/partners"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Public Partner Search
            </Link>
          </div>
        </section>

        <form
          action={savePartnerSearchProfileAction}
          className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"
        >
          <input type="hidden" name={BOT_STARTED_AT_FIELD} value={String(Date.now())} />
          <div className="hidden" aria-hidden="true">
            <label htmlFor="dfPartnerWebsite">Website</label>
            <input
              id="dfPartnerWebsite"
              name={BOT_HONEYPOT_FIELD}
              tabIndex={-1}
              autoComplete="off"
            />
          </div>
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-950">
                Your Partner Search listing
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Publish this listing only when you want other dancers to find you. Your main DanceFlow profile is not publicly searchable.
              </p>
            </div>
            <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-800">
              <input
                type="checkbox"
                name="profileVisible"
                defaultChecked={isVisible}
                className="h-5 w-5 rounded border-slate-300 text-[var(--brand-primary)]"
              />
              Show this listing in Partner Search
            </label>
          </div>

          {ownProfile?.moderation_reason ? (
            <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {ownProfile.moderation_reason}
            </div>
          ) : null}

          <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50/60 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
                  Using your DanceFlow profile
                </p>
                <p className="mt-2 font-semibold text-slate-950">{sharedDisplayName}</p>
                <p className="mt-1 text-sm text-slate-600">
                  {sharedLocation || "Location not set"} · {sharedSkill}
                </p>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
                  {dancerProfile?.bio || "Add a bio to your DanceFlow profile to reuse it here."}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  Display name, location, skill level, and bio come from your DanceFlow profile. Saving this listing refreshes those shared details. Partner-specific fields below stay with this listing.
                </p>
              </div>
              <Link
                href="/account/profile"
                className="shrink-0 rounded-xl border border-violet-200 bg-white px-3 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-100"
              >
                Edit DanceFlow profile
              </Link>
            </div>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <label className="block text-sm font-medium text-slate-700">
              Headline
              <input
                name="headline"
                defaultValue={ownProfile?.headline ?? ""}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
                placeholder="Looking for a country two step practice partner"
              />
            </label>


            <label className="block text-sm font-medium text-slate-700">
              Primary goal
              <select
                name="listingIntent"
                defaultValue={ownProfile?.listing_intent ?? "practice"}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              >
                {goalOptions.map((goal) => (
                  <option key={goal.intent} value={goal.intent}>
                    {goal.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Role
              <select
                name="leadFollowRole"
                defaultValue={ownProfile?.lead_follow_role ?? "either"}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              >
                {roleOptions.map((role) => (
                  <option key={role.value} value={role.value}>
                    {role.label}
                  </option>
                ))}
              </select>
            </label>


            <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:col-span-2">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                Goals
              </legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {goalOptions.map((goal) => (
                  <label
                    key={goal.value}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                  >
                    <input
                      type="checkbox"
                      name="goals"
                      value={goal.value}
                      defaultChecked={checked(ownProfile?.goals, goal.value)}
                      className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                    />
                    {goal.label}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:col-span-2">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                Dance styles
              </legend>
              <p className="mt-1 text-sm text-slate-500">
                Select full categories, individual dances, or both.
              </p>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {danceStyleGroups.map((group) => (
                  <div key={group.label} className="rounded-2xl border border-white bg-white p-4 shadow-sm">
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-[var(--brand-primary)] bg-white px-3 py-2 text-sm font-semibold text-[var(--brand-primary)]">
                      <input
                        type="checkbox"
                        name="danceStyles"
                        value={group.label}
                        defaultChecked={checked(ownProfile?.dance_styles, group.label)}
                        className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                      />
                      {group.label} - all styles
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {group.styles.map((style) => (
                        <label
                          key={`${group.label}-${style}`}
                          className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                        >
                          <input
                            type="checkbox"
                            name="danceStyles"
                            value={style}
                            defaultChecked={checked(ownProfile?.dance_styles, style)}
                            className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                          />
                          {style}
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </fieldset>

            <label className="block text-sm font-medium text-slate-700 md:col-span-2">
              Availability
              <textarea
                name="availabilityNotes"
                defaultValue={ownProfile?.availability_notes ?? ""}
                rows={3}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2"
              />
            </label>
          </div>

          <button
            type="submit"
            className="mt-5 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            Save Partner Search listing
          </button>
        </form>
      </div>
    </main>
  );
}
