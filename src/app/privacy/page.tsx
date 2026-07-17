import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Privacy Policy | DanceFlow",
  description:
    "How DanceFlow handles account, studio, student, event, payment, messaging, document, AI, and Google Calendar information.",
  alternates: { canonical: "/privacy" },
};

export const DANCEFLOW_PRIVACY_VERSION = "2026-07-17";
const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function PrivacyPage() {
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
              Privacy Policy
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">Effective: {updated}</p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-6">
            <Section title="1. Scope and roles">
              <p>
                This Privacy Policy explains how DanceFlow collects, uses, discloses,
                and protects personal information through our websites, applications,
                studio software, portals, booking and event tools, payments,
                communications, documents, integrations, and support services.
              </p>
              <p>
                DanceFlow may act as a business or controller for account,
                subscription, website, security, and support information. For client,
                student, attendee, employee, contractor, and business records entered
                by a studio or organizer, that customer generally controls the data and
                DanceFlow processes it to provide the service.
              </p>
            </Section>

            <Section title="2. Information we collect">
              <ul className="list-disc space-y-2 pl-6">
                <li>Account and profile information, including name, email, phone, login, role, and preferences.</li>
                <li>Studio, organizer, staff, instructor, client, student, and relationship records.</li>
                <li>Schedules, attendance, packages, memberships, billing status, notes, goals, and lesson recaps.</li>
                <li>Event, registration, ticket, check-in, competition, and settlement information.</li>
                <li>Documents, signatures, uploaded files, photos, videos, and public profile content.</li>
                <li>Communications, consent records, opt-outs, support messages, and delivery information.</li>
                <li>Transaction records, invoices, refunds, disputes, and payment status.</li>
                <li>Device, browser, IP address, timestamps, logs, and security events.</li>
                <li>Integration information and tokens needed to operate connected services.</li>
              </ul>
              <p>
                Payment-card details are processed by Stripe or another payment
                provider. DanceFlow does not intentionally store full card numbers or
                card security codes on its servers.
              </p>
            </Section>

            <Section title="3. How we collect information">
              <p>
                We collect information directly from users, from studios and
                organizers, through use of the service, from connected integrations,
                from payment and communications providers, and from public or
                authorized business sources.
              </p>
            </Section>

            <Section title="4. How we use information">
              <ul className="list-disc space-y-2 pl-6">
                <li>Provide, authenticate, maintain, support, and improve DanceFlow.</li>
                <li>Create accounts, workspaces, portals, schedules, registrations, and documents.</li>
                <li>Process subscriptions, transactions, refunds, payouts, and related records.</li>
                <li>Send requested service, account, scheduling, event, email, SMS, and push communications.</li>
                <li>Operate AI-assisted features requested by authorized users.</li>
                <li>Prevent abuse, enforce permissions, troubleshoot, monitor reliability, and protect security.</li>
                <li>Comply with law, resolve disputes, and enforce agreements.</li>
              </ul>
            </Section>

            <Section title="5. AI-assisted features">
              <p>
                Authorized users may choose to submit workspace information to
                AI-assisted features for drafting, summarization, recommendations, or
                analysis. DanceFlow limits those requests to the information needed
                for the selected feature and applicable workspace context.
              </p>
              <p>
                Google Calendar API data is not transferred to OpenAI and is not used
                to train, fine-tune, or improve generalized artificial-intelligence or
                machine-learning models.
              </p>
            </Section>

            <Section title="6. Google Calendar data">
              <p>
                DanceFlow accesses Google Calendar only after an authorized user
                connects the integration. We use access to list available calendars,
                let the user select a destination, and create, update, or delete
                DanceFlow-generated calendar events according to enabled sync settings.
              </p>
              <p>
                DanceFlow does not sell Google user data, use it for advertising,
                profiling, or unrelated analytics, or transfer it except as needed to
                provide the requested integration, operate trusted infrastructure,
                protect security, or comply with law.
              </p>
              <p>
                Google OAuth tokens are stored encrypted and used only to maintain the
                requested integration. Users may disconnect Google Calendar from
                Studio Settings → Integrations → Google Calendar.
              </p>
              <p>
                DanceFlow&apos;s use and transfer of information received from Google
                APIs adheres to the Google API Services User Data Policy, including
                the Limited Use requirements.
              </p>
            </Section>

            <Section title="7. SMS and communications privacy">
              <p>
                We may process phone numbers, email addresses, consent status,
                opt-in source and timestamp, opt-out status, message content, and
                delivery records to provide requested communications and maintain
                compliance records.
              </p>
              <p>
                Mobile information and SMS consent records are not sold, rented, or
                shared with third parties or affiliates for their own marketing or
                promotional purposes. Users may reply STOP to opt out where supported.
                Additional information is available at{" "}
                <Link href="/sms-consent" className="font-semibold text-slate-950 underline">
                  SMS Consent and Messaging Terms
                </Link>
                .
              </p>
            </Section>

            <Section title="8. How we disclose information">
              <p>We may disclose information:</p>
              <ul className="list-disc space-y-2 pl-6">
                <li>To the studio, organizer, instructor, or business responsible for the relationship or record.</li>
                <li>To authorized users and participants according to workspace permissions and requested workflows.</li>
                <li>To providers supporting hosting, databases, authentication, payments, email, SMS, storage, monitoring, analytics, support, and AI features.</li>
                <li>When required by law or reasonably necessary to protect rights, safety, security, users, or the service.</li>
                <li>In connection with a merger, financing, acquisition, reorganization, or sale of relevant assets.</li>
              </ul>
              <p>DanceFlow does not sell personal information for third-party marketing.</p>
            </Section>

            <Section title="9. Cookies and similar technologies">
              <p>
                DanceFlow may use cookies, local storage, and similar technologies for
                authentication, security, preferences, performance, analytics, and
                feature operation. Browser controls may limit some technologies, but
                disabling them can affect functionality.
              </p>
            </Section>

            <Section title="10. Data retention">
              <p>
                Information is retained for as long as reasonably necessary to provide
                services, maintain customer-selected records, support security and
                backups, comply with legal, payment, tax, accounting, and dispute
                obligations, and enforce agreements.
              </p>
              <p>
                Retention varies by record type and account status. Some customer data
                may remain in protected backups for a limited period after deletion.
              </p>
            </Section>

            <Section title="11. Security">
              <p>
                DanceFlow uses administrative, technical, and organizational
                safeguards designed to protect information, including access controls,
                server-side authorization, database policies, protected links,
                validation, rate limiting, encrypted connections, and security
                monitoring where applicable. No method of transmission or storage is
                completely secure.
              </p>
              <p>
                Learn more on the{" "}
                <Link href="/security" className="font-semibold text-slate-950 underline">
                  Security page
                </Link>
                .
              </p>
            </Section>

            <Section title="12. Your choices and requests">
              <p>
                Depending on your location and relationship with DanceFlow, you may
                have rights to access, correct, delete, restrict, object to, or request
                portability of personal information.
              </p>
              <p>
                Requests concerning studio-controlled client, student, staff, or event
                records may need to be submitted to the applicable studio or organizer.
                DanceFlow may verify identity and retain information where legally or
                operationally required.
              </p>
            </Section>

            <Section title="13. Children and minors">
              <p>
                DanceFlow is not directed to children under 13 for unmanaged account
                creation. Studios serving minors should use appropriate parent,
                guardian, studio, or authorized-adult controls and collect only
                information needed for legitimate operations.
              </p>
              <p>
                Contact us if you believe a child&apos;s information was submitted
                without appropriate authorization.
              </p>
            </Section>

            <Section title="14. International use">
              <p>
                DanceFlow and its providers may process information in the United
                States and other countries. Where legally required, customers and
                DanceFlow may use contractual or other approved safeguards for
                international transfers.
              </p>
            </Section>

            <Section title="15. Changes to this policy">
              <p>
                We may update this Policy as services and legal requirements change.
                Material changes may be communicated through the service, email, or
                another reasonable method. The effective date identifies the current
                version.
              </p>
            </Section>

            <Section title="16. Contact">
              <p>
                Privacy questions and requests may be sent to{" "}
                <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                  support@idanceflow.com
                </a>
                . Please identify the relevant account, studio, organizer, or record
                so we can route the request appropriately.
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
