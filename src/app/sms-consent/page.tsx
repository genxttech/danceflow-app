import Link from "next/link";

const consentDisclosure =
  "I agree to receive text messages from my dance studio through DanceFlow, including appointment reminders, schedule updates, event reminders, ticket notifications, and client service messages. Message frequency varies. Message and data rates may apply. Reply HELP for help. Reply STOP to unsubscribe. Consent is not required to purchase or use services.";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-slate-700">{children}</div>
    </section>
  );
}

export const metadata = {
  title: "SMS Consent | DanceFlow",
  description:
    "DanceFlow SMS consent process, opt-in language, message types, and opt-out instructions.",
};

export default function SmsConsentPage() {
  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)] text-slate-900">
      <div className="mx-auto max-w-5xl px-6 py-12 sm:py-16">
        <div className="rounded-[2rem] border border-orange-100 bg-white/90 p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
            DanceFlow SMS Consent
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
            SMS opt-in and messaging disclosures
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-8 text-slate-700">
            DanceFlow provides communication tools that allow participating dance studios and event organizers to send service-related text messages to students, clients, leads, attendees, and registered participants who have opted in.
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
            This page is publicly available so end users, studios, organizers, and compliance reviewers can verify how SMS consent is collected and what disclosures are shown.
          </p>
        </div>

        <div className="mt-8 grid gap-6">
          <Section title="Who sends messages">
            <p>
              Messages are sent by a dance studio, event organizer, or DanceFlow-powered workspace using DanceFlow. DanceFlow may provide the software and messaging infrastructure, but the message relationship is between the end user and the studio or organizer they are working with.
            </p>
          </Section>

          <Section title="Types of messages">
            <p>Text messages may include service-related communications such as:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Appointment confirmations and reminders</li>
              <li>Schedule changes and lesson updates</li>
              <li>Event reminders and registration updates</li>
              <li>Ticket, check-in, and event attendance information</li>
              <li>Floor rental confirmations and reminders</li>
              <li>Client service follow-up related to the studio or organizer</li>
            </ul>
          </Section>

          <Section title="How users opt in">
            <p>
              Users opt in by providing a mobile phone number and agreeing to receive SMS messages through a clear consent disclosure. Consent may be collected through one of these paths:
            </p>
            <ul className="list-disc space-y-2 pl-6">
              <li>A DanceFlow client portal profile or account page</li>
              <li>A DanceFlow public booking, inquiry, or registration form</li>
              <li>A studio or organizer staff workflow after the user gives permission during a direct client relationship</li>
            </ul>
            <p>
              SMS consent is optional. Consent is not required to create an account, register for an event, buy a ticket, book a lesson, or receive services.
            </p>
          </Section>

          <Section title="Consent disclosure shown to users">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-slate-800">
              <p className="font-semibold text-slate-950">SMS consent checkbox language</p>
              <p className="mt-3">{consentDisclosure}</p>
            </div>
            <p>
              The SMS consent checkbox should be unchecked by default. Users must actively choose to opt in before service-related text messages are sent through DanceFlow.
            </p>
          </Section>

          <Section title="Message frequency, rates, and opt-out">
            <p>
              Message frequency varies depending on the user's activity with the studio or organizer. Message and data rates may apply depending on the user's wireless carrier and plan.
            </p>
            <p>
              Users can opt out at any time by replying <strong>STOP</strong>. Users can reply <strong>HELP</strong> for help.
            </p>
          </Section>

          <Section title="Privacy and data sharing">
            <p>
              Mobile phone numbers and SMS consent records are not sold, rented, or shared with third parties or affiliates for their own marketing or promotional purposes.
            </p>
            <p>
              SMS opt-in data and consent records are used to provide requested messaging services and to operate, secure, and support the DanceFlow platform.
            </p>
          </Section>

          <Section title="Terms and privacy links">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Link
                href="/terms-and-conditions"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Terms and Conditions
              </Link>
              <Link
                href="/privacy-policy"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Privacy Policy
              </Link>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
