import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import PublicShell from "@/components/public/PublicShell";
import { AvailabilityBadge } from "@/components/public/PublicClassCard";
import { createClient } from "@/lib/supabase/server";
import {
  fetchPublicGroupClass,
  formatClassDay,
  formatClassTimeRange,
  publicClassPath,
  publicSeriesPath,
  publicStudioClassesPath,
  sameStudioSlug,
  seriesPartLabel,
  studioLocationLabel,
  unavailableMessage,
} from "@/lib/public/groupClasses";
import { canProceedToRegister, classRegisterPath, registerUnavailableMessage } from "@/lib/public/classRegistration";

type PageProps = { params: Promise<{ studioSlug: string; appointmentId: string }> };

export const metadata: Metadata = { title: "Class" };

// Public and signed-out friendly; availability is read live from the database.
export const dynamic = "force-dynamic";

/**
 * Occurrence detail. The appointment id is the identity: a link survives title, time and room edits and S1C-5 splits, and a
 * wrong or outdated studio slug is corrected by redirect. Nothing is shown for a class that is not publicly discoverable.
 */
export default async function PublicClassDetailPage({ params }: PageProps) {
  const { studioSlug, appointmentId } = await params;
  const supabase = await createClient();
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) notFound();
  if (!sameStudioSlug(studioSlug, item.studioSlug)) redirect(publicClassPath(item.studioSlug, item.appointmentId));

  const unavailable = unavailableMessage(item.publicState);
  const place = studioLocationLabel(item.studioCity, item.studioState);

  return (
    <PublicShell currentPath="discover">
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
          <Link href={publicStudioClassesPath(item.studioSlug)} className="text-sm font-semibold text-[var(--brand-primary)] underline">
            All classes at {item.studioName}
          </Link>

          <div className="mt-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight text-slate-950">{item.title}</h1>
              <AvailabilityBadge item={item} />
            </div>

            {unavailable ? (
              <p role="status" className="mt-4 rounded-2xl bg-slate-100 px-4 py-3 text-sm font-medium text-slate-800">
                {unavailable}
              </p>
            ) : null}

            <dl className="mt-6 grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="font-semibold text-slate-500">When</dt>
                <dd className="mt-1 text-base font-medium text-slate-900">
                  {formatClassDay(item.startsAt, item.timeZone)}
                  <br />
                  {formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}
                </dd>
              </div>
              <div>
                <dt className="font-semibold text-slate-500">Studio</dt>
                <dd className="mt-1 text-base font-medium text-slate-900">
                  <Link href={`/studios/${encodeURIComponent(item.studioSlug)}`} className="underline">
                    {item.studioName}
                  </Link>
                  {place ? <span className="block text-sm font-normal text-slate-600">{place}</span> : null}
                </dd>
              </div>
              {item.locationLabel ? (
                <div>
                  <dt className="font-semibold text-slate-500">Location</dt>
                  <dd className="mt-1 text-base font-medium text-slate-900">{item.locationLabel}</dd>
                </div>
              ) : null}
              {item.instructorName ? (
                <div>
                  <dt className="font-semibold text-slate-500">Instructor</dt>
                  <dd className="mt-1 text-base font-medium text-slate-900">{item.instructorName}</dd>
                </div>
              ) : null}
              {item.capacity !== null && !unavailable ? (
                <div>
                  <dt className="font-semibold text-slate-500">Class size</dt>
                  <dd className="mt-1 text-base font-medium text-slate-900">Up to {item.capacity} dancers</dd>
                </div>
              ) : null}
            </dl>

            {item.seriesRootId ? (
              <p className="mt-6 text-sm text-slate-700">
                {seriesPartLabel(null)} ·{" "}
                <Link href={publicSeriesPath(item.studioSlug, item.seriesRootId)} className="font-semibold text-[var(--brand-primary)] underline">
                  See all dates
                </Link>
              </p>
            ) : null}

            {canProceedToRegister(item) ? (
              // GC-3.4B-1: one primary action into the authenticated identity step. This page itself stays auth-free.
              <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">Want to join this class?</p>
                <p className="mt-1">Continue with your DanceFlow account to get connected with {item.studioName}.</p>
                <Link
                  href={classRegisterPath(item.studioSlug, item.appointmentId)}
                  className="mt-3 inline-flex rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  Continue
                </Link>
              </div>
            ) : !unavailable ? (
              <div className="mt-8 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">{registerUnavailableMessage(item)}</p>
                <p className="mt-1">Visit the studio page to get in touch.</p>
                <Link
                  href={`/studios/${encodeURIComponent(item.studioSlug)}`}
                  className="mt-3 inline-flex rounded-2xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  View studio
                </Link>
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </PublicShell>
  );
}
