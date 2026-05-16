import type { Metadata } from "next";
import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Terms of Service | DanceFlow",
  description: "Rules and responsibilities for using DanceFlow.",
};

const updated = "May 15, 2026";

export default function Page() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />

      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14 sm:py-18">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow policy
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Terms of Service
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Last updated: {updated}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-8 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Use of DanceFlow</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow provides software tools for dance studios, independent instructors, organizers, and dancers, including discovery, event management, scheduling, client management, payments, and portal features.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">You agree to use the platform lawfully, keep account credentials secure, and not misuse, disrupt, scrape, reverse engineer, or attempt unauthorized access to DanceFlow or another workspace.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Studio and organizer responsibility</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studios and organizers are responsible for the accuracy of their public listings, events, schedules, prices, ticket terms, refund rules, client records, and communications.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studios and organizers are also responsible for complying with laws that apply to their business, including consumer, privacy, tax, accessibility, and event-related obligations.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Payments and subscriptions</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Platform subscriptions, event payments, guest coach lessons, and other payments may be processed by Stripe. Fees, renewals, cancellation terms, and connected-account payout timing may depend on the applicable plan, Stripe settings, and payment method.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Failure to maintain an active subscription may limit access to paid features and public discovery exposure.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Minor users</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Children under 13 should not create unmanaged DanceFlow accounts. A parent, guardian, studio, or authorized adult should manage minor/student participation and account access where applicable.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Content and public listings</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Users are responsible for the content they upload or publish, including logos, photos, event descriptions, schedules, and links. DanceFlow may remove content that appears unlawful, misleading, abusive, infringing, or harmful to the service.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Account suspension or termination</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow may restrict or terminate access for nonpayment, security risk, abuse, legal concerns, or violation of these terms. Studios may lose public discovery eligibility when subscription access is inactive.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Disclaimers and limitation of liability</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow is provided as a software service and may change over time. To the maximum extent allowed by law, DanceFlow is not responsible for indirect, incidental, special, consequential, or punitive damages.</p>
            </section>

          </div>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
            Questions about this page? Contact{" "}
            <a className="font-semibold text-slate-950 hover:underline" href="mailto:support@idanceflow.com">
              support@idanceflow.com
            </a>
            .
          </div>

          <div className="mt-8">
            <Link href="/" className="text-sm font-semibold text-slate-700 hover:text-slate-950">
              ← Back to DanceFlow
            </Link>
          </div>
        </section>
      </main>

      
      <PublicSiteFooter />
    </>
  );
}
