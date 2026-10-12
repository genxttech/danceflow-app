/**
 * Presentational pieces of the public event page (src/app/events/[slug]/page.tsx), shared with the
 * Competition Setup Wizard's "Event page" preview so the preview is the real event page markup, not a
 * second event page system. Text is rendered as plain text (no HTML), exactly as the public page does.
 */

export function EventCoverImage({ url, alt }: { url: string | null; alt: string }) {
  return (
    <div className="aspect-[16/7] w-full bg-slate-100">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- event covers are arbitrary public storage URLs
        <img src={url} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center bg-[linear-gradient(135deg,#f8fafc_0%,#ede9fe_40%,#fff7ed_100%)] text-sm text-slate-500">
          Event image coming soon
        </div>
      )}
    </div>
  );
}

/** The hero title and summary line (the summary falls back to the description, as on the public page). */
export function EventHeroText({ name, summary, description }: { name: string; summary: string | null; description: string | null }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-5xl">{name}</h1>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-white/90 sm:text-base">{summary || description || "Public event details coming soon."}</p>
    </div>
  );
}

export function EventDescriptionBody({ description }: { description: string | null }) {
  return (
    <div className="mt-5 rounded-2xl border border-fuchsia-100 bg-white p-5 text-base leading-8 text-slate-700 shadow-sm">
      {description ? <p className="whitespace-pre-wrap">{description}</p> : <p>Full public event details are coming soon.</p>}
    </div>
  );
}

/** Event highlights (nothing is rendered when there are none). */
export function EventHighlights({ highlights }: { highlights: string[] | null | undefined }) {
  const items = (highlights ?? []).filter((item) => item.trim());
  if (items.length === 0) return null;
  return (
    <div className="mt-5 rounded-2xl border border-fuchsia-100 bg-white p-5 shadow-sm">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-fuchsia-700">Highlights</h3>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-700">
        {items.map((item, index) => (
          <li key={`${index}:${item}`} className="flex gap-2">
            <span aria-hidden="true" className="text-fuchsia-500">★</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Important registration information (nothing is rendered when there is none). */
export function EventRegistrationInfo({ info }: { info: string | null | undefined }) {
  if (!info?.trim()) return null;
  return (
    <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-800">Important registration information</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-800">{info}</p>
    </div>
  );
}
