export const metadata = {
  title: "Privacy Policy | DanceFlow",
  description:
    "Privacy Policy for DanceFlow, including website, platform, and SMS messaging disclosures.",
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

export default function PrivacyPolicyPage() {
  const effectiveDate = "April 17, 2026";

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-4xl px-6 py-12">
        <div className="mb-8 rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-slate-500">
            Legal
          </p>
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-900">
            Privacy Policy
          </h1>
          <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-700">
            This Privacy Policy explains how DanceFlow collects, uses, stores, and
            shares information when you use our website, studio software platform,
            booking tools, client portal, event registration tools, and SMS-enabled
            notifications.
          </p>
          <p className="mt-4 text-sm text-slate-500">
            Effective Date: {effectiveDate}
          </p>
        </div>

        <div className="space-y-6">
          <Section title="1. Who We Are">
            <p>
              DanceFlow is a software platform for dance studios, instructors, and
              related businesses. Our platform may support scheduling, client
              management, memberships, payments, event registration, public booking,
              client communication, and transactional notifications.
            </p>
            <p>
              In this Privacy Policy, “DanceFlow,” “we,” “our,” and “us” refer to the
              DanceFlow platform and related services.
            </p>
          </Section>

          <Section title="2. Information We Collect">
            <p>We may collect the following categories of information:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                Contact information, such as name, email address, mobile phone
                number, mailing address, and emergency contact information.
              </li>
              <li>
                Account and profile information, such as login credentials, user
                role, studio affiliation, and preferences.
              </li>
              <li>
                Booking and service information, such as appointments, lesson
                history, floor rental bookings, event registrations, waivers,
                attendance, and notes.
              </li>
              <li>
                Billing and transaction information, such as purchase history,
                invoices, subscription details, and payment status. Card data may be
                processed by third-party payment processors and is not stored in full
                by us.
              </li>
              <li>
                Communications data, such as support messages, notification history,
                email delivery data, and SMS delivery data.
              </li>
              <li>
                Device and usage data, such as IP address, browser type, pages
                visited, timestamps, and interaction logs.
              </li>
              <li>
                Media or uploaded content, such as files, lesson recap videos, and
                documents submitted through the platform.
              </li>
            </ul>
          </Section>

          <Section title="3. How We Use Information">
            <p>We may use personal information to:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Provide, operate, maintain, and improve the platform.</li>
              <li>Create and manage user accounts and studio workspaces.</li>
              <li>
                Process bookings, registrations, memberships, subscriptions, and
                payments.
              </li>
              <li>
                Send transactional messages such as booking confirmations,
                appointment reminders, event confirmations, event reminders, intro
                lesson confirmations, floor rental reminders, and account-related
                notices.
              </li>
              <li>Respond to support requests and troubleshoot issues.</li>
              <li>
                Monitor platform performance, detect fraud, enforce security, and
                protect users and the service.
              </li>
              <li>
                Comply with legal obligations and enforce our agreements and
                policies.
              </li>
            </ul>
          </Section>

          <Section title="4. SMS and Mobile Messaging Disclosures">
            <p>
              If you provide your mobile phone number through a booking form,
              registration form, account form, inquiry form, or another platform
              workflow, you may receive transactional SMS messages related to your
              activity.
            </p>
            <p>These messages may include:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>Appointment confirmations</li>
              <li>Appointment reminders</li>
              <li>Intro lesson confirmations and reminders</li>
              <li>Event registration confirmations and reminders</li>
              <li>Floor rental confirmations and reminders</li>
              <li>Important account or service notices</li>
            </ul>
            <p>
              Message frequency varies based on your activity and relationship with a
              studio using DanceFlow.
            </p>
            <p>
              Message and data rates may apply depending on your wireless carrier and
              plan.
            </p>
            <p>
              You can opt out of SMS messages at any time by replying <strong>STOP</strong>.
              For help, reply <strong>HELP</strong>.
            </p>
            <p className="font-medium text-slate-900">
              Mobile information will not be shared with third parties or affiliates
              for marketing or promotional purposes.
            </p>
          </Section>

          <Section title="5. How We Share Information">
            <p>We may share information in the following limited circumstances:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>
                With the dance studio, instructor, organizer, or business that you
                interact with through the platform.
              </li>
              <li>
                With service providers who help us operate the platform, such as
                hosting, authentication, analytics, customer support, email, SMS,
                storage, and payment processing vendors.
              </li>
              <li>
                With legal, regulatory, or governmental authorities when required by
                law or when necessary to protect rights, safety, and security.
              </li>
              <li>
                In connection with a merger, acquisition, financing, reorganization,
                sale of assets, or similar business transaction.
              </li>
            </ul>
            <p>
              We do not sell personal information to third parties for their own
              marketing purposes.
            </p>
          </Section>

          <Section title="6. Cookies and Analytics">
            <p>
              We may use cookies, local storage, pixels, and similar technologies to
              remember preferences, keep users signed in, understand usage patterns,
              improve performance, and measure feature adoption.
            </p>
            <p>
              You can manage some cookie and browser settings through your device or
              browser controls, though disabling certain tools may affect site
              functionality.
            </p>
          </Section>

          <Section title="7. Data Retention">
            <p>
              We retain information for as long as reasonably necessary to provide
              services, maintain records, comply with legal obligations, resolve
              disputes, enforce agreements, and support legitimate business
              operations.
            </p>
            <p>
              Retention periods may vary depending on the type of information,
              customer account status, and legal or operational requirements.
            </p>
          </Section>

          <Section title="8. Data Security">
            <p>
              We use reasonable administrative, technical, and organizational
              safeguards designed to protect personal information. However, no method
              of transmission or storage is completely secure, and we cannot
              guarantee absolute security.
            </p>
          </Section>

          <Section title="9. Your Choices and Rights">
            <p>
              Depending on your location, you may have the right to access, correct,
              delete, or request portability of certain personal information, or to
              object to or limit certain processing.
            </p>
            <p>
              You may also opt out of SMS messages by replying <strong>STOP</strong>,
              and you may manage certain email or notification preferences through
              the platform when available.
            </p>
          </Section>

          <Section title="10. Children’s Privacy">
            <p>
              The platform is not directed to children under 13, and we do not
              knowingly collect personal information directly from children under 13
              without appropriate authorization. If you believe a child has provided
              personal information inappropriately, contact us so we can review and
              address the request.
            </p>
          </Section>

          <Section title="11. Third-Party Services and Links">
            <p>
              The platform may integrate with or link to third-party services,
              including payment providers, messaging providers, authentication
              systems, and external websites. Their privacy practices are governed by
              their own policies, not this one.
            </p>
          </Section>

          <Section title="12. Changes to This Privacy Policy">
            <p>
              We may update this Privacy Policy from time to time. When we do, we may
              revise the effective date above and post the updated version on this
              page. Continued use of the platform after changes become effective
              constitutes acceptance of the updated policy where permitted by law.
            </p>
          </Section>

          <Section title="13. Contact Us">
            <p>
              If you have questions about this Privacy Policy or our privacy
              practices, contact us at:
            </p>
            <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-700">
              <p>DanceFlow</p>
              <p>Email: support@idanceflow.com</p>
              <p>Website: https://idanceflow.com</p>
            </div>
          </Section>
        </div>
      </div>
    </main>
  );
}