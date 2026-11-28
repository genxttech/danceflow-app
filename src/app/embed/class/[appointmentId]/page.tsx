import type { Metadata } from "next";
import { notFound } from "next/navigation";
import EmbedFrame from "@/components/embed/EmbedFrame";
import { AvailabilityBadge } from "@/components/public/PublicClassCard";
import { createClient } from "@/lib/supabase/server";
import { zoneLabel } from "@/lib/public/embedCalendar";
import { parseEmbedOptions, readableTextOn } from "@/lib/public/embedOptions";
import {
  fetchPublicGroupClass,
  formatClassDay,
  formatClassTimeRange,
  publicClassPath,
  publicSeriesPath,
  seriesPartLabel,
  unavailableMessage,
} from "@/lib/public/groupClasses";
import { canProceedToRegister, classRegisterPath, registerUnavailableMessage } from "@/lib/public/classRegistration";
import { appearanceDefaults, fetchEmbedGate } from "@/lib/public/embedSettings";
import { fetchClassExtras } from "@/lib/public/embedClassExtras";

type PageProps = {
  params: Promise<{ appointmentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export const metadata: Metadata = { title: "Class", robots: { index: false, follow: false } };

// Live from the database on every view; short caching is the CDN's job, never a stale registration state.
export const dynamic = "force-dynamic";

/**
 * Embeddable single group class. Data comes ONLY from the public read model (publicly_discoverable class of a public,
 * active studio), so an unpublished class, another studio's private data or a deleted class is simply "not found".
 * Registration is a link into the existing DanceFlow flow in a new tab; nothing is collected or paid inside this frame.
 */
export default async function EmbedClassPage({ params, searchParams }: PageProps) {
  const { appointmentId } = await params;
  const rawParams = await searchParams;
  const supabase = await createClient();
  const item = await fetchPublicGroupClass(supabase, appointmentId);
  if (!item) notFound();

  // The studio's kill switch: switched off (or settings unreadable) means the embed is not served at all.
  const gate = await fetchEmbedGate(supabase, item.studioSlug);
  if (gate.state !== "ok") notFound();
  const options = parseEmbedOptions(rawParams, appearanceDefaults(gate.settings));
  const extra =
    gate.settings.showClassDescription || gate.settings.showClassPrice
      ? (await fetchClassExtras(supabase, item.studioSlug, [item.appointmentId])).get(item.appointmentId)
      : undefined;

  const unavailable = unavailableMessage(item.publicState);
  const dark = options.theme === "dark";
  const muted = dark ? "text-slate-300" : "text-slate-600";
  const tz = zoneLabel(item.startsAt, item.timeZone);
  const btn =
    "inline-flex items-center justify-center rounded-xl bg-[var(--embed-accent)] px-4 py-2.5 text-sm font-semibold text-[var(--embed-accent-text)] hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--embed-accent)]";

  return (
    <EmbedFrame accent={options.accent} accentText={readableTextOn(options.accent)} theme={options.theme}>
      <article className={`rounded-2xl border p-4 sm:p-5 ${dark ? "border-slate-700 bg-slate-800" : "border-slate-200 bg-white"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight">{item.title}</h1>
          <AvailabilityBadge item={item} />
        </div>
        <p className={`mt-1 text-sm ${muted}`}>{item.studioName}</p>

        {unavailable ? (
          <p role="status" className={`mt-3 rounded-xl px-3 py-2 text-sm font-medium ${dark ? "bg-slate-700 text-slate-100" : "bg-slate-100 text-slate-800"}`}>
            {unavailable}
          </p>
        ) : null}

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className={`font-semibold ${muted}`}>When</dt>
            <dd className="mt-0.5 font-medium">
              {formatClassDay(item.startsAt, item.timeZone)}
              <br />
              {formatClassTimeRange(item.startsAt, item.endsAt, item.timeZone)}
              {tz ? <span className={`ml-1 font-normal ${muted}`}>{tz}</span> : null}
            </dd>
          </div>
          {item.locationLabel ? (
            <div>
              <dt className={`font-semibold ${muted}`}>Location</dt>
              <dd className="mt-0.5 font-medium">{item.locationLabel}</dd>
            </div>
          ) : null}
          {item.instructorName ? (
            <div>
              <dt className={`font-semibold ${muted}`}>Instructor</dt>
              <dd className="mt-0.5 font-medium">{item.instructorName}</dd>
            </div>
          ) : null}
          {extra?.priceLabel ? (
            <div>
              <dt className={`font-semibold ${muted}`}>Price</dt>
              <dd className="mt-0.5 font-medium">{extra.priceLabel}</dd>
            </div>
          ) : null}
          {item.capacity !== null && !unavailable ? (
            <div>
              <dt className={`font-semibold ${muted}`}>Class size</dt>
              <dd className="mt-0.5 font-medium">Up to {item.capacity} dancers</dd>
            </div>
          ) : null}
        </dl>

        {extra?.description ? <p className={`mt-3 whitespace-pre-line text-sm ${muted}`}>{extra.description}</p> : null}

        {item.seriesRootId ? (
          <p className={`mt-3 text-sm ${muted}`}>
            {seriesPartLabel(null)} ·{" "}
            <a
              href={publicSeriesPath(item.studioSlug, item.seriesRootId)}
              target="_blank"
              rel="noopener"
              className="font-semibold underline"
            >
              See all dates
            </a>
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {canProceedToRegister(item) ? (
            <a href={classRegisterPath(item.studioSlug, item.appointmentId)} target="_blank" rel="noopener" className={btn}>
              Register
              <span className="sr-only"> for {item.title} (opens in a new tab)</span>
            </a>
          ) : !unavailable ? (
            <p className={`text-sm font-medium ${muted}`}>{registerUnavailableMessage(item)}</p>
          ) : null}
          <a
            href={publicClassPath(item.studioSlug, item.appointmentId)}
            target="_blank"
            rel="noopener"
            className={`text-sm font-semibold underline ${muted}`}
          >
            Class details
          </a>
        </div>
      </article>
      <p className={`mt-2 text-right text-[11px] ${dark ? "text-slate-400" : "text-slate-500"}`}>
        Powered by{" "}
        <a href="https://www.idanceflow.com" target="_blank" rel="noopener" className="underline">
          DanceFlow
        </a>
      </p>
    </EmbedFrame>
  );
}
