import Link from "next/link";
import { NearMeButton } from "../NearMeButton";
import {
  formatPartnerIntent,
  formatPartnerRole,
  formatPartnerSkill,
  getPublishedPartnerProfiles,
} from "@/lib/partnerSearch";

export const metadata = {
  title: "Find a Dance Partner | DanceFlow",
  description:
    "Browse dancers looking for practice, social dance, showcase, or competition partners.",
};

type SearchParams = Promise<{
  intent?: string | string[];
  lat?: string;
  lng?: string;
  q?: string;
  radius?: string;
  role?: string;
  skill?: string;
  style?: string | string[];
}>;

const roleOptions = ["either", "lead", "follow", "switch"];
const skillOptions = ["newcomer", "beginner", "social", "intermediate", "advanced", "professional"];
const intentOptions = ["practice", "social", "showcase", "competition"];
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


const RADIUS_OPTIONS = [25, 50, 100] as const;
const ALL_DANCE_STYLES = danceStyleGroups.flatMap((group) => [group.label, ...group.styles]);

function cleanSearchParam(value: string | undefined, maxLength = 100) {
  return (value ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function normalizeSelect(value: string | undefined, allowedValues: readonly string[]) {
  const normalized = cleanSearchParam(value).toLowerCase();
  return allowedValues.includes(normalized) ? normalized : "";
}

function normalizeMultiSelect(value: string | string[] | undefined, allowedValues: readonly string[], maxItems = 12) {
  const rawValues = Array.isArray(value) ? value : value ? [value] : [];
  const normalized: string[] = [];

  for (const rawValue of rawValues.slice(0, maxItems)) {
    const cleaned = cleanSearchParam(rawValue, 80);
    if (allowedValues.includes(cleaned) && !normalized.includes(cleaned)) {
      normalized.push(cleaned);
      continue;
    }

    const lower = cleaned.toLowerCase();
    const allowedLower = allowedValues.find((allowed) => allowed.toLowerCase() === lower);
    if (allowedLower && !normalized.includes(allowedLower)) {
      normalized.push(allowedLower);
    }
  }

  return normalized;
}

function normalizeRadius(value: string | undefined) {
  const parsed = Number(value ?? "50");
  return RADIUS_OPTIONS.includes(parsed as (typeof RADIUS_OPTIONS)[number]) ? parsed : 50;
}

function normalizeCoordinate(value: string | undefined, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
  return Math.round(parsed * 1_000_000) / 1_000_000;
}



export default async function PartnerSearchDiscoveryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const searchText = cleanSearchParam(query.q, 120);
  const selectedStyles = normalizeMultiSelect(query.style, ALL_DANCE_STYLES);
  const selectedIntents = normalizeMultiSelect(query.intent, intentOptions);
  const selectedRole = normalizeSelect(query.role, roleOptions);
  const selectedSkill = normalizeSelect(query.skill, skillOptions);
  const selectedRadius = normalizeRadius(query.radius);
  const latitude = normalizeCoordinate(query.lat, -90, 90);
  const longitude = normalizeCoordinate(query.lng, -180, 180);

  const profiles = await getPublishedPartnerProfiles({
    intent: selectedIntents,
    latitude,
    longitude,
    query: searchText || undefined,
    radiusMiles: selectedRadius,
    role: selectedRole || undefined,
    skill: selectedSkill || undefined,
    style: selectedStyles,
  });

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b border-indigo-100 bg-gradient-to-br from-white via-white to-indigo-50">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            Partner Search
          </p>
          <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Find dancers looking for a partner
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
                Browse public partner listings for practice, social dancing,
                showcases, competitions, and ongoing training.
              </p>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-500">
                Partner Search is for dancers looking for dance partners. Lesson
                ads, coaching offers, paid services, studio promotions, and
                external booking links are not allowed.
              </p>
            </div>
            <Link
              href="/account/partner-search"
              className="inline-flex rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Create a dancer profile
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <form className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-3 md:grid-cols-3">
            <input
              name="q"
              defaultValue={searchText}
              placeholder="Search style, city, role, goal, or level"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm md:col-span-3"
            />
            <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:col-span-3">
              <legend className="px-1 text-sm font-semibold text-slate-800">
                Goals
              </legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {intentOptions.map((intent) => (
                  <label
                    key={intent}
                    className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
                  >
                    <input
                      type="checkbox"
                      name="intent"
                      value={intent}
                      defaultChecked={selectedIntents.includes(intent)}
                      className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
                    />
                    {formatPartnerIntent(intent)}
                  </label>
                ))}
              </div>
            </fieldset>
            <select
              name="role"
              defaultValue={selectedRole}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Any role</option>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {formatPartnerRole(role)}
                </option>
              ))}
            </select>
            <select
              name="skill"
              defaultValue={selectedSkill}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Any level</option>
              {skillOptions.map((skill) => (
                <option key={skill} value={skill}>
                  {formatPartnerSkill(skill)}
                </option>
              ))}
            </select>
            <fieldset className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 md:col-span-3">
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
                        name="style"
                        value={group.label}
                        defaultChecked={selectedStyles.includes(group.label)}
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
                            name="style"
                            value={style}
                            defaultChecked={selectedStyles.includes(style)}
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
            <select
              name="radius"
              defaultValue={String(selectedRadius)}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="25">25 miles</option>
              <option value="50">50 miles</option>
              <option value="100">100 miles</option>
            </select>
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <button
              type="submit"
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white"
            >
              Apply filters
            </button>
            <Link
              href="/discover/partners"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Clear
            </Link>
            <NearMeButton />
          </div>
        </form>
        {profiles.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <h2 className="text-lg font-semibold text-slate-950">
              No partner listings yet
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Published dancer partner profiles will appear here.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {profiles.map((profile) => (
              <article
                key={profile.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-semibold text-slate-950">
                      {profile.displayName}
                    </h2>
                    <p className="mt-1 text-sm text-slate-500">
                      {profile.location}
                    </p>
                  </div>
                  <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700 ring-1 ring-purple-100">
                    {formatPartnerRole(profile.leadFollowRole)}
                  </span>
                  <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700 ring-1 ring-orange-100">
                    {formatPartnerIntent(profile.listingIntent)}
                  </span>
                </div>

                {profile.headline ? (
                  <p className="mt-4 text-base font-medium text-slate-800">
                    {profile.headline}
                  </p>
                ) : null}

                {profile.bio ? (
                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-slate-600">
                    {profile.bio}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                    {formatPartnerSkill(profile.skillLevel)}
                  </span>
                  {profile.danceStyles.slice(0, 4).map((style) => (
                    <span
                      key={style}
                      className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700"
                    >
                      {style}
                    </span>
                  ))}
                </div>

                {profile.availabilityNotes ? (
                  <p className="mt-4 text-sm text-slate-600">
                    {profile.availabilityNotes}
                  </p>
                ) : null}

                <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
                  <p>
                    Contact stays inside DanceFlow. Sign in to request a
                    connection.
                  </p>
                  <Link
                    href="/login"
                    className="font-semibold text-[var(--brand-primary)] hover:underline"
                  >
                    Request to connect
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
