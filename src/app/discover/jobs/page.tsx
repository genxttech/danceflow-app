import Link from "next/link";
import { NearMeButton } from "../NearMeButton";
import {
  formatEmploymentType,
  formatJobRole,
  getPublishedStudioJobPostings,
} from "@/lib/jobPostings";

export const metadata = {
  title: "Dance Jobs | DanceFlow",
  description:
    "Browse studio hiring posts for instructors, coaches, front desk roles, event staff, and dance operations jobs.",
};

type SearchParams = Promise<{
  employmentType?: string;
  lat?: string;
  lng?: string;
  locationType?: string;
  q?: string;
  radius?: string;
  roleType?: string;
  style?: string;
}>;

const roleOptions = ["instructor", "coach", "front_desk", "event_staff", "admin", "other"];
const employmentOptions = ["contract", "part_time", "full_time", "employee", "temporary", "volunteer"];
const locationOptions = ["in_person", "hybrid", "remote"];
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

function numberParam(value: string | undefined) {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function NowHiringDiscoveryPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const postings = await getPublishedStudioJobPostings({
    employmentType: query.employmentType,
    latitude: numberParam(query.lat),
    locationType: query.locationType,
    longitude: numberParam(query.lng),
    query: query.q,
    radiusMiles: numberParam(query.radius) ?? 50,
    roleType: query.roleType,
    style: query.style,
  });

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b border-indigo-100 bg-gradient-to-br from-white via-white to-indigo-50">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--brand-primary)]">
            Now Hiring
          </p>
          <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950 md:text-4xl">
                Dance studio openings
              </h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
                Find instructor, coaching, front desk, event staff, and studio
                operations opportunities from DanceFlow studios.
              </p>
            </div>
            <Link
              href="/get-started/studio"
              className="inline-flex rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Post a studio job
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <form className="mb-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="grid gap-3 md:grid-cols-3">
            <input
              name="q"
              defaultValue={query.q ?? ""}
              placeholder="Search jobs, studios, cities, or styles"
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm md:col-span-3"
            />
            <select
              name="roleType"
              defaultValue={query.roleType ?? ""}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Any role</option>
              {roleOptions.map((role) => (
                <option key={role} value={role}>
                  {formatJobRole(role)}
                </option>
              ))}
            </select>
            <select
              name="employmentType"
              defaultValue={query.employmentType ?? ""}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Any employment</option>
              {employmentOptions.map((employment) => (
                <option key={employment} value={employment}>
                  {formatEmploymentType(employment)}
                </option>
              ))}
            </select>
            <select
              name="locationType"
              defaultValue={query.locationType ?? ""}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="">Any location type</option>
              {locationOptions.map((locationType) => (
                <option key={locationType} value={locationType}>
                  {locationType.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <select
              name="style"
              defaultValue={query.style ?? ""}
              className="rounded-xl border border-slate-200 px-3 py-2 text-sm md:col-span-2"
            >
              <option value="">Any dance style</option>
              {danceStyleGroups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  <option value={group.label}>{group.label} - all styles</option>
                  {group.styles.map((style) => (
                    <option key={style} value={style}>
                      {style}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <select
              name="radius"
              defaultValue={query.radius ?? "50"}
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
              href="/discover/jobs"
              className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Clear
            </Link>
            <NearMeButton />
          </div>
        </form>
        {postings.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center">
            <h2 className="text-lg font-semibold text-slate-950">
              No job postings yet
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Published studio hiring posts will appear here.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {postings.map((posting) => (
              <article
                key={posting.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div>
                    <p className="text-sm font-medium text-slate-500">
                      {posting.studioName}
                    </p>
                    <h2 className="mt-1 text-2xl font-semibold text-slate-950">
                      {posting.title}
                    </h2>
                    <p className="mt-2 text-sm text-slate-600">
                      {posting.location}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <span className="rounded-full bg-purple-50 px-3 py-1 text-xs font-semibold text-purple-700 ring-1 ring-purple-100">
                      {formatJobRole(posting.roleType)}
                    </span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700">
                      {formatEmploymentType(posting.employmentType)}
                    </span>
                  </div>
                </div>

                {posting.description ? (
                  <p className="mt-4 line-clamp-3 text-sm leading-6 text-slate-600">
                    {posting.description}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  {posting.danceStyles.slice(0, 5).map((style) => (
                    <span
                      key={style}
                      className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-orange-700"
                    >
                      {style}
                    </span>
                  ))}
                </div>

                <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4 text-sm text-slate-600 md:flex-row md:items-center md:justify-between">
                  <div>
                    {posting.compensationSummary ? (
                      <p>{posting.compensationSummary}</p>
                    ) : (
                      <p>Compensation details provided by the studio.</p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    {posting.applyUrl ? (
                      <a
                        href={posting.applyUrl}
                        rel="noreferrer"
                        target="_blank"
                        className="font-semibold text-[var(--brand-primary)] hover:underline"
                      >
                        Apply
                      </a>
                    ) : null}
                    {posting.applyEmail ? (
                      <a
                        href={`mailto:${posting.applyEmail}`}
                        className="font-semibold text-[var(--brand-primary)] hover:underline"
                      >
                        Apply by email
                      </a>
                    ) : null}
                    {posting.applyPhone ? (
                      <a
                        href={`tel:${posting.applyPhone}`}
                        className="font-semibold text-[var(--brand-primary)] hover:underline"
                      >
                        Call to apply
                      </a>
                    ) : null}
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
