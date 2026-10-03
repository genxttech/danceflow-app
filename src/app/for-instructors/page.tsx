import type { Metadata } from "next";
import PublicShell from "@/components/public/PublicShell";
import {
  AudienceClose,
  AudienceHero,
  AudienceSwitcher,
} from "@/components/public/audience/AudienceParts";
import { getPlansByAudience } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { INSTRUCTORS_PAGE, SUPPORT_MAILTO } from "@/lib/public/audienceCopy";
import { buildTrialLine } from "@/lib/public/homeCopy";

export const metadata: Metadata = {
  title: INSTRUCTORS_PAGE.metaTitle,
  description: INSTRUCTORS_PAGE.metaDescription,
  alternates: { canonical: "/for-instructors" },
};

export default async function ForInstructorsPage() {
  // Independent instructors use the studio plans, so the trial wording comes from the studio plan.
  const trialLine = buildTrialLine({
    trialDays: getPlansByAudience("studio")[0].trialDays,
    founderPricingActive: isFounderPricingActive(),
    audience: "instructors",
  });

  return (
    <PublicShell currentPath="business">
      <AudienceSwitcher active="instructors" />

      <main className="bg-white">
        <AudienceHero
          eyebrow={INSTRUCTORS_PAGE.eyebrow}
          headline={INSTRUCTORS_PAGE.headline}
          support={INSTRUCTORS_PAGE.support}
          cta={INSTRUCTORS_PAGE.cta}
          trialLine={trialLine}
        />

        {/* A teaching cycle: three short columns, no cards. */}
        <section className="border-t border-slate-200 bg-slate-50/60">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {INSTRUCTORS_PAGE.stagesHeading}
            </h2>
            <div className="mt-12 grid gap-10 sm:grid-cols-3">
              {INSTRUCTORS_PAGE.stages.map((stage) => (
                <div key={stage.title} className="border-t-2 border-[var(--brand-accent)] pt-5">
                  <h3 className="text-xl font-semibold text-slate-950">{stage.title}</h3>
                  <p className="mt-3 text-base leading-7 text-slate-600">{stage.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* The honest transition: what "studio plan" means for a one-person business. */}
        <section className="border-b border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {INSTRUCTORS_PAGE.startHeading}
            </h2>
            <p className="mt-4 max-w-3xl text-lg leading-8 text-slate-600">{INSTRUCTORS_PAGE.startIntro}</p>

            <ol className="mt-10 grid gap-8 sm:grid-cols-3">
              {INSTRUCTORS_PAGE.steps.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand-primary-soft)] text-sm font-semibold text-[var(--brand-primary)]"
                  >
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-lg font-semibold text-slate-950">{step.title}</p>
                    <p className="mt-1 text-base leading-7 text-slate-600">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <AudienceClose
          heading={INSTRUCTORS_PAGE.closeHeading}
          cta={INSTRUCTORS_PAGE.cta}
          trialLine={trialLine}
          supportHref={SUPPORT_MAILTO}
        />
      </main>
    </PublicShell>
  );
}
