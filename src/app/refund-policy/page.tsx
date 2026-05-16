import type { Metadata } from "next";
import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";


export const metadata: Metadata = {
  title: "Refund Policy | DanceFlow",
  description: "Subscription, event, registration, and guest coach lesson refund guidance.",
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
              Refund Policy
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Last updated: {updated}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-8 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <section>
              <h2 className="text-xl font-semibold text-slate-950">DanceFlow subscriptions</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Subscription fees are generally billed through Stripe according to the selected plan and billing interval. Unless a separate written agreement says otherwise, subscription charges are not automatically refunded for partial billing periods.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Cancellation stops future renewal charges but may not immediately refund amounts already paid.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Studio event tickets and registrations</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studios and organizers are responsible for their own event ticket, registration, cancellation, and refund policies. DanceFlow provides software and payment tools but does not decide whether a studio or organizer approves a refund.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Guest coach private lesson slots</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Guest coach private lesson refunds are controlled by the event organizer or studio unless DanceFlow is explicitly listed as the seller. Buyers should review the event or studio policy before booking.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Refund timing may depend on Stripe, card networks, and the connected account handling the payment.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Payment disputes</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">If you believe a charge was made in error, contact the studio/organizer first when the charge relates to their event, class, or service. For DanceFlow subscription billing questions, contact support@idanceflow.com.</p>
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
