import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Data Processing Addendum | DanceFlow",
  description: "Data processing terms for DanceFlow business customers.",
  alternates: { canonical: "/dpa" },
};

export const DANCEFLOW_DPA_VERSION = "2026-07-17";
const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function DpaPage() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow legal
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Data Processing Addendum
            </h1>
            <p className="mt-4 text-slate-600">Effective: {updated}</p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
              This Data Processing Addendum forms part of the DanceFlow SaaS Terms
              or another agreement between DanceFlow and the customer that references
              it. It applies when DanceFlow processes Customer Personal Data on the
              customer&apos;s behalf.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl space-y-6 px-6 py-10">
          <Section title="1. Definitions and roles">
            <p>
              “Customer Personal Data” means personal data submitted to DanceFlow by
              or for the customer and processed to provide the services. “Data
              Protection Laws” means privacy and data-protection laws applicable to
              that processing.
            </p>
            <p>
              The customer is the controller or business responsible for Customer
              Personal Data. DanceFlow is the processor or service provider acting on
              the customer&apos;s documented instructions, except where DanceFlow
              independently determines a purpose and means of processing.
            </p>
          </Section>

          <Section title="2. Processing instructions">
            <p>
              DanceFlow will process Customer Personal Data to provide, secure,
              maintain, support, and improve the contracted services; comply with the
              customer&apos;s documented use and configuration of the services; and
              comply with law.
            </p>
            <p>
              The SaaS Terms, this DPA, the customer&apos;s feature selections,
              support requests, and lawful written instructions constitute the
              customer&apos;s documented instructions.
            </p>
          </Section>

          <Section title="3. Customer obligations">
            <p>
              The customer is responsible for the lawfulness, accuracy, and quality of
              Customer Personal Data; providing required notices; obtaining required
              consents; responding to individuals; and ensuring that its instructions
              comply with Data Protection Laws.
            </p>
          </Section>

          <Section title="4. Confidentiality">
            <p>
              DanceFlow will ensure that personnel authorized to process Customer
              Personal Data are subject to confidentiality obligations and receive
              access only as reasonably necessary for their responsibilities.
            </p>
          </Section>

          <Section title="5. Security">
            <p>
              DanceFlow will maintain reasonable administrative, technical, and
              organizational safeguards appropriate to the nature of Customer Personal
              Data and the risks of processing. Controls may include role-based access,
              server-side authorization, database policies, encryption in transit,
              protected credentials, validation, rate limiting, logging, monitoring,
              backup practices, and incident-response procedures.
            </p>
            <p>
              Additional current information is available on the{" "}
              <Link href="/security" className="font-semibold text-slate-950 underline">
                Security page
              </Link>
              .
            </p>
          </Section>

          <Section title="6. Subprocessors">
            <p>
              The customer authorizes DanceFlow to use subprocessors to provide the
              services. Subprocessors may support hosting, databases, authentication,
              storage, payments, communications, monitoring, analytics, support,
              integrations, and AI-assisted features.
            </p>
            <p>
              DanceFlow will require subprocessors that process Customer Personal Data
              to protect it through written obligations appropriate to their services.
              DanceFlow remains responsible for its obligations under this DPA.
            </p>
            <p>
              A current subprocessor list may be requested from{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>
              . Customers may raise a reasonable data-protection objection to a new
              subprocessor by contacting DanceFlow promptly after notice.
            </p>
          </Section>

          <Section title="7. Individual rights requests">
            <p>
              Taking into account the nature of processing, DanceFlow will provide
              reasonable assistance through available product controls or support so
              the customer can respond to valid requests to access, correct, delete,
              restrict, object to, or export Customer Personal Data.
            </p>
            <p>
              If DanceFlow receives a request relating primarily to customer-controlled
              data, DanceFlow may direct the requester to the customer unless legally
              prohibited.
            </p>
          </Section>

          <Section title="8. Security incidents">
            <p>
              DanceFlow will notify the customer without undue delay after confirming
              unauthorized access to, acquisition of, or disclosure of Customer
              Personal Data for which notification is required under applicable law.
            </p>
            <p>
              Notice will include information reasonably available to DanceFlow about
              the nature of the incident, affected data, likely consequences, and
              remediation. Notification is not an admission of fault or liability.
            </p>
          </Section>

          <Section title="9. Assessments and consultations">
            <p>
              DanceFlow will provide reasonable information needed for the customer to
              conduct legally required data-protection impact assessments or prior
              consultations relating to the services, considering the nature of
              processing and information available to DanceFlow.
            </p>
          </Section>

          <Section title="10. International transfers">
            <p>
              Customer Personal Data may be processed in the United States and other
              countries where DanceFlow or its subprocessors operate. Where a lawful
              transfer mechanism is required, the parties will cooperate to implement
              applicable standard contractual clauses or another valid safeguard.
            </p>
          </Section>

          <Section title="11. Return and deletion">
            <p>
              During the subscription, the customer may use available features to
              access or export Customer Personal Data. Following termination or a valid
              deletion instruction, DanceFlow will delete or return Customer Personal
              Data within a reasonable period unless retention is required by law,
              necessary for security, disputes, payment and accounting records, or
              maintained temporarily in protected backups.
            </p>
          </Section>

          <Section title="12. Audit information">
            <p>
              DanceFlow will make information reasonably necessary to demonstrate
              compliance with this DPA available to the customer. Where legally
              required and after review of available documentation, the parties may
              agree to a narrowly scoped audit subject to confidentiality, security,
              reasonable advance notice, minimal disruption, and allocation of costs.
            </p>
          </Section>

          <Section title="13. Required-law processing">
            <p>
              If law requires DanceFlow to process Customer Personal Data beyond the
              customer&apos;s instructions, DanceFlow will notify the customer before
              processing unless legally prohibited.
            </p>
          </Section>

          <Section title="14. Processing details">
            <ul className="list-disc space-y-2 pl-6">
              <li><strong>Subject matter:</strong> operation of DanceFlow services selected by the customer.</li>
              <li><strong>Duration:</strong> the subscription and any lawful retention or deletion period.</li>
              <li><strong>Nature and purpose:</strong> hosting, organizing, transmitting, securing, supporting, analyzing, and presenting customer-selected workflows.</li>
              <li><strong>Data subjects:</strong> customers, staff, instructors, contractors, leads, clients, students, dancers, guardians, attendees, registrants, vendors, and contacts.</li>
              <li><strong>Data categories:</strong> identifiers, contact details, account and role data, schedules, attendance, transactions, memberships, documents, signatures, communications, uploaded content, event records, and technical logs.</li>
              <li><strong>Sensitive data:</strong> customers should avoid submitting sensitive data unless necessary, lawful, and supported by the selected feature.</li>
            </ul>
          </Section>

          <Section title="15. Priority and updates">
            <p>
              If this DPA conflicts with the SaaS Terms regarding processing of
              Customer Personal Data, this DPA controls. DanceFlow may update this DPA
              to reflect service or legal changes, provided updates do not materially
              reduce required data-protection commitments during a current paid term
              without a lawful basis or customer agreement.
            </p>
          </Section>

          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7 text-amber-950">
            Customers with regulatory, international-transfer, or negotiated-contract
            requirements should contact support before relying on this public DPA for a
            specialized compliance program.
          </div>

          <Link href="/terms" className="inline-flex text-sm font-semibold text-slate-700 hover:text-slate-950">
            ← Return to SaaS Terms
          </Link>
        </section>
      </main>
      <PublicSiteFooter />
    </>
  );
}
