import Link from "next/link";
import { ArrowRight, ChevronDown } from "lucide-react";
import {
  AUDIENCE_LINKS,
  DANCER_LINK,
  type AudienceKey,
  type ProofRow,
} from "@/lib/public/audienceCopy";

/**
 * BR-4B: small building blocks shared by the three audience pages. Each page composes them
 * differently on purpose; only the repeated mechanics (switcher, hero, CTA, expandable rows)
 * live here.
 */

export const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

export const primaryButton = `inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-primary)] px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-[var(--brand-primary-dark)] ${focusRing}`;

/** Quiet cross-links between the business audiences, plus the dancer path (Discover). */
export function AudienceSwitcher({ active }: { active: AudienceKey }) {
  return (
    <nav aria-label="DanceFlow audiences" className="border-b border-slate-200 bg-white">
      <ul className="mx-auto flex max-w-7xl flex-wrap gap-x-6 gap-y-1 px-6 py-2 text-sm lg:px-8">
        {AUDIENCE_LINKS.map((link) => (
          <li key={link.key}>
            <Link
              href={link.href}
              aria-current={link.key === active ? "page" : undefined}
              className={`inline-block py-1.5 font-medium ${focusRing} ${
                link.key === active
                  ? "text-[var(--brand-primary)] underline underline-offset-8"
                  : "text-slate-600 hover:text-slate-900"
              }`}
            >
              {link.label}
            </Link>
          </li>
        ))}
        <li>
          <Link
            href={DANCER_LINK.href}
            className={`inline-block py-1.5 font-medium text-slate-600 hover:text-slate-900 ${focusRing}`}
          >
            {DANCER_LINK.label}
          </Link>
        </li>
      </ul>
    </nav>
  );
}

export function AudienceHero({
  eyebrow,
  headline,
  support,
  cta,
  trialLine,
  children,
}: {
  eyebrow: string;
  headline: string;
  support: string;
  cta: { label: string; href: string };
  trialLine: string;
  children?: React.ReactNode;
}) {
  return (
    <section className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_top_left,rgba(216,138,45,0.16),transparent_48%),radial-gradient(circle_at_top_right,rgba(91,20,94,0.12),transparent_45%)]"
      />
      <div className="relative mx-auto max-w-5xl px-6 py-16 sm:py-20 lg:px-8 lg:py-24">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
          {eyebrow}
        </p>
        <h1 className="mt-5 max-w-3xl text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
          {headline}
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">{support}</p>

        <div className="mt-9 flex flex-col items-start gap-3">
          <Link href={cta.href} className={primaryButton}>
            {cta.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <p className="text-sm text-slate-500">{trialLine}</p>
        </div>

        {children}
      </div>
    </section>
  );
}

/** Row list with the supporting capabilities revealed on demand. */
export function ExpandableRows({ rows }: { rows: readonly ProofRow[] }) {
  return (
    <div className="divide-y divide-slate-200 border-y border-slate-200">
      {rows.map((row) => (
        <details key={row.title} className="group py-6">
          <summary
            className={`flex cursor-pointer list-none items-start justify-between gap-6 rounded-lg ${focusRing}`}
          >
            <span className="grid gap-2 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-10">
              <span className="text-xl font-semibold text-slate-950">{row.title}</span>
              <span className="text-base leading-7 text-slate-600">{row.summary}</span>
            </span>
            <ChevronDown
              className="mt-1 h-5 w-5 shrink-0 text-slate-400 transition group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <ul className="mt-5 space-y-2 text-sm leading-6 text-slate-700 sm:ml-[16.5rem]">
            {row.proof.map((item) => (
              <li key={item} className="flex gap-3">
                <span
                  aria-hidden="true"
                  className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--brand-accent)]"
                />
                {item}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function AudienceClose({
  heading,
  cta,
  trialLine,
  note,
  supportHref,
}: {
  heading: string;
  cta: { label: string; href: string };
  trialLine: string;
  note?: string;
  supportHref: string;
}) {
  return (
    <section className="bg-slate-50/60">
      <div className="mx-auto max-w-4xl px-6 py-20 text-center lg:px-8 lg:py-24">
        <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">{heading}</h2>
        <div className="mt-9 flex flex-col items-center gap-4">
          <Link href={cta.href} className={primaryButton}>
            {cta.label}
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
          <p className="text-sm text-slate-500">{trialLine}</p>
          {note ? <p className="max-w-xl text-sm leading-6 text-slate-500">{note}</p> : null}
          <a
            href={supportHref}
            className={`inline-block py-1.5 text-sm font-semibold text-slate-600 underline-offset-4 hover:underline ${focusRing}`}
          >
            Questions? Talk to us
          </a>
        </div>
      </div>
    </section>
  );
}
