import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUserPlatformRole } from "@/lib/auth/platform";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicVideoPlayer from "@/components/public/PublicVideoPlayer";
import type { Metadata } from "next";
import { JsonLd } from "@/components/seo/JsonLd";
import { ExpandableRows } from "@/components/public/audience/AudienceParts";
import { getPlansByAudience } from "@/lib/billing/plans";
import { isFounderPricingActive } from "@/lib/billing/founderPricing";
import { fetchDiscoverCounts } from "@/lib/public/discoverSummary";
import { getPublicVideo } from "@/lib/public/publicVideos";
import {
  HOME_ARIA,
  HOME_AUDIENCES,
  HOME_BUSINESS,
  HOME_CONCEPTS,
  HOME_CONNECTS,
  HOME_DISCOVERY,
  HOME_DOORS,
  HOME_FINAL_CTA,
  HOME_HERO,
  HOME_JSON_LD,
  HOME_TRUST,
  buildTrialLine,
  type HomeDoor,
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

const primaryButton = `inline-flex items-center justify-center gap-2 rounded-2xl bg-[var(--brand-primary)] px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-[var(--brand-primary-dark)] ${focusRing}`;

const quietLink = `inline-block py-1.5 text-sm font-semibold text-[var(--brand-primary)] underline-offset-4 hover:underline ${focusRing}`;

/** One hero door: the two are rendered with identical structure and weight. */
function Door({ door, note }: { door: HomeDoor; note?: string }) {
  return (
    <div className="flex flex-col rounded-3xl border border-[var(--brand-border)] bg-white/90 p-6 shadow-sm sm:p-8">
      <h2 className="text-xl font-semibold text-slate-950">{door.heading}</h2>
      <p className="mt-2 flex-1 text-base leading-7 text-slate-600">{door.body}</p>
      <div className="mt-6 flex flex-col items-start gap-3">
        <Link href={door.primaryCta.href} className={primaryButton}>
          {door.primaryCta.label}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
        {note ? <p className="text-sm text-slate-500">{note}</p> : null}
        <Link href={door.secondaryLink.href} className={quietLink}>
          {door.secondaryLink.label}
        </Link>
      </div>
    </div>
  );
}

export default async function HomePage() {
  const supabase = await createClient();

  const [
    {
      data: { user },
    },
    discoverCounts,
  ] = await Promise.all([supabase.auth.getUser(), fetchDiscoverCounts(supabase)]);

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

  const [dancerDoor, businessDoor] = HOME_DOORS;
  const ariaVideo = getPublicVideo("aria30");

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
    // The studio directory already accepts a free-text `q` filter.
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${siteUrl}/discover/studios?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
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
        {/* 1. Hero: one promise, two equal doors (dancers first on mobile, left on desktop). */}
        <section className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-96 bg-[radial-gradient(circle_at_top_left,rgba(216,138,45,0.18),transparent_48%),radial-gradient(circle_at_top_right,rgba(91,20,94,0.14),transparent_45%)]"
          />

          <div className="relative mx-auto max-w-6xl px-6 py-16 sm:py-20 lg:px-8 lg:py-24">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#9a5a10]">
                {HOME_HERO.eyebrow}
              </p>

              <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl lg:text-6xl">
                {renderHeadline(HOME_HERO.headline)}
              </h1>

              <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-600">
                {HOME_HERO.support}
              </p>
            </div>

            <div className="mt-12 grid gap-6 md:grid-cols-2">
              <Door door={dancerDoor} />
              <Door door={businessDoor} note={trialLine} />
            </div>
          </div>
        </section>

        {/* 2. Dancers: the Discover paths, with live counts where they exist. */}
        <section
          aria-labelledby="home-dancers"
          className="bg-[linear-gradient(135deg,#2e1065_0%,#5b145e_55%,#7c2d12_130%)] text-white"
        >
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-white/75">
              {HOME_DISCOVERY.eyebrow}
            </p>
            <h2 id="home-dancers" className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">
              {HOME_DISCOVERY.heading}
            </h2>
            <p className="mt-5 max-w-3xl text-lg leading-8 text-white/80">{HOME_DISCOVERY.body}</p>

            <ul className="mt-10 grid gap-x-10 border-t border-white/20 sm:grid-cols-2">
              {HOME_DISCOVERY.links.map((link) => {
                const count = link.countKey ? discoverCounts[link.countKey] : 0;
                return (
                  <li key={link.href} className="border-b border-white/20">
                    <Link
                      href={link.href}
                      className="group flex items-center justify-between gap-4 py-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                    >
                      <span>
                        <span className="block text-lg font-semibold">
                          {link.label}
                          {count > 0 ? (
                            <span className="ml-2 text-sm font-medium text-white/70">{count} listed</span>
                          ) : null}
                        </span>
                        <span className="mt-1 block text-sm text-white/75">{link.line}</span>
                      </span>
                      <ArrowRight
                        className="h-5 w-5 shrink-0 transition group-hover:translate-x-1"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-8">
              <Link
                href={HOME_DISCOVERY.primaryCta.href}
                className="inline-flex items-center gap-2 rounded-2xl bg-white px-6 py-3.5 text-base font-semibold text-[var(--brand-primary)] shadow-sm transition hover:bg-[var(--brand-primary-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
              >
                {HOME_DISCOVERY.primaryCta.label}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
              {user ? null : (
                <Link
                  href={HOME_DISCOVERY.accountLink.href}
                  className="inline-block py-1.5 text-sm font-semibold text-white underline decoration-white/40 underline-offset-4 hover:decoration-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
                >
                  {HOME_DISCOVERY.accountLink.label}
                </Link>
              )}
            </div>
          </div>
        </section>

        {/* 3. Dance businesses: the three audiences, then how the software helps. */}
        <section aria-labelledby="home-business" className="border-b border-slate-200">
          <div className="mx-auto max-w-5xl px-6 py-20 lg:px-8 lg:py-24">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#9a5a10]">
              {HOME_BUSINESS.eyebrow}
            </p>
            <h2
              id="home-business"
              className="mt-4 max-w-3xl text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl"
            >
              {renderHeadline(HOME_BUSINESS.heading)}
            </h2>
            <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-600">{HOME_BUSINESS.intro}</p>

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

            <h3 className="mt-16 text-2xl font-semibold tracking-tight text-slate-950">
              {HOME_BUSINESS.conceptsHeading}
            </h3>
            <div className="mt-8">
              <ExpandableRows rows={HOME_CONCEPTS} />
            </div>

            <p className="mt-8">
              <Link href={HOME_BUSINESS.plansLink.href} className={quietLink}>
                {HOME_BUSINESS.plansLink.label}
              </Link>
            </p>
          </div>
        </section>

        {/* 4. How it connects: the ecosystem loop between both audiences. */}
        <section aria-labelledby="home-connects" className="bg-slate-50/60">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-8 lg:py-24">
            <div className="grid gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:items-center">
              <div>
                <h2 id="home-connects" className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
                  {HOME_CONNECTS.heading}
                </h2>
                <ol className="mt-10 space-y-8">
                  {HOME_CONNECTS.steps.map((step, index) => (
                    <li key={step.title} className="flex gap-5">
                      <span
                        aria-hidden="true"
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--brand-primary-soft)] text-sm font-semibold text-[var(--brand-primary)]"
                      >
                        {index + 1}
                      </span>
                      <span>
                        <span className="block text-lg font-semibold text-slate-950">{step.title}</span>
                        <span className="mt-1 block text-base leading-7 text-slate-600">{step.body}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>

              <div className="overflow-hidden rounded-3xl bg-white shadow-[0_30px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-200">
                <Image
                  src="/brand/danceflow-home-hero.png"
                  alt={HOME_CONNECTS.imageAlt}
                  width={1400}
                  height={1000}
                  sizes="(min-width: 1024px) 560px, 100vw"
                  className="h-auto w-full"
                />
              </div>
            </div>
          </div>
        </section>

        {/* 5. Meet ARIA: secondary, viewer-started; text-only until the owner configures the video URL. */}
        <section aria-labelledby="home-aria" className="border-t border-slate-200">
          <div className="mx-auto max-w-6xl px-6 py-20 lg:px-8 lg:py-24">
            <div
              className={
                ariaVideo ? "grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center" : "max-w-3xl"
              }
            >
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#9a5a10]">
                  {HOME_ARIA.eyebrow}
                </p>
                <h2 id="home-aria" className="mt-4 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
                  {HOME_ARIA.heading}
                </h2>
                <p className="mt-4 text-base leading-7 text-slate-600">{HOME_ARIA.body}</p>
                <p className="mt-6">
                  <Link href={HOME_ARIA.fullVideoLink.href} className={quietLink}>
                    {HOME_ARIA.fullVideoLink.label}
                  </Link>
                </p>
              </div>

              {ariaVideo ? <PublicVideoPlayer video={ariaVideo} title={HOME_ARIA.videoTitle} /> : null}
            </div>
          </div>
        </section>

        {/* 6. Trust: a few concrete, true statements. */}
        <section className="border-y border-slate-200">
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

        {/* 7. Final call to action: the two doors again, or one role-aware action when signed in. */}
        <section className="bg-slate-50/60">
          <div className="mx-auto max-w-4xl px-6 py-20 text-center lg:px-8 lg:py-24">
            <h2 className="text-balance text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              {HOME_FINAL_CTA.heading}
            </h2>

            <div className="mt-9 flex flex-col items-center gap-4">
              {user ? (
                <Link href={dashboardHref} className={primaryButton}>
                  {dashboardLabel}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              ) : (
                <>
                  <div className="flex w-full flex-col items-stretch gap-3 sm:w-auto sm:flex-row sm:items-center">
                    <Link href={dancerDoor.primaryCta.href} className={primaryButton}>
                      {dancerDoor.primaryCta.label}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                    <Link href={businessDoor.primaryCta.href} className={primaryButton}>
                      {businessDoor.primaryCta.label}
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </div>
                  <p className="text-sm text-slate-500">{trialLine}</p>
                </>
              )}

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
