import Link from "next/link";

const consentDisclosure =
  "I agree to receive text messages from DanceFlow and/or the participating dance studio or event organizer related to my lessons, bookings, event registrations, ticket/check-in information, schedule updates, account notices, and reminders. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe. Reply HELP for help. Consent is not a condition of purchase.";

function Section({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      {eyebrow ? (
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-orange-700">
          {eyebrow}
        </p>
      ) : null}
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-4 space-y-4 text-sm leading-7 text-slate-700">{children}</div>
    </section>
  );
}

function ConsentPathCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-semibold text-slate-950">{title}</h3>
      <div className="mt-2 text-sm leading-6 text-slate-700">{children}</div>
    </div>
  );
}

export const metadata = {
  title: "SMS Consent & Messaging Terms | DanceFlow",
  description:
    "Public DanceFlow SMS consent verification page with opt-in methods, consent language, message types, and opt-out instructions.",
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
            SMS Consent & Messaging Terms
          </h1>
          <p className="mt-5 max-w-3xl text-base leading-8 text-slate-700">
            DanceFlow provides communication tools that allow participating dance studios and event organizers to send service-related text messages to students, clients, leads, attendees, and registered participants who have opted in.
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
            This public page is provided so end users, studios, organizers, and compliance reviewers can verify DanceFlow SMS consent language, opt-in methods, message types, and opt-out instructions without accessing private student, client, or event registration accounts.
          </p>
        </div>

        <div className="mt-8 grid gap-6">
          <Section title="Reviewer verification" eyebrow="A2P 10DLC campaign review">
            <p>
              Some DanceFlow opt-in screens are located inside a private client portal, studio account workflow, booking workflow, or event registration flow. Those areas may require a user account, studio access, or an active event registration to view.
            </p>
            <p>
              This page documents the public SMS consent process so campaign reviewers can verify how end users provide consent, what consent language is shown, what types of messages may be sent, and how users can opt out.
            </p>
          </Section>

          <Section title="Who sends messages">
            <p>
              Messages are sent by DanceFlow, a participating dance studio, a participating event organizer, or a DanceFlow-powered workspace. DanceFlow provides the software and messaging infrastructure used to send service-related communications connected to the user's studio, lesson, booking, account, or event activity.
            </p>
          </Section>

          <Section title="How SMS consent is collected">
            <p>
              End users may opt in by providing a mobile phone number and affirmatively agreeing to receive SMS messages through a clear consent disclosure. SMS consent is collected separately from account creation, purchases, waivers, and general service terms.
            </p>
            <p>
              SMS consent is optional. Users may complete account setup, event registration, ticket purchase, booking requests, and other DanceFlow-powered service actions without agreeing to receive SMS messages.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <ConsentPathCard title="Client portal profile or account settings">
                Users may add or update a mobile phone number and opt in to receive service-related SMS messages from their studio or DanceFlow-powered workspace.
              </ConsentPathCard>
              <ConsentPathCard title="Event registration or ticket checkout">
                Event attendees may opt in while registering for a DanceFlow-powered event or purchasing event tickets, when SMS reminders or event updates are available.
              </ConsentPathCard>
              <ConsentPathCard title="Booking request or inquiry form">
                Prospective clients may opt in when submitting a lesson booking request, inquiry form, or other studio communication request.
              </ConsentPathCard>
              <ConsentPathCard title="Direct studio or organizer relationship">
                Studio or organizer staff may record SMS consent only after the user gives permission during an existing client, student, attendee, or customer relationship.
              </ConsentPathCard>
            </div>
          </Section>

          <Section title="Consent disclosure shown to users">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-slate-800">
              <p className="font-semibold text-slate-950">SMS consent checkbox language</p>
              <p className="mt-3">{consentDisclosure}</p>
            </div>
            <p>
              The SMS consent checkbox should be unchecked by default. Users must actively choose to opt in before SMS messages are sent through DanceFlow.
            </p>
          </Section>

          <Section title="Types of messages">
            <p>Text messages may include service-related communications such as:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Appointment confirmations and reminders</li>
              <li>Schedule changes and lesson updates</li>
              <li>Booking request follow-up and client service messages</li>
              <li>Event reminders and registration updates</li>
              <li>Ticket, QR code, check-in, and event attendance information</li>
              <li>Floor rental confirmations and reminders</li>
              <li>Package balance, account, or operational notifications from the studio or organizer</li>
            </ul>
          </Section>

          <Section title="Message frequency, rates, and opt-out">
            <p>
              Message frequency varies based on the user's activity with the participating studio or organizer. Message and data rates may apply depending on the user's wireless carrier and plan.
            </p>
            <p>
              Users can opt out at any time by replying <strong>STOP</strong>. Users can reply <strong>HELP</strong> for help.
            </p>
            <p>
              Consent to receive SMS messages is not a condition of purchase and is not required to use DanceFlow, register for an event, buy a ticket, book a lesson, or receive studio services.
            </p>
          </Section>

          <Section title="Example SMS messages">
            <div className="space-y-3">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-800">
                DanceFlow: Reminder from [Studio Name]: Your private lesson is tomorrow at 6:00 PM. Reply STOP to opt out.
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-800">
                DanceFlow: Your registration for [Event Name] is confirmed. View your details in your portal. Reply STOP to opt out.
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-800">
                DanceFlow: [Studio Name] updated your schedule. Log in to your client portal to review. Reply HELP for help or STOP to opt out.
              </div>
            </div>
          </Section>

          <Section title="Privacy and data sharing">
            <p>
              Mobile phone numbers and SMS consent records are not sold, rented, or shared with third parties or affiliates for their own marketing or promotional purposes.
            </p>
            <p>
              SMS opt-in data and consent records are used to provide requested messaging services and to operate, secure, and support the DanceFlow platform.
            </p>
          </Section>

          <Section title="Terms, privacy, and support">
            <p>
              Review DanceFlow's terms and privacy information or contact support with questions about SMS consent and messaging.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
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
              <Link
                href="mailto:support@idanceflow.com"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Contact Support
              </Link>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}
