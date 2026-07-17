import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "SaaS Terms | DanceFlow",
  description:
    "Terms governing DanceFlow studio, organizer, scheduling, payment, messaging, AI, document, and event-management services.",
  alternates: { canonical: "/terms" },
};

export const DANCEFLOW_TERMS_VERSION = "2026-07-17";
const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow legal
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              SaaS Terms
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">Effective: {updated}</p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
              These SaaS Terms govern access to DanceFlow. By creating an account,
              starting a trial, purchasing a subscription, managing a workspace, or
              otherwise using DanceFlow, you agree to these Terms.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-6">
            <Section title="1. DanceFlow services">
              <p>
                DanceFlow provides software for dance studios, independent instructors,
                event organizers, and dancers. Features may include client management,
                scheduling, packages and memberships, payments, event registration and
                ticketing, discovery pages, marketing, documents and electronic
                signatures, AI-assisted tools, communications, reporting, accounting,
                payroll preparation, and integrations.
              </p>
              <p>
                DanceFlow provides software tools and does not operate a customer&apos;s
                studio, lessons, events, employment relationships, or professional
                services unless separately agreed in writing.
              </p>
            </Section>

            <Section title="2. Eligibility, accounts, and authority">
              <p>
                You must provide accurate account information and protect your login
                credentials. You are responsible for activity performed through your
                account and for promptly removing access that is no longer authorized.
              </p>
              <p>
                When accepting these Terms for a studio, organizer, or other business,
                you represent that you have authority to bind that organization.
                Workspace owners are responsible for assigning appropriate roles and
                permissions to staff, instructors, contractors, and other users.
              </p>
            </Section>

            <Section title="3. Customer responsibilities">
              <p>
                Customers are responsible for the accuracy, lawfulness, and quality of
                information, content, schedules, prices, policies, records, documents,
                messages, and instructions they enter into DanceFlow.
              </p>
              <p>
                Customers remain responsible for compliance with laws applicable to
                their business, including consumer protection, employment, tax,
                accessibility, marketing, messaging, music licensing, privacy,
                recordkeeping, and minor-safety requirements.
              </p>
            </Section>

            <Section title="4. Customer data and privacy">
              <p>
                As between the parties, customers retain their rights in the data they
                submit to DanceFlow. Customers authorize DanceFlow to host, process,
                transmit, back up, and otherwise use customer data as needed to provide,
                secure, support, and improve the services.
              </p>
              <p>
                Our handling of personal information is described in the{" "}
                <Link href="/privacy" className="font-semibold text-slate-950 underline">
                  Privacy Policy
                </Link>
                . When DanceFlow processes personal data for a business customer, the{" "}
                <Link href="/dpa" className="font-semibold text-slate-950 underline">
                  Data Processing Addendum
                </Link>{" "}
                may also apply.
              </p>
            </Section>

            <Section title="5. Subscriptions, trials, and fees">
              <p>
                Paid services are billed according to the selected plan, billing
                interval, add-ons, and published pricing. Trials may convert to paid
                subscriptions unless canceled before the trial ends, as disclosed at
                checkout.
              </p>
              <p>
                Taxes, payment-processing charges, ticketing platform fees, and other
                charges may apply. DanceFlow may change pricing prospectively after
                providing notice required by applicable law or the applicable order.
              </p>
              <p>
                Failed or overdue payment may result in restricted paid features,
                suspended checkout, reduced public visibility, or account suspension.
              </p>
            </Section>

            <Section title="6. Payment processing and connected accounts">
              <p>
                Payment services may be provided by Stripe or another payment provider.
                Their terms, identity verification, processing rules, payout timing,
                reserves, disputes, and chargeback procedures may apply.
              </p>
              <p>
                For studio or organizer sales processed through a connected payment
                account, the applicable studio or organizer is responsible for the
                underlying goods or services, customer support, fulfillment, refunds,
                disputes, and taxes. DanceFlow may collect disclosed platform fees from
                eligible organizer or ticketing transactions.
              </p>
            </Section>

            <Section title="7. Events, registrations, and refunds">
              <p>
                Studios and organizers control their event details, capacity, schedules,
                ticket terms, waivers, refund rules, cancellations, transfers, and
                attendee requirements. Buyers should review the seller&apos;s posted
                policies before purchasing.
              </p>
              <p>
                DanceFlow subscription refunds and customer-sale refunds are further
                described in the{" "}
                <Link href="/refund-policy" className="font-semibold text-slate-950 underline">
                  Refund Policy
                </Link>
                .
              </p>
            </Section>

            <Section title="8. Communications">
              <p>
                Customers may use DanceFlow to send transactional or marketing email,
                SMS, push notifications, and related communications. Customers must have
                a lawful basis and any required consent before contacting a person, and
                must honor opt-outs, unsubscribe requests, quiet-hour rules, and sender
                identification requirements.
              </p>
              <p>
                SMS consent is optional and is not a condition of purchase. Additional
                SMS disclosures are available in the{" "}
                <Link href="/sms-consent" className="font-semibold text-slate-950 underline">
                  SMS Consent and Messaging Terms
                </Link>
                .
              </p>
            </Section>

            <Section title="9. Documents and electronic signatures">
              <p>
                Customers are responsible for the content, suitability, and legal
                enforceability of documents, waivers, releases, and agreements they
                create or send through DanceFlow.
              </p>
              <p>
                Electronic-signature use is subject to the{" "}
                <Link href="/electronic-signature-consent" className="font-semibold text-slate-950 underline">
                  Electronic Records and Signature Consent
                </Link>
                . DanceFlow may preserve signature records, timestamps, document hashes,
                consent text, and related audit information.
              </p>
            </Section>

            <Section title="10. AI-assisted features">
              <p>
                AI-assisted output is provided as a drafting and analysis aid. It may be
                incomplete, inaccurate, or unsuitable for a particular situation.
                Customers must review and approve output before sending, publishing,
                relying on, or acting on it.
              </p>
              <p>
                Do not submit information to an AI feature unless you are authorized to
                use it for that purpose. AI features do not provide legal, tax,
                accounting, medical, employment, insurance, safety, or financial advice.
              </p>
            </Section>

            <Section title="11. Acceptable use">
              <p>
                You must comply with the{" "}
                <Link href="/acceptable-use" className="font-semibold text-slate-950 underline">
                  Acceptable Use Policy
                </Link>
                , which is incorporated into these Terms.
              </p>
            </Section>

            <Section title="12. Integrations and third-party services">
              <p>
                DanceFlow may connect with third-party services such as payment,
                calendar, database, email, SMS, analytics, accounting, and storage
                providers. Third-party services are governed by their own terms and may
                change or become unavailable.
              </p>
              <p>
                Customers authorize DanceFlow to exchange the information needed to
                provide enabled integrations. Customers may disconnect supported
                integrations through available settings.
              </p>
            </Section>

            <Section title="13. Intellectual property">
              <p>
                DanceFlow and its licensors retain all rights in the platform,
                software, branding, documentation, workflows, and related technology.
                Subject to these Terms and payment of applicable fees, DanceFlow grants
                you a limited, non-exclusive, non-transferable right to use the service
                during the applicable subscription period.
              </p>
              <p>
                You may provide feedback. You authorize DanceFlow to use feedback
                without restriction or payment, provided it does not identify
                confidential customer information.
              </p>
            </Section>

            <Section title="14. Confidentiality">
              <p>
                Each party may receive non-public information from the other. The
                receiving party will use reasonable care to protect confidential
                information and use it only for the relationship, except where
                disclosure is authorized or legally required.
              </p>
            </Section>

            <Section title="15. Security and service availability">
              <p>
                DanceFlow uses administrative, technical, and organizational safeguards
                designed to protect the service. No service can guarantee absolute
                security or uninterrupted availability. Customers are responsible for
                secure account administration, authorized use, and appropriate backups
                or exports of records they must independently retain.
              </p>
              <p>
                DanceFlow may perform maintenance, modify features, impose reasonable
                usage limits, or discontinue functionality. We will use commercially
                reasonable efforts to reduce material disruption.
              </p>
            </Section>

            <Section title="16. Suspension and termination">
              <p>
                You may stop using DanceFlow or cancel a subscription through available
                account controls. DanceFlow may suspend or terminate access for
                nonpayment, security risk, unlawful conduct, abuse, violation of these
                Terms, or risk to users or the service.
              </p>
              <p>
                Upon termination, access may end. Data may be retained or deleted
                according to the Privacy Policy, DPA, legal obligations, backup cycles,
                and applicable account controls.
              </p>
            </Section>

            <Section title="17. Disclaimers">
              <p>
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, DANCEFLOW IS PROVIDED “AS IS”
                AND “AS AVAILABLE.” DANCEFLOW DISCLAIMS IMPLIED WARRANTIES OF
                MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, NON-INFRINGEMENT,
                AND ANY WARRANTY ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.
              </p>
            </Section>

            <Section title="18. Limitation of liability">
              <p>
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, DANCEFLOW WILL NOT BE LIABLE
                FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR
                PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE, BUSINESS, GOODWILL, OR
                DATA.
              </p>
              <p>
                TO THE MAXIMUM EXTENT PERMITTED BY LAW, DANCEFLOW&apos;S AGGREGATE
                LIABILITY ARISING FROM THE SERVICE WILL NOT EXCEED THE AMOUNTS PAID
                TO DANCEFLOW FOR THE AFFECTED SERVICE DURING THE TWELVE MONTHS BEFORE
                THE EVENT GIVING RISE TO THE CLAIM.
              </p>
              <p>
                These limitations do not apply where prohibited by law and do not
                limit rights that cannot lawfully be waived.
              </p>
            </Section>

            <Section title="19. Indemnification">
              <p>
                To the extent permitted by law, a business customer will defend and
                indemnify DanceFlow against third-party claims arising from the
                customer&apos;s services, events, content, documents, communications,
                unlawful use, or violation of another person&apos;s rights, except to
                the extent caused by DanceFlow&apos;s breach of these Terms.
              </p>
            </Section>

            <Section title="20. Governing law and disputes">
              <p>
                These Terms are governed by the laws of the State of Ohio, without
                regard to conflict-of-law rules. Unless applicable law requires
                otherwise, disputes will be brought in the state or federal courts
                serving the Ohio county in which DanceFlow&apos;s principal place of
                business is located, and each party consents to that jurisdiction.
              </p>
            </Section>

            <Section title="21. Changes and notices">
              <p>
                DanceFlow may update these Terms. Material changes will be communicated
                through the service, email, or another reasonable method. A new version
                may require affirmative acceptance before continued use.
              </p>
              <p>
                Notices to DanceFlow may be sent to{" "}
                <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                  support@idanceflow.com
                </a>
                .
              </p>
            </Section>

            <Section title="22. General terms">
              <p>
                These Terms, incorporated policies, applicable orders, and any signed
                agreement form the entire agreement for the service. If a provision is
                unenforceable, the remaining provisions remain effective. Failure to
                enforce a provision is not a waiver. You may not assign these Terms
                without DanceFlow&apos;s written consent, except in connection with a
                permitted merger or sale of substantially all relevant assets.
              </p>
            </Section>
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
