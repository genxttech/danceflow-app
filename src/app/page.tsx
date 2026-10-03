import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { ExpandableRows } from "@/components/public/audience/AudienceParts";
import { getPlansByAudience } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import {
  HOME_AUDIENCES,
  HOME_AUDIENCE_HEADING,
  HOME_CONCEPTS,
  HOME_DISCOVERY,
  HOME_FINAL_CTA,
  HOME_HERO,
  HOME_JSON_LD,
  HOME_TRUST,
  HOME_WORK_HEADING,
  HOME_WORK_INTRO,
  buildTrialLine,
} from "@/lib/public/homeCopy";

// The root layout no longer sets a site-wide canonical (it was inherited by every page); the home page keeps its own.
export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
};

/**
 * Keeps the em dash attached to the words around it, so the headline never wraps with a
 * dash opening a line. The copy itself stays a single string in homeCopy.ts.
 */
function renderHeadline(headline: string) {
  const [lead, tail] = headline.split("—");
  if (tail === undefined) return headline;

  const leadWords = lead.trim().split(" ");
  const lastLeadWord = leadWords.pop();
  const tailWords = tail.trim().split(" ");
  const firstTailWord = tailWords.shift();

  return (
    <>
      {leadWords.join(" ")}{" "}
      <span className="whitespace-nowrap">
        {lastLeadWord}—{firstTailWord}
      </span>{" "}
      {tailWords.join(" ")}
    </>
  );
}

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

export default async function HomePage() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  let dashboardHref = "/login";
  let dashboardLabel = "Log In";

  if (user) {
    const platformRole = await getCurrentUserPlatformRole();

    if (platformRole === "platform_admin") {
      dashboardHref = "/platform";
      dashboardLabel = "Platform Dashboard";
    } else {
      const { data: studioRole } = await supabase
        .from("user_studio_roles")
        .select("studio_id")
        .eq("user_id", user.id)
        .eq("active", true)
        .limit(1)
        .maybeSingle();

      if (studioRole) {
        dashboardHref = "/app";
        dashboardLabel = "Open your workspace";
      } else {
        dashboardHref = "/account";
        dashboardLabel = "My Account";
      }
    }
  }

  // Trial length and founder wording come from the same pricing logic the pricing pages use.
  const studioPlan = getPlansByAudience("studio")[0];
  const trialLine = buildTrialLine({
    trialDays: studioPlan.trialDays,
    founderPricingActive: isFounderPricingActive(),
  });

  const finalCta = user
    ? { label: dashboardLabel, href: dashboardHref }
    : HOME_FINAL_CTA.primaryCta;

  const siteUrl = "https://www.idanceflow.com";

  const organizationJsonLd = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "DanceFlow",
    url: siteUrl,
    logo: `${siteUrl}/brand/logo/danceflow-logo-primary-640.png`,
    description: HOME_JSON_LD.organization,
  };

  const websiteJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "DanceFlow",
    url: siteUrl,
    description: HOME_JSON_LD.website,
    publisher: {
      "@type": "Organization",
      name: "DanceFlow",
      url: siteUrl,
    },
  };

  const softwareApplicationJsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "DanceFlow",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: siteUrl,
    description: HOME_JSON_LD.application,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: HOME_JSON_LD.offer,
    },
    publisher: {
      "@type": "Organization",
      name: "DanceFlow",
      url: siteUrl,
    },
  };

  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: siteUrl,
      },
    ],
  };

  return (
    <>
      <JsonLd
        data={[
          organizationJsonLd,
          websiteJsonLd,
          softwareApplicationJsonLd,
          breadcrumbJsonLd,
        ]}
      />

      <PublicSiteHeader currentPath="home" isAuthenticated={Boolean(user)} />

      <main className="bg-white">
        {/* 1. Hero: one promise, one primary action, one quiet path. */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top_left,rgba(216,138,45,0.18),transparent_48%),radial-gradient(circle_at_top_right,rgba(91,20,94,0.14),transparent_45%)]"
          />

          <div className="relative mx-auto max-w-7xl px-6 py-16 sm:py-20 lg:px-8 lg:py-28">
            <div className="grid gap-14 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                  {HOME_HERO.eyebrow}
                </p>

                <h1 className="mt-5 max-w-3xl text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                  {renderHeadline(HOME_HERO.headline)}
                </h1>

                <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-600">
                  {HOME_HERO.support}
                </p>

                <div className="mt-9 flex flex-col items-start gap-4">
                  <Link
                    href={HOME_HERO.primaryCta.href}
                    className={`inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-primary)] px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-[var(--brand-primary-dark)] ${focusRing}`}
                  >
                    {HOME_HERO.primaryCta.label}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>

                  <p className="text-sm text-slate-500">{trialLine}</p>

                  <Link
                    href={HOME_HERO.secondaryCta.href}
                    className={`inline-block py-1.5 text-sm font-semibold text-[var(--brand-primary)] underline-offset-4 hover:underline ${focusRing}`}
                  >
                    {HOME_HERO.secondaryCta.label}
                  </Link>
                </div>
              </div>

              <div className="relative">
                <div className="overflow-hidden rounded-[2rem] bg-white shadow-[0_30px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-200">
                  <Image
                    src="/brand/danceflow-home-hero.png"
                    alt={HOME_HERO.imageAlt}
                    width={1400}
                    height={1000}
                    className="h-auto w-full"
                    priority
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 2. How DanceFlow helps do the work: four concepts, proof on demand. */}
        <section className="border-t border-slate-200 bg-slate-50/60">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {HOME_WORK_HEADING}
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">{HOME_WORK_INTRO}</p>

            <div className="mt-12">
              <ExpandableRows rows={HOME_CONCEPTS} />
            </div>
          </div>
        </section>

        {/* 3. Who it is for: one compact list, not four cards. */}
        <section className="border-t border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {HOME_AUDIENCE_HEADING}
            </h2>

            <ul className="mt-10 divide-y divide-slate-200 border-y border-slate-200">
              {HOME_AUDIENCES.map((audience) => (
                <li key={audience.name}>
                  <Link
                    href={audience.href}
                    className={`group flex flex-col gap-2 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8 ${focusRing}`}
                  >
                    <span className="grid gap-1 sm:grid-cols-[minmax(0,15rem)_1fr] sm:gap-10">
                      <span className="text-lg font-semibold text-slate-950">{audience.name}</span>
                      <span className="text-base text-slate-600">{audience.line}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-2 text-sm font-semibold text-[var(--brand-primary)]">
                      {audience.cta}
                      <ArrowRight
                        className="h-4 w-4 transition group-hover:translate-x-1"
                        aria-hidden="true"
                      />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 4. Discovery: the dancer-facing side of the network, stated accurately. */}
        <section className="bg-[linear-gradient(135deg,#2e1065_0%,#5b145e_55%,#7c2d12_130%)] text-white">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
              {HOME_DISCOVERY.heading}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-white/80">{HOME_DISCOVERY.body}</p>

            <ul className="mt-9 flex flex-wrap gap-x-8 gap-y-3">
              {HOME_DISCOVERY.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="inline-flex items-center gap-2 py-1.5 text-base font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                  >
                    {link.label}
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 5. Trust: a few concrete, true statements. */}
        <section className="border-b border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {HOME_TRUST.heading}
            </h2>

            <dl className="mt-10 grid gap-10 sm:grid-cols-3">
              {HOME_TRUST.items.map((item) => (
                <div key={item.title}>
                  <dt className="text-lg font-semibold text-slate-950">{item.title}</dt>
                  <dd className="mt-2 text-base leading-7 text-slate-600">{item.body}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold">
              {HOME_TRUST.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`inline-block py-1.5 text-[var(--brand-primary)] underline-offset-4 hover:underline ${focusRing}`}
                >
                  {link.label}
                </Link>
              ))}
            </p>
          </div>
        </section>

        {/* 6. Final call to action: one clear conversion. */}
        <section className="bg-slate-50/60">
          <div className="mx-auto max-w-4xl px-6 py-20 text-center lg:px-8 lg:py-24">
            <h2 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {HOME_FINAL_CTA.heading}
            </h2>

            <div className="mt-9 flex flex-col items-center gap-4">
              <Link
                href={finalCta.href}
                className={`inline-flex items-center gap-2 rounded-2xl bg-[var(--brand-primary)] px-7 py-4 text-base font-semibold text-white shadow-sm transition hover:bg-[var(--brand-primary-dark)] ${focusRing}`}
              >
                {finalCta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>

              {user ? null : <p className="text-sm text-slate-500">{trialLine}</p>}

              <a
                href={HOME_FINAL_CTA.supportLink.href}
                className={`inline-block py-1.5 text-sm font-semibold text-slate-600 underline-offset-4 hover:underline ${focusRing}`}
              >
                {HOME_FINAL_CTA.supportLink.label}
              </a>
            </div>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
