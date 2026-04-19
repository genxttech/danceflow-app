export const metadata = {
  title: "Terms & Conditions | DanceFlow",
  description:
    "Terms and Conditions for DanceFlow, including SMS program terms and platform use terms.",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-700">{children}</div>
    </section>
  );
}

export default function TermsAndConditionsPage() {
  const effectiveDate = "April 17, 2026";

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
            Legal
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">
            Terms & Conditions
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-700">
            These Terms & Conditions govern your access to and use of DanceFlow,
            including our website, platform, booking tools, client portal,
            transactional messaging features, and related services.
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Effective Date: {effectiveDate}
          </p>
        </div>

        <div className="space-y-6">
          <Section title="1. Acceptance of Terms">
            <p>
              By accessing or using DanceFlow, you agree to be bound by these Terms
              & Conditions and any related policies referenced in them, including our
              Privacy Policy. If you do not agree, do not use the service.
            </p>
          </Section>

          <Section title="2. Services">
            <p>
              DanceFlow provides software and related tools for dance studios,
              instructors, organizers, and their clients. Features may include
              scheduling, CRM tools, public booking, event registration, membership
              tools, payments, messaging, notifications, and reporting.
            </p>
            <p>
              We may modify, suspend, or improve parts of the service at any time.
            </p>
          </Section>

          <Section title="3. User Accounts">
            <p>
              You may be required to create an account to access certain features.
              You are responsible for maintaining the confidentiality of your login
              credentials and for activity that occurs under your account.
            </p>
            <p>
              You agree to provide accurate information and keep it reasonably up to
              date.
            </p>
          </Section>

          <Section title="4. Acceptable Use">
            <p>You agree not to use DanceFlow to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Violate any law, regulation, or third-party right.</li>
              <li>Upload or transmit malicious code or harmful content.</li>
              <li>Attempt unauthorized access to the platform or its data.</li>
              <li>
                Send spam, misleading messages, or unauthorized marketing messages.
              </li>
              <li>
                Use the service in a way that disrupts platform stability, security,
                or performance.
              </li>
            </ul>
          </Section>

          <Section title="5. Payments and Billing">
            <p>
              Certain platform features may involve payments, subscriptions, ticket
              purchases, or invoice processing. Fees, pricing, billing intervals,
              refund handling, and payment workflows may vary depending on the studio
              or organizer using the platform.
            </p>
            <p>
              Payment transactions may be processed by third-party payment providers.
              We do not control third-party processor terms, fees, or policies.
            </p>
          </Section>

          <Section title="6. SMS Program Terms">
            <p>
              By providing your mobile phone number through a booking form,
              registration form, account form, inquiry form, or related workflow, you
              consent to receive transactional SMS messages from DanceFlow and/or the
              studio or organizer using the platform.
            </p>

            <p>These transactional messages may include:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Appointment confirmations and reminders</li>
              <li>Intro lesson confirmations and reminders</li>
              <li>Event registration confirmations and reminders</li>
              <li>Floor rental confirmations and reminders</li>
              <li>Important service, support, or account notices</li>
            </ul>

            <p>
              Message frequency varies based on your activity, bookings,
              registrations, and relationship with the studio or organizer.
            </p>

            <p>
              Message and data rates may apply depending on your wireless carrier and
              plan.
            </p>

            <p>
              To opt out, reply <strong>STOP</strong> to any message.
            </p>

            <p>
              For help, reply <strong>HELP</strong>.
            </p>

            <p>
              Consent to receive SMS messages is not a condition of purchase where
              prohibited by law.
            </p>
          </Section>

          <Section title="7. Intellectual Property">
            <p>
              The DanceFlow platform, branding, designs, software, content, and
              related materials are owned by or licensed to DanceFlow and are
              protected by applicable intellectual property laws.
            </p>
            <p>
              Except as expressly permitted, you may not copy, distribute, modify,
              reverse engineer, or exploit the platform or its content without prior
              written permission.
            </p>
          </Section>

          <Section title="8. Third-Party Services">
            <p>
              DanceFlow may integrate with third-party services such as payment
              processors, email providers, SMS providers, analytics providers, and
              embedded tools. Use of those services may also be subject to the
              third-party provider’s terms and policies.
            </p>
          </Section>

          <Section title="9. Disclaimer of Warranties">
            <p>
              DanceFlow is provided on an “as is” and “as available” basis, without
              warranties of any kind, whether express or implied, including any
              implied warranties of merchantability, fitness for a particular
              purpose, non-infringement, or uninterrupted availability, to the
              maximum extent permitted by law.
            </p>
          </Section>

          <Section title="10. Limitation of Liability">
            <p>
              To the maximum extent permitted by law, DanceFlow and its affiliates,
              officers, employees, contractors, and licensors will not be liable for
              indirect, incidental, special, consequential, exemplary, or punitive
              damages, or for any loss of profits, revenues, goodwill, data, or
              business opportunities arising from or related to your use of the
              service.
            </p>
          </Section>

          <Section title="11. Indemnification">
            <p>
              You agree to defend, indemnify, and hold harmless DanceFlow and its
              affiliates, officers, employees, contractors, and licensors from and
              against claims, liabilities, damages, judgments, losses, costs, and
              expenses arising out of or related to your use of the service, your
              violation of these Terms, or your violation of applicable law or
              third-party rights.
            </p>
          </Section>

          <Section title="12. Suspension and Termination">
            <p>
              We may suspend, restrict, or terminate access to the platform if we
              believe you violated these Terms, created security risk, engaged in
              fraud or abuse, or used the service in a way that could harm users,
              studios, organizers, or the platform.
            </p>
          </Section>

          <Section title="13. Governing Law">
            <p>
              These Terms will be governed by and construed in accordance with the
              laws of the applicable jurisdiction designated by DanceFlow, without
              regard to conflict of law principles.
            </p>
            <p>
              If you want this page tailored to your state, replace this section with
              your preferred governing law and venue language.
            </p>
          </Section>

          <Section title="14. Changes to These Terms">
            <p>
              We may update these Terms & Conditions from time to time. When we do,
              we may revise the effective date above and post the updated version on
              this page. Continued use of the service after changes become effective
              constitutes acceptance of the updated Terms where permitted by law.
            </p>
          </Section>

          <Section title="15. Contact Information">
            <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <p>DanceFlow</p>
              <p>Email: support@idanceflow.com</p>
              <p>Website: https://idanceflow.com</p>
            </div>
            <p className="mt-3">
              Replace the contact details above with your real support email and
              public website before publishing.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}