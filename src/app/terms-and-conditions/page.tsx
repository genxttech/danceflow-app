import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Terms & Conditions | DanceFlow",
  description:
    "Terms and conditions for using DanceFlow, including studio accounts, organizer tools, payments, messaging, AI features, documents, and event workflows.",
};

const updated = "June 1, 2026";

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">
        {children}
      </div>
    </section>
  );
}

export default function TermsAndConditionsPage() {
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
              Terms &amp; Conditions
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Last updated: {updated}
            </p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
              These terms explain the basic rules for using DanceFlow. By creating
              an account, managing a workspace, registering for an event, buying a
              ticket, signing a document, or using the platform, you agree to use
              DanceFlow responsibly and follow the terms below.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-6">
            <Section title="1. About DanceFlow">
              <p>
                DanceFlow is a software platform for dance studios, independent
                instructors, event organizers, and dancers. The platform may include
                client management, scheduling, package and membership tracking,
                payments, event registration, ticketing, public discovery pages,
                marketing tools, documents and e-signatures, AI-assisted writing,
                email and SMS communication, reporting, and related workflow tools.
              </p>
              <p>
                DanceFlow provides software tools. Studios, instructors, and
                organizers remain responsible for their own business operations,
                policies, services, events, pricing, refunds, client relationships,
                and legal compliance.
              </p>
            </Section>

            <Section title="2. Accounts and workspace access">
              <p>
                You are responsible for keeping your login credentials secure and
                for activity that occurs under your account. Do not share access in a
                way that bypasses role permissions or exposes private client,
                student, payment, or business information.
              </p>
              <p>
                Workspace owners are responsible for assigning appropriate roles to
                staff, instructors, front desk users, admins, and other authorized
                users. DanceFlow may restrict access if an account creates a security
                risk, violates these terms, or is used in a way that harms the
                platform or another workspace.
              </p>
            </Section>

            <Section title="3. Studio, instructor, and organizer responsibilities">
              <p>
                Studios, instructors, and organizers are responsible for the
                accuracy of the information they enter into DanceFlow, including
                public profiles, class schedules, event pages, ticket details,
                prices, policies, refund rules, location information, staff details,
                document templates, and client records.
              </p>
              <p>
                You are responsible for complying with laws and rules that apply to
                your business, events, communications, clients, employees,
                contractors, taxes, accessibility obligations, music/licensing
                obligations, and any waivers, agreements, or policies you use.
              </p>
            </Section>

            <Section title="4. Payments, subscriptions, and platform fees">
              <p>
                DanceFlow subscriptions, add-ons, ticket purchases, event
                registrations, guest coach lessons, and other payment workflows may
                be processed by Stripe or another payment provider. Payment provider
                terms, processing rules, payout timing, chargeback handling, and
                payment method requirements may apply.
              </p>
              <p>
                Paid workspace access may depend on an active subscription, trial,
                plan, or organizer access level. If payment fails, a subscription is
                canceled, or access becomes inactive, DanceFlow may limit paid
                features, public discovery visibility, checkout tools, or other
                workspace access.
              </p>
              <p>
                Organizer and ticketing workflows may include platform fees. Any
                applicable platform fees, payment processing fees, taxes, or payout
                deductions should be reviewed by the studio or organizer before
                publishing paid offerings.
              </p>
            </Section>

            <Section title="5. Events, tickets, registrations, and refunds">
              <p>
                Studios and organizers control their own event details, ticket
                types, pricing, registration settings, capacity, schedules, coach
                lesson slots, refund policies, and attendee requirements. DanceFlow
                helps manage those workflows but does not operate the event unless
                separately agreed in writing.
              </p>
              <p>
                Ticket buyers and registrants should review the event page,
                organizer details, schedule, location, ticket terms, waiver or
                document requirements, and refund policy before purchasing. Refunds,
                cancellations, transfers, and event changes are generally handled by
                the studio or organizer according to the posted event terms.
              </p>
            </Section>

            <Section title="6. Documents, waivers, and e-signatures">
              <p>
                DanceFlow may allow studios and organizers to create, assign, sign,
                and store documents such as waivers, policies, agreements, releases,
                and event forms. Studios and organizers are responsible for the
                content, accuracy, legal enforceability, and appropriate use of their
                document templates.
              </p>
              <p>
                By signing a document through DanceFlow, you agree that your
                electronic signature, typed name, timestamp, and related signature
                record may be stored and used to show that the document was reviewed
                and signed. Contact the studio or organizer if you have questions
                about a specific document.
              </p>
            </Section>

            <Section title="7. Email, SMS, and client communication">
              <p>
                DanceFlow may support email, SMS, and other communication tools for
                transactional messages, reminders, event updates, follow-ups,
                campaign messages, and account-related notices. Studios and
                organizers are responsible for sending messages only to people they
                are allowed to contact and for honoring unsubscribe, opt-out, and
                consent requirements.
              </p>
              <p>
                SMS messages should only be sent to contacts who have given
                permission to receive text messages. Contacts may opt out of SMS by
                replying STOP where supported. Message and data rates may apply.
                DanceFlow may log message status, delivery details, consent status,
                and opt-out activity to help studios and organizers manage compliant
                communication.
              </p>
            </Section>

            <Section title="8. AI-assisted features">
              <p>
                DanceFlow may include AI-assisted tools for drafting follow-ups,
                lesson notes, event descriptions, marketing content, report
                insights, knowledgebase help, or similar content. AI-generated
                content is provided as a drafting aid and may be incomplete,
                inaccurate, or inappropriate for a specific situation.
              </p>
              <p>
                Users are responsible for reviewing, editing, and approving any
                AI-assisted content before sending, publishing, or relying on it.
                Do not use AI features to create unlawful, misleading, harmful,
                confidential, or inappropriate content.
              </p>
            </Section>

            <Section title="9. User content and public listings">
              <p>
                You are responsible for content you upload, publish, or send through
                DanceFlow, including names, bios, logos, photos, descriptions,
                documents, messages, links, event details, and other materials. You
                must have the rights and permissions needed to use that content.
              </p>
              <p>
                DanceFlow may remove or limit content that appears unlawful,
                misleading, abusive, infringing, unsafe, spammy, or harmful to the
                platform, dancers, studios, organizers, or the public.
              </p>
            </Section>

            <Section title="10. Acceptable use">
              <p>
                You agree not to misuse DanceFlow, attempt unauthorized access,
                interfere with platform security, scrape or copy the service in an
                unauthorized way, upload malicious code, send spam, harass others,
                impersonate another person or business, or use the platform for
                unlawful activity.
              </p>
              <p>
                DanceFlow may investigate suspicious activity and may suspend,
                restrict, or terminate access when needed to protect users, data,
                payment workflows, platform reliability, or legal compliance.
              </p>
            </Section>

            <Section title="11. Minors and student accounts">
              <p>
                DanceFlow may include students or dancers who are minors. Children
                under 13 should not create unmanaged accounts. A parent, guardian,
                studio, or authorized adult should manage minor participation,
                communications, document signing, and account access where required.
              </p>
            </Section>

            <Section title="12. Service availability and changes">
              <p>
                DanceFlow may change, improve, restrict, or discontinue features
                over time. We work to keep the service reliable, but we do not
                guarantee uninterrupted access, error-free operation, or that every
                feature will always be available on every plan.
              </p>
            </Section>

            <Section title="13. Disclaimers and limitation of liability">
              <p>
                DanceFlow is provided as a software service. To the maximum extent
                allowed by law, DanceFlow is not responsible for indirect,
                incidental, special, consequential, punitive, or lost-profit damages
                arising from use of the platform, events managed by third parties,
                user content, payment provider decisions, messaging provider
                delivery issues, or business decisions made by studios or organizers.
              </p>
              <p>
                DanceFlow does not provide legal, tax, accounting, insurance,
                medical, safety, or financial advice. Studios, organizers, and users
                should consult qualified professionals for those needs.
              </p>
            </Section>

            <Section title="14. Termination">
              <p>
                You may stop using DanceFlow at any time. DanceFlow may suspend or
                terminate access for nonpayment, security concerns, abuse, unlawful
                activity, violation of these terms, or other issues that place the
                platform or users at risk.
              </p>
            </Section>

            <Section title="15. Updates to these terms">
              <p>
                We may update these terms as the platform changes. The updated date
                above shows when this page was last revised. Continued use of
                DanceFlow after updates means you accept the revised terms.
              </p>
            </Section>

            <Section title="16. Contact us">
              <p>
                Questions about these terms can be sent to{" "}
                <a
                  className="font-semibold text-slate-950 hover:underline"
                  href="mailto:support@idanceflow.com"
                >
                  support@idanceflow.com
                </a>
                .
              </p>
            </Section>
          </div>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
            Tip: Review your studio or organizer policies before publishing public
            events, selling tickets, sending messages, or assigning documents.
          </div>

          <div className="mt-8">
            <Link
              href="/"
              className="text-sm font-semibold text-slate-700 hover:text-slate-950"
            >
              ← Back to DanceFlow
            </Link>
          </div>
        </section>
      </main>

      <PublicSiteFooter />
    </>
  );
}
