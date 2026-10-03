import type { Metadata } from "next";
import PublicShell from "@/components/public/PublicShell";
import {
  AudienceClose,
  AudienceHero,
  AudienceSwitcher,
} from "@/components/public/audience/AudienceParts";
import { getPlansByAudience } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { ORGANIZERS_PAGE, SUPPORT_MAILTO } from "@/lib/public/audienceCopy";
import { buildTrialLine } from "@/lib/public/homeCopy";

export const metadata: Metadata = {
  title: ORGANIZERS_PAGE.metaTitle,
  description: ORGANIZERS_PAGE.metaDescription,
  alternates: { canonical: "/for-organizers" },
};

export default async function ForOrganizersPage() {
  const trialLine = buildTrialLine({
    trialDays: getPlansByAudience("organizer")[0].trialDays,
    founderPricingActive: isFounderPricingActive(),
    audience: "organizers",
  });

  return (
    <PublicShell currentPath="business">
      <AudienceSwitcher active="organizers" />

      <main className="bg-white">
        <AudienceHero
          eyebrow={ORGANIZERS_PAGE.eyebrow}
          headline={ORGANIZERS_PAGE.headline}
          support={ORGANIZERS_PAGE.support}
          cta={ORGANIZERS_PAGE.cta}
          trialLine={trialLine}
        />

        {/* The event lifecycle as one ordered path. */}
        <section className="border-t border-slate-200 bg-slate-50/60">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {ORGANIZERS_PAGE.flowHeading}
            </h2>

            <ol className="mt-12 space-y-10">
              {ORGANIZERS_PAGE.flow.map((step, index) => (
                <li key={step.title} className="grid gap-3 sm:grid-cols-[4rem_minmax(0,12rem)_1fr] sm:gap-8">
                  <span
                    aria-hidden="true"
                    className="text-4xl font-semibold leading-none text-[var(--brand-accent)]"
                  >
                    {index + 1}
                  </span>
                  <h3 className="text-xl font-semibold text-slate-950">{step.title}</h3>
                  <p className="text-base leading-7 text-slate-600">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-b border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {ORGANIZERS_PAGE.peopleHeading}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">{ORGANIZERS_PAGE.peopleBody}</p>
          </div>
        </section>

        <AudienceClose
          heading={ORGANIZERS_PAGE.closeHeading}
          cta={ORGANIZERS_PAGE.cta}
          trialLine={trialLine}
          note={ORGANIZERS_PAGE.pricingNote}
          supportHref={SUPPORT_MAILTO}
        />
      </main>
    </PublicShell>
  );
}
