import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Security and Trust | DanceFlow",
  description: "Plain-language overview of current DanceFlow safeguards and responsible disclosure.",
  alternates: { canonical: "/security" },
};

const updated = "July 17, 2026";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

function Protection({ control, protects }: { control: string; protects: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
      <p className="font-semibold text-slate-950">{control}</p>
      <p className="mt-2 text-sm leading-6 text-slate-600">{protects}</p>
    </div>
  );
}

export default function SecurityPage() {
  return (
    <>
      <PublicSiteHeader currentPath="home" isAuthenticated={false} />
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-5xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              Customer trust
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Security at DanceFlow
            </h1>
            <p className="mt-4 text-slate-600">Last reviewed: {updated}</p>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-slate-600">
              DanceFlow uses layered safeguards designed to protect studio operations,
              customer records, schedules, payments, documents, and connected
              integrations. No online service can promise perfect security, but security
              is built into how DanceFlow authorizes access and handles sensitive
              workflows.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-5xl space-y-6 px-6 py-10">
          <Section title="How DanceFlow protects customer data">
            <div className="grid gap-4 md:grid-cols-2">
              <Protection control="Role-based workspace access" protects="Limits staff and instructor access to the functions their assigned role is allowed to use." />
              <Protection control="Server-side authorization" protects="Checks permissions on the server rather than trusting buttons, links, or browser state." />
              <Protection control="Workspace data isolation" protects="Uses database security policies and studio context to reduce the risk of one workspace accessing another workspace's records." />
              <Protection control="Protected authentication" protects="Uses managed authentication, secure sessions, and account recovery controls to protect user access." />
              <Protection control="Encrypted connections" protects="Protects information while it travels between a user's device, DanceFlow, and supported service providers." />
              <Protection control="Protected integration credentials" protects="Stores supported OAuth credentials encrypted and limits their use to the integration the customer enabled." />
              <Protection control="Stripe payment handling" protects="Keeps full card numbers and card security codes out of DanceFlow application storage by using Stripe payment experiences." />
              <Protection control="Upload validation" protects="Checks supported file type, extension, size, and content expectations before accepting sensitive uploads." />
              <Protection control="Rate limiting and abuse controls" protects="Reduces automated guessing, repeated signing attempts, high-volume abuse, and excessive public requests." />
              <Protection control="Private signing links" protects="Uses high-entropy signing tokens stored as hashes rather than storing the usable public token directly." />
              <Protection control="Signed-document integrity records" protects="Preserves document hashes, timestamps, consent text, signature method, and audit events to help detect change and support attribution." />
              <Protection control="Restricted document delivery" protects="Uses private storage, short-lived access where applicable, no-store caching, and browser security headers for signing documents." />
              <Protection control="Security logging and monitoring" protects="Records important workflow and error information needed to investigate suspicious activity and service failures." />
              <Protection control="Data minimization in public pages" protects="Limits public discovery and signing pages to the information intentionally needed for that experience." />
            </div>
          </Section>

          <Section title="Customer security responsibilities">
            <ul className="list-disc space-y-2 pl-6">
              <li>Use unique passwords and protect email accounts used for authentication.</li>
              <li>Assign the least access needed and remove former staff promptly.</li>
              <li>Review integrations and disconnect accounts that are no longer used.</li>
              <li>Do not place unnecessary sensitive information in notes, uploads, or AI prompts.</li>
              <li>Report suspicious access, unexpected messages, or exposed links promptly.</li>
              <li>Export and retain records your business must preserve independently.</li>
            </ul>
          </Section>

          <Section title="Payments">
            <p>
              DanceFlow uses Stripe for supported card-processing workflows. Depending
              on the transaction, the studio or organizer&apos;s connected Stripe
              account may be the merchant responsible for fulfillment, refunds, and
              disputes. DanceFlow does not intentionally store full card numbers or
              card security codes.
            </p>
          </Section>

          <Section title="Privacy and data processing">
            <p>
              Security and privacy work together. Review the{" "}
              <Link href="/privacy" className="font-semibold text-slate-950 underline">
                Privacy Policy
              </Link>{" "}
              and{" "}
              <Link href="/dpa" className="font-semibold text-slate-950 underline">
                Data Processing Addendum
              </Link>{" "}
              for information about processing roles, providers, retention, requests,
              and customer responsibilities.
            </p>
          </Section>

          <Section title="Responsible disclosure">
            <p>
              Send suspected vulnerabilities to{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>{" "}
              with the affected URL, steps to reproduce, expected and observed
              behavior, and relevant screenshots or logs.
            </p>
            <p>
              Do not access, modify, download, delete, or disclose data that does not
              belong to you. Do not disrupt service, test against other customers, use
              automated high-volume scanning, or publicly disclose an issue before
              DanceFlow has had a reasonable opportunity to investigate and remediate
              it.
            </p>
          </Section>

          <Section title="Security questions">
            <p>
              Customers evaluating DanceFlow may contact support for reasonable
              security and data-processing questions. Information may be limited where
              disclosure could weaken security or expose confidential architecture.
            </p>
          </Section>
        </section>
      </main>
      <PublicSiteFooter />
    </>
  );
}
