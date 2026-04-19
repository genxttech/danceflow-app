import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Terms & Conditions | DanceFlow",
  description:
    "Terms and Conditions for DanceFlow, including SMS program terms and platform use terms.",
};

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-700">
        {children}
      </div>
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
          <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950">
            Terms &amp; Conditions
          </h1>
          <p className="mt-4 text-base leading-7 text-slate-600">
            Please read these Terms and Conditions carefully before using DanceFlow.
          </p>
          <p className="mt-3 text-sm text-slate-500">
            Effective date: {effectiveDate}
          </p>
        </div>

        <div className="space-y-6">
          <Section title="1. Acceptance of Terms">
            <p>
              By accessing or using DanceFlow, you agree to be bound by these Terms
              and Conditions and any applicable laws and regulations.
            </p>
            <p>
              If you do not agree with any part of these terms, you should not use
              the platform.
            </p>
          </Section>

          <Section title="2. Platform Use">
            <p>
              DanceFlow provides software and public discovery tools for dance
              studios, organizers, and public users.
            </p>
            <p>
              You agree to use the platform only for lawful purposes and in a way
              that does not infringe the rights of others or restrict their use of
              the service.
            </p>
          </Section>

          <Section title="3. Accounts">
            <p>
              You may be required to create an account to access certain features of
              the platform.
            </p>
            <p>
              You are responsible for maintaining the confidentiality of your account
              credentials and for all activity that occurs under your account.
            </p>
          </Section>

          <Section title="4. Payments and Billing">
            <p>
              Paid features, subscriptions, ticket sales, and related billing tools
              may be subject to separate pricing, processing fees, and platform fees.
            </p>
            <p>
              By using paid features, you agree to the pricing and billing terms
              presented at the time of purchase.
            </p>
          </Section>

          <Section title="5. SMS Program Terms">
            <p>
              If you opt in to receive SMS messages from DanceFlow or participating
              studios or organizers using the platform, message frequency may vary.
            </p>
            <p>
              Message and data rates may apply depending on your mobile carrier and
              plan.
            </p>
            <p>
              You can opt out of SMS communications at any time by following the
              instructions included in the message, such as replying STOP where
              applicable.
            </p>
          </Section>

          <Section title="6. Content and Conduct">
            <p>
              You are responsible for any information, content, or materials you
              submit through the platform.
            </p>
            <p>
              You may not upload or transmit unlawful, abusive, fraudulent, or
              harmful content through DanceFlow.
            </p>
          </Section>

          <Section title="7. Termination">
            <p>
              We may suspend or terminate access to the platform if you violate these
              Terms and Conditions or misuse the service.
            </p>
            <p>
              We also reserve the right to update, suspend, or discontinue parts of
              the platform at any time.
            </p>
          </Section>

          <Section title="8. Disclaimer">
            <p>
              DanceFlow is provided on an as-is and as-available basis without
              warranties of any kind, except where required by law.
            </p>
            <p>
              We do not guarantee uninterrupted or error-free operation of the
              platform.
            </p>
          </Section>

          <Section title="9. Limitation of Liability">
            <p>
              To the fullest extent permitted by law, DanceFlow shall not be liable
              for any indirect, incidental, special, consequential, or punitive
              damages arising from your use of the platform.
            </p>
          </Section>

          <Section title="10. Changes to These Terms">
            <p>
              We may update these Terms and Conditions from time to time. Continued
              use of the platform after changes become effective constitutes
              acceptance of the revised terms.
            </p>
          </Section>

          <Section title="11. Contact">
            <p>
              For questions regarding these Terms and Conditions, contact the
              platform administrator through the appropriate support or contact
              channel listed on the site.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}