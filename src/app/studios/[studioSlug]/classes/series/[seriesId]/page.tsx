import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import PublicShell from "@/components/public/PublicShell";
import { AvailabilityBadge } from "@/components/public/PublicClassCard";
import { createClient } from "@/lib/supabase/server";
import {
  fetchPublicGroupClasses,
  fetchPublicGroupClassSeries,
  formatClassDay,
  formatClassTimeRange,
  publicClassPath,
  publicSeriesPath,
  publicStudioClassesPath,
  studioLocationLabel,
} from "@/lib/public/groupClasses";

type PageProps = { params: Promise<{ studioSlug: string; seriesId: string }> };

export const metadata: Metadata = { title: "Class series" };

// Public and signed-out friendly; availability is read live from the database.
export const dynamic = "force-dynamic";

/**
 * A read-only grouping of the upcoming dates of one recurring class. The series id may be any series in the lineage (an S1C-5
 * split keeps the earlier classes in the original series and moves later ones to a successor); the canonical link uses the
 * lineage root. Every date is still its own real class with its own id and link.
 */
export default async function PublicClassSeriesPage({ params }: PageProps) {
  const { studioSlug, seriesId } = await params;
  const supabase = await createClient();
  const series = await fetchPublicGroupClassSeries(supabase, seriesId);
  if (!series) notFound();
  if (series.studioSlug !== studioSlug || series.seriesRootId !== seriesId) {
    redirect(publicSeriesPath(series.studioSlug, series.seriesRootId));
  }

  const classes = await fetchPublicGroupClasses(supabase, { seriesId: series.seriesRootId, limit: 100 });
  const place = studioLocationLabel(series.studioCity, series.studioState);
  const first = classes[0];

  return (
    <PublicShell currentPath="discover">
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
          <Link href={publicStudioClassesPath(series.studioSlug)} className="text-sm font-semibold text-[var(--brand-primary)] underline">
            All classes at {series.studioName}
          </Link>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">{series.title}</h1>
          <p className="mt-2 text-sm text-slate-600">
            {series.studioName}
            {place ? ` · ${place}` : ""}
            {first?.instructorName ? ` · with ${first.instructorName}` : ""}
            {first?.locationLabel ? ` · ${first.locationLabel}` : ""}
          </p>

          <h2 className="mt-8 text-lg font-semibold text-slate-950">Upcoming dates</h2>
          {classes.length === 0 ? (
            <p className="mt-3 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-700">
              There are no upcoming dates for this class right now.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {classes.map((item) => (
                <li key={item.appointmentId}>
                  <Link
                    href={publicClassPath(item.studioSlug, item.appointmentId)}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950"
                  >
                    <span>
                      <span className="block text-base font-semibold text-slate-950">{formatClassDay(item.startsAt, item.timeZone)}</span>
                      <span className="block text-sm text-slate-600">{formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}</span>
                    </span>
                    <AvailabilityBadge item={item} />
                    <span className="sr-only">View class on {formatClassDay(item.startsAt, item.timeZone)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </PublicShell>
  );
}
