import Link from "next/link";
import PublicShell from "@/components/public/PublicShell";
import { buildSmsConsentDisclosure } from "@/lib/sms/compliance";

const OWNERSHIP_STATEMENT =
  "DanceFlow is a software platform owned and operated by GenX TotalTech LLC.";

const consentDisclosure = buildSmsConsentDisclosure("[Studio Name]");

const STOP_HELP_FOOTER = "Harbor Dance Studio: Reply STOP to opt out. Reply HELP for help.";

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

function SampleMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="whitespace-pre-line rounded-2xl border border-slate-200 bg-slate-50 p-4 text-slate-800">
      {children}
    </div>
  );
}

export const metadata = {
  title: "SMS Consent & Messaging Terms",
  description:
    "How dance studios using DanceFlow collect SMS consent, what service messages are sent, and how to opt out.",
};

export default function SmsConsentPage() {
  return (
    <PublicShell>
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
            {OWNERSHIP_STATEMENT} Participating dance studios use DanceFlow to send
            service-related text messages to their own students, clients,
            parents/guardians, and prospective clients who have explicitly opted in to
            receive texts from that studio through DanceFlow.
          </p>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
            This page documents how SMS consent is collected, the exact consent language
            shown, which messages are sent, and how to opt out.
          </p>
        </div>

        <div className="mt-8 grid gap-6">
          <Section title="Who sends messages">
            <p>
              Messages are sent by the participating dance studio to its own contacts,
              through DanceFlow. DanceFlow provides the software and messaging
              infrastructure; GenX TotalTech LLC owns and operates DanceFlow and does not
              operate the dance studio. Each message identifies the studio by name.
            </p>
          </Section>

          <Section title="How SMS consent is collected">
            <p>
              SMS consent is always optional and is collected separately from any other
              agreement. The consent checkbox is unchecked by default, is not required to
              submit a form, and is separate from any &ldquo;preferred contact
              method&rdquo; choice. Choosing a preferred contact method does not opt a
              person in to text messages.
            </p>
            <div className="grid gap-4 md:grid-cols-3">
              <ConsentPathCard title="Studio inquiry form">
                A person submitting a studio&apos;s public DanceFlow inquiry form may
                enter a mobile number and check the optional SMS consent box shown
                below.
              </ConsentPathCard>
              <ConsentPathCard title="Intro lesson booking form">
                A person requesting an intro lesson through a studio&apos;s public
                DanceFlow booking form may enter a mobile number and check the same
                optional SMS consent box.
              </ConsentPathCard>
              <ConsentPathCard title="Consent given directly to the studio">
                A student or client may give consent directly to the studio, verbally or
                in writing, after being read or shown the same disclosure. Authorized
                studio staff then record that consent in DanceFlow.
              </ConsentPathCard>
            </div>
          </Section>

          <Section title="Consent disclosure shown to users">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-slate-800">
              <p className="font-semibold text-slate-950">SMS consent checkbox language</p>
              <p className="mt-3">{consentDisclosure}</p>
            </div>
            <p>
              &ldquo;[Studio Name]&rdquo; is replaced with the participating studio&apos;s
              name, and &ldquo;Terms&rdquo; and &ldquo;Privacy Policy&rdquo; link to the
              pages below. Texts are sent only after a person has opted in.
            </p>
          </Section>

          <Section title="Types of messages">
            <p>Text messages are limited to service-related communications:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                One-to-one messages from authorized studio staff, such as replies to an
                inquiry, lesson booking and scheduling coordination, and client-service
                questions
              </li>
              <li>Lesson appointment confirmations</li>
              <li>Lesson appointment reschedules</li>
              <li>Lesson appointment cancellations</li>
            </ul>
            <p>
              No marketing or promotional text messages are sent under this program.
            </p>
          </Section>

          <Section title="Message frequency, rates, and opt-out">
            <p>
              Message frequency varies based on the person&apos;s lessons and
              interactions with the studio. Message and data rates may apply depending on
              the person&apos;s wireless carrier and plan.
            </p>
            <p>
              Reply <strong>STOP</strong> at any time to opt out. Reply{" "}
              <strong>HELP</strong> for help, or contact support@idanceflow.com or the
              studio directly.
            </p>
            <p>
              Consent to receive text messages is optional and is not a condition of
              purchase or of receiving studio services.
            </p>
          </Section>

          <Section title="Example SMS messages">
            <div className="space-y-3">
              <SampleMessage>
                {`Hi Alex,\n\nYour private lesson is confirmed for Tue, Oct 14, 2026, 6:00 PM EDT.\nInstructor: Jamie Rivera.\n\nWe look forward to seeing you.\n\n${STOP_HELP_FOOTER}`}
              </SampleMessage>
              <SampleMessage>
                {`Hi Alex,\n\nYour private lesson has been rescheduled to Thu, Oct 16, 2026, 5:00 PM EDT.\n\nPlease contact the studio if you have any questions.\n\n${STOP_HELP_FOOTER}`}
              </SampleMessage>
              <SampleMessage>
                {`Hi Alex, thanks for your inquiry! We have an intro lesson opening Thursday at 5 PM. Would you like us to hold it?\n\n${STOP_HELP_FOOTER}`}
              </SampleMessage>
            </div>
            <p className="text-xs text-slate-500">
              Examples use a fictional studio and client.
            </p>
          </Section>

          <Section title="Privacy and data sharing">
            <p>
              Mobile phone numbers and SMS consent records are not sold, rented, or shared
              with third parties or affiliates for their own marketing or promotional
              purposes.
            </p>
            <p>
              SMS opt-in data and consent records are used to provide requested messaging
              services and to operate, secure, and support the DanceFlow platform.
            </p>
          </Section>

          <Section title="Terms, privacy, and support">
            <p>
              Review DanceFlow&apos;s Terms and Privacy Policy, or contact support with
              questions about SMS consent and messaging.
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
              <Link
                href="/terms"
                className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-50"
              >
                Terms
              </Link>
              <Link
                href="/privacy"
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
    </PublicShell>
  );
}
