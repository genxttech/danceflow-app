import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Acceptable Use Policy | DanceFlow",
  description: "Rules protecting DanceFlow users, workspaces, communications, data, and service reliability.",
  alternates: { canonical: "/acceptable-use" },
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

export default function AcceptableUsePage() {
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
              Acceptable Use Policy
            </h1>
            <p className="mt-4 text-slate-600">Effective: {updated}</p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl space-y-6 px-6 py-10">
          <Section title="Purpose">
            <p>
              This Policy protects DanceFlow, its users, connected providers, and the
              public. It applies to all accounts, workspaces, portals, integrations,
              public pages, communications, uploads, APIs, and automated activity.
            </p>
          </Section>

          <Section title="Prohibited security activity">
            <ul className="list-disc space-y-2 pl-6">
              <li>Accessing or attempting to access an account, workspace, record, system, or network without authorization.</li>
              <li>Bypassing permissions, authentication, rate limits, subscription controls, or technical restrictions.</li>
              <li>Scanning, penetration testing, exploit testing, or vulnerability probing without prior written authorization.</li>
              <li>Introducing malware, malicious code, destructive payloads, credential theft, or denial-of-service activity.</li>
              <li>Interfering with logs, security controls, incident investigation, or another user&apos;s access.</li>
            </ul>
          </Section>

          <Section title="Prohibited content and conduct">
            <ul className="list-disc space-y-2 pl-6">
              <li>Illegal, fraudulent, deceptive, threatening, abusive, harassing, discriminatory, or exploitative activity.</li>
              <li>Impersonation, false affiliation, fraudulent payments, forged records, or misleading public listings.</li>
              <li>Content that infringes intellectual-property, privacy, publicity, confidentiality, or contractual rights.</li>
              <li>Sexual exploitation, child sexual abuse material, trafficking, or content that endangers minors.</li>
              <li>Uploading or distributing content you lack authority to collect, use, disclose, or transmit.</li>
            </ul>
          </Section>

          <Section title="Messaging and marketing">
            <ul className="list-disc space-y-2 pl-6">
              <li>Do not send spam, purchased-list campaigns, deceptive messages, or communications without a lawful basis or required consent.</li>
              <li>Do not conceal sender identity, misrepresent opt-in status, or interfere with STOP, unsubscribe, suppression, or complaint handling.</li>
              <li>Do not use DanceFlow for unlawful telemarketing, phishing, credential harvesting, or financial scams.</li>
            </ul>
          </Section>

          <Section title="Data, scraping, and automation">
            <ul className="list-disc space-y-2 pl-6">
              <li>Do not scrape, harvest, copy, resell, or aggregate DanceFlow data except through authorized features and for permitted business purposes.</li>
              <li>Do not use bots, scripts, or automated requests that create unreasonable load, evade limits, or degrade service.</li>
              <li>Do not attempt to derive source code, model weights, credentials, secrets, or private system information.</li>
              <li>Do not use exports or reports to expose sensitive personal information without authorization.</li>
            </ul>
          </Section>

          <Section title="AI features">
            <ul className="list-disc space-y-2 pl-6">
              <li>Do not use AI features to generate unlawful, deceptive, harassing, discriminatory, dangerous, or rights-infringing content.</li>
              <li>Do not represent AI output as verified professional advice or intentionally publish unreviewed output as fact.</li>
              <li>Do not submit confidential or personal information unless authorized and reasonably necessary for the selected workflow.</li>
            </ul>
          </Section>

          <Section title="Enforcement">
            <p>
              DanceFlow may investigate suspected violations and may remove content,
              restrict functionality, suspend accounts, terminate access, preserve
              evidence, notify affected customers or providers, and cooperate with
              lawful authorities. We may take immediate action when necessary to
              protect users, data, payments, or service availability.
            </p>
          </Section>

          <Section title="Reporting concerns">
            <p>
              Report abuse or security concerns to{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>
              . Include enough detail for us to identify the affected account,
              workspace, page, or activity.
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
