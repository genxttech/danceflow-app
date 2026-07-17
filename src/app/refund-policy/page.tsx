import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Refund Policy | DanceFlow",
  description: "DanceFlow subscription refunds and studio or organizer customer-sale refund responsibilities.",
  alternates: { canonical: "/refund-policy" },
};

const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function RefundPolicyPage() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow legal
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Refund Policy
            </h1>
            <p className="mt-4 text-slate-600">Effective: {updated}</p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl space-y-6 px-6 py-10">
          <Section title="DanceFlow subscriptions and add-ons">
            <p>
              Subscription and add-on charges are billed according to the selected
              plan and billing interval. Unless required by law or stated in a
              separate written agreement, charges already paid are generally
              non-refundable and are not prorated for a partially used billing period.
            </p>
            <p>
              Canceling stops future renewal charges but does not automatically refund
              a completed charge. Contact support promptly if you believe DanceFlow
              billed a subscription in error.
            </p>
          </Section>

          <Section title="Trials">
            <p>
              Trial terms are disclosed during signup or checkout. A payment method
              may be required. When automatic conversion is disclosed, the selected
              plan may begin billing when the trial ends unless canceled beforehand.
            </p>
          </Section>

          <Section title="Studio and organizer customer sales">
            <p>
              Studios and organizers control their own policies for lessons, packages,
              memberships, floor rentals, registrations, tickets, competitions, guest
              coach lessons, and other customer purchases.
            </p>
            <p>
              For sales processed through a studio or organizer&apos;s connected
              payment account, that studio or organizer is generally the merchant and
              is responsible for fulfillment, cancellations, refunds, customer
              support, and disputes. Contact the seller identified in the receipt or
              event listing first.
            </p>
          </Section>

          <Section title="Processing fees and platform fees">
            <p>
              Payment-processing fees, connected-account fees, and DanceFlow platform
              fees may not be recoverable after a transaction is processed. Whether a
              seller returns those amounts to a buyer depends on the seller&apos;s
              policy, payment-provider rules, and applicable law.
            </p>
          </Section>

          <Section title="Refund timing">
            <p>
              Approved card refunds may take several business days to appear and are
              subject to Stripe, the connected account, card-network rules, and the
              buyer&apos;s financial institution. DanceFlow cannot accelerate a
              refund after the payment provider has accepted it.
            </p>
          </Section>

          <Section title="Disputes and chargebacks">
            <p>
              Buyers should contact the applicable studio or organizer before filing a
              payment dispute. Connected-account sellers are responsible for
              responding to chargebacks and providing supporting records through their
              payment provider.
            </p>
          </Section>

          <Section title="Event changes and cancellations">
            <p>
              Event postponements, location or schedule changes, attendee substitutions,
              ticket transfers, and cancellation refunds are controlled by the event
              organizer&apos;s published terms unless applicable law requires
              otherwise.
            </p>
          </Section>

          <Section title="Consumer rights">
            <p>
              Nothing in this Policy limits non-waivable consumer rights or remedies
              available under applicable law.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              For DanceFlow subscription billing, email{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>
              . For a studio or organizer purchase, contact the seller shown on the
              receipt, registration, event page, or payment description.
            </p>
          </Section>

          <Link href="/terms" className="inline-flex text-sm font-semibold text-slate-700 hover:text-slate-950">
            ← Return to SaaS Terms
          </Link>
        </section>
      </main>
      <PublicSiteFooter />
    </>
  );
}
