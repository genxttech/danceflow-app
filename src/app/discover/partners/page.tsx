import Link from "next/link";
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

export default async function PartnerSearchDiscoveryPage() {
  const profiles = await getPublishedPartnerProfiles();

  return (
    <main className="min-h-screen bg-slate-50">
      <section className="border-b bg-white">
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
              href="/get-started/explorer"
              className="inline-flex rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Create a dancer profile
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
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
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
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
