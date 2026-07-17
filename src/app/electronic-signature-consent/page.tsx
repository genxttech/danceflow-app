import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Electronic Records and Signature Consent | DanceFlow",
  description: "Consent and requirements for using DanceFlow electronic records and signatures.",
  alternates: { canonical: "/electronic-signature-consent" },
};

export const DANCEFLOW_ESIGN_VERSION = "2026-07-17";
const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function ElectronicSignatureConsentPage() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow Sign
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Electronic Records and Signature Consent
            </h1>
            <p className="mt-4 text-slate-600">Effective: {updated}</p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl space-y-6 px-6 py-10">
          <Section title="Consent to electronic records">
            <p>
              By selecting the electronic-consent checkbox and completing a DanceFlow
              signing process, you consent to receive, review, sign, and retain the
              applicable document electronically.
            </p>
            <p>
              Your electronic signature may consist of a typed name, drawn signature,
              initials, checkbox, or another electronic process associated with the
              document and adopted with the intent to sign.
            </p>
          </Section>

          <Section title="Intent and authority">
            <p>
              You confirm that the signature you apply is your own and that you have
              authority to sign for yourself or the person or organization you
              represent. Do not complete another person&apos;s signature without lawful
              authorization.
            </p>
          </Section>

          <Section title="Electronic records and audit information">
            <p>
              DanceFlow may retain the signed document and information supporting the
              transaction, including the signer name and email, consent text, signature
              method, timestamps, timezone, IP address, device or browser information,
              document hash, and activity history.
            </p>
            <p>
              This information may be provided to the studio or organizer that sent the
              document and used to demonstrate review, consent, signature attribution,
              completion, integrity, and record history.
            </p>
          </Section>

          <Section title="Hardware and software requirements">
            <p>To use DanceFlow Sign, you need:</p>
            <ul className="list-disc space-y-2 pl-6">
              <li>A device with internet access and a current web browser.</li>
              <li>Access to the email address or account through which the signing request was delivered.</li>
              <li>JavaScript, cookies, and secure web connections enabled where required.</li>
              <li>Software capable of opening and saving PDF files.</li>
              <li>Sufficient storage or access to a location where you can retain the signed record.</li>
            </ul>
          </Section>

          <Section title="Paper copies and retaining records">
            <p>
              Before signing, you may open the document and print or save a copy. After
              completion, the signing page may provide a signed PDF for download. You
              may also request a copy from the studio or organizer that sent the
              document.
            </p>
            <p>
              DanceFlow does not guarantee that a signing link will remain available
              indefinitely. Download or print records you need to retain.
            </p>
          </Section>

          <Section title="Withdrawing consent">
            <p>
              Before completing a document, you may decline to sign or stop the
              electronic process and contact the sending studio or organizer to ask
              whether a paper or alternative process is available.
            </p>
            <p>
              Withdrawal before completion may delay or prevent the related service,
              registration, event, membership, or transaction when a signed document is
              required. Withdrawal does not invalidate electronic records or signatures
              already completed.
            </p>
          </Section>

          <Section title="Updating contact information">
            <p>
              Contact the sending studio or organizer if your name, email address, or
              other signing information is incorrect. Do not complete the document
              using inaccurate identity information.
            </p>
          </Section>

          <Section title="Legal effect">
            <p>
              Electronic records and signatures may have the same legal effect as
              paper records and handwritten signatures, subject to applicable law and
              the facts of the transaction. A specific document may contain additional
              terms governing its enforceability.
            </p>
          </Section>

          <Section title="Questions">
            <p>
              Questions about a specific document should be directed to the studio or
              organizer that sent it. Questions about DanceFlow Sign may be sent to{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>
              .
            </p>
          </Section>

          <Link href="/terms" className="inline-flex text-sm font-semibold text-slate-700 hover:text-slate-950">
            ← Return to SaaS Terms
          </Link>
        </section>
      </main>
      <PublicSiteFooter />
    </>
  );
}
