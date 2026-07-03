import Link from "next/link";
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

export default async function NowHiringDiscoveryPage() {
  const postings = await getPublishedStudioJobPostings();

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b bg-white">
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
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
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
                  {posting.applyUrl ? (
                    <Link
                      href={posting.applyUrl}
                      className="font-semibold text-[var(--brand-primary)] hover:underline"
                    >
                      Apply
                    </Link>
                  ) : posting.applyEmail ? (
                    <a
                      href={`mailto:${posting.applyEmail}`}
                      className="font-semibold text-[var(--brand-primary)] hover:underline"
                    >
                      Apply by email
                    </a>
                  ) : null}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
