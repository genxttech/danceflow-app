import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import PublicShell from "@/components/public/PublicShell";

export const metadata: Metadata = {
  title: "Delete your DanceFlow account",
  description: "How to delete a DanceFlow dancer account in the app, or by emailing support, and what is removed or kept.",
  alternates: { canonical: "/account-deletion" },
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold text-slate-950">{title}</h2>
      <div className="mt-3 space-y-4 text-sm leading-7 text-slate-600">{children}</div>
    </section>
  );
}

export default function AccountDeletionPage() {
  return (
    <PublicShell>
      <main className="min-h-screen bg-[linear-gradient(180deg,#fff7ed_0%,#f8fafc_34%,#ffffff_100%)]">
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-4xl px-6 py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-accent,#c2410c)]">
              DanceFlow account
            </p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 sm:text-5xl">
              Delete your DanceFlow account
            </h1>
            <p className="mt-4 text-slate-600">
              This page explains how a dancer can delete their DanceFlow account and what that does.
              You do not need to sign in to read it.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl space-y-6 px-6 py-10">
          <Section title="Delete it in the DanceFlow app">
            <ol className="list-decimal space-y-2 pl-5">
              <li>Open the DanceFlow app and sign in.</li>
              <li>Go to Settings.</li>
              <li>Under Account controls, choose Delete Account.</li>
              <li>Confirm twice. Deletion cannot be undone.</li>
            </ol>
            <p>
              You can also sign in on the web at{" "}
              <Link href="/account" className="font-semibold text-slate-950 underline">
                idanceflow.com/account
              </Link>{" "}
              and use the account controls there. If you would rather pause than delete, Settings also has
              Deactivate Account and a data export.
            </p>
          </Section>

          <Section title="Delete it by email">
            <p>
              If you cannot sign in, email{" "}
              <a href="mailto:support@idanceflow.com" className="font-semibold text-slate-950 underline">
                support@idanceflow.com
              </a>{" "}
              from the email address on the account and ask us to delete it. We may ask you to confirm the
              request from that address before we act, so that nobody else can delete your account.
            </p>
          </Section>

          <Section title="What is removed">
            <p>
              Deleting your account permanently removes your DanceFlow login, your dancer profile, favorites,
              preferences, and other data that belongs to your account.
            </p>
          </Section>

          <Section title="What may be kept">
            <p>
              Studios and organizers you dealt with may retain their own business records, such as billing,
              attendance, documents, payments, and communications. DanceFlow may also keep information where
              the law requires it or to resolve disputes, and some data may remain in protected backups for a
              limited period. See the{" "}
              <Link href="/privacy" className="font-semibold text-slate-950 underline">
                Privacy Policy
              </Link>
              .
            </p>
            <p>
              A login that also manages a studio, an organizer account, or the platform cannot be deleted in
              the app. Hand over or remove those roles first, or contact support.
            </p>
          </Section>
        </section>
      </main>
    </PublicShell>
  );
}
