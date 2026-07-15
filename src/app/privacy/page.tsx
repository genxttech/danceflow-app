import type { Metadata } from "next";
import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";


export const metadata: Metadata = {
  title: "Privacy Policy | DanceFlow",
  description: "How DanceFlow handles personal information, studio data, student data, payments, Google Calendar integration data, and data requests.",
};

const updated = "July 15, 2026";

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
              Privacy Policy
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Last updated: {updated}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-8 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <section>
              <h2 className="text-xl font-semibold text-slate-950">What DanceFlow collects</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow collects account, contact, studio, event, scheduling, registration, and payment-related information needed to provide the platform. This may include names, email addresses, phone numbers, studio/client records, lesson details, event registrations, and public profile content that studios choose to publish.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Payment card details are processed by Stripe. DanceFlow does not intentionally store full card numbers or security codes on its servers.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">How information is used</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">We use information to operate DanceFlow, authenticate users, provide studio CRM and scheduling tools, process registrations and payments, show public discovery listings, send service messages, improve the platform, and protect against fraud or misuse.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studios and organizers are responsible for the client, student, event, and business data they add to their workspace and for obtaining any permissions required from their own clients or attendees.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Service providers</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow may use vendors such as hosting, database, email, payment, analytics, monitoring, and support providers to operate the service. These providers should only receive information needed to perform their services.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-slate-950">Google Calendar data use</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow only accesses Google Calendar after a studio owner or authorized studio user connects Google Calendar from the DanceFlow integration settings.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow uses Google Calendar access to list available calendars, allow the user to select a destination calendar, and create, update, or delete DanceFlow-generated calendar events.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow may sync DanceFlow schedule items such as private lessons, group classes, and studio events to the selected Google Calendar according to the studio’s enabled sync settings.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow does not sell Google user data, does not use Google Calendar data for advertising, and does not transfer Google Calendar data except as necessary to provide the calendar sync feature, comply with law, protect the security of the service, or operate the service with trusted infrastructure providers.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow stores Google OAuth tokens encrypted and uses them only to maintain the calendar sync requested by the connected studio.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Users can disconnect Google Calendar at any time from DanceFlow Settings → Integrations → Google Calendar.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow’s use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements. DanceFlow uses Google Calendar API access only to allow authorized users to select a calendar and synchronize DanceFlow-created appointments and events to that calendar. DanceFlow does not import Google Calendar event content into its artificial-intelligence features, transfer Google Calendar API data to OpenAI, or use Google API data to train, fine-tune, or improve generalized artificial-intelligence or machine-learning models.</p>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-slate-950">Minor/student data</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Dance studios may serve minors. Minor profiles should be managed by a parent, guardian, studio, or authorized adult. Children under 13 should not create unmanaged DanceFlow accounts.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studios should avoid entering sensitive information about minors unless it is necessary for scheduling, attendance, registration, or safety-related operations.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Your choices and data requests</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">You may contact DanceFlow to request access, correction, export, or deletion of personal information. Some requests may need to be handled by the studio or organizer that controls the underlying client or event record.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">We may retain certain information when needed for legal, payment, fraud-prevention, tax, accounting, dispute, or security purposes.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Security</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow uses role-based access, server-side authorization checks, Supabase row-level security where applicable, and Stripe-hosted payment handling. No online service can guarantee perfect security, but we work to protect platform data and improve controls over time.</p>
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