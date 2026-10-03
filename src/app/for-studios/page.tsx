import type { Metadata } from "next";
import PublicShell from "@/components/public/PublicShell";
import {
  AudienceClose,
  AudienceHero,
  AudienceSwitcher,
  ExpandableRows,
} from "@/components/public/audience/AudienceParts";
import { getPlansByAudience } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { STUDIOS_PAGE, SUPPORT_MAILTO } from "@/lib/public/audienceCopy";
import { buildTrialLine } from "@/lib/public/homeCopy";

export const metadata: Metadata = {
  title: STUDIOS_PAGE.metaTitle,
  description: STUDIOS_PAGE.metaDescription,
  alternates: { canonical: "/for-studios" },
};

export default async function ForStudiosPage() {
  const trialLine = buildTrialLine({
    trialDays: getPlansByAudience("studio")[0].trialDays,
    founderPricingActive: isFounderPricingActive(),
  });

  return (
    <PublicShell currentPath="business">
      <AudienceSwitcher active="studios" />

      <main className="bg-white">
        <AudienceHero
          eyebrow={STUDIOS_PAGE.eyebrow}
          headline={STUDIOS_PAGE.headline}
          support={STUDIOS_PAGE.support}
          cta={STUDIOS_PAGE.cta}
          trialLine={trialLine}
        />

        {/* The working week: expandable rows keep the page short. */}
        <section className="border-t border-slate-200 bg-slate-50/60">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {STUDIOS_PAGE.dayHeading}
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">{STUDIOS_PAGE.dayIntro}</p>
            <div className="mt-12">
              <ExpandableRows rows={STUDIOS_PAGE.dayRows} />
            </div>
          </div>
        </section>

        {/* The differentiator: attention, not just records. */}
        <section className="bg-[linear-gradient(135deg,#2e1065_0%,#5b145e_55%,#7c2d12_130%)] text-white">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
              {STUDIOS_PAGE.attentionHeading}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-white/85">{STUDIOS_PAGE.attentionBody}</p>
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/70">{STUDIOS_PAGE.attentionControl}</p>
          </div>
        </section>

        <section className="border-b border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {STUDIOS_PAGE.foundHeading}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-600">{STUDIOS_PAGE.foundBody}</p>
          </div>
        </section>

        <AudienceClose
          heading={STUDIOS_PAGE.closeHeading}
          cta={STUDIOS_PAGE.cta}
          trialLine={trialLine}
          supportHref={SUPPORT_MAILTO}
        />
      </main>
    </PublicShell>
  );
}
