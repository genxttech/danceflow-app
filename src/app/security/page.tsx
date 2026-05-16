import type { Metadata } from "next";
import Link from "next/link";
import PublicSiteFooter from "@/components/public/PublicSiteFooter";
import PublicSiteHeader from "@/components/public/PublicSiteHeader";

export const metadata: Metadata = {
  title: "Security | DanceFlow",
  description: "DanceFlow security practices, payment handling, and responsible disclosure.",
};

const updated = "May 15, 2026";

export default function Page() {
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
              Security
            </h1>
            <p className="mt-4 text-base leading-7 text-slate-600">
              Last updated: {updated}
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-6 py-10">
          <div className="space-y-8 rounded-[2rem] border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Security overview</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow is built with role-based workspace access, server-side authorization checks, Supabase row-level security where applicable, and Stripe-hosted payment processing.</p>
              <p className="mt-3 text-sm leading-7 text-slate-600">Card numbers and card security codes should be entered through Stripe-hosted payment experiences, not stored directly by DanceFlow.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Access controls</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Workspace access is scoped by role and account context. Platform-admin and sensitive operational workflows should use multi-factor authentication and follow least-privilege access practices.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Data isolation</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">Studio, client, payment, event, and portal data should be protected by server-side checks and database policies. Public discovery pages should only expose content intentionally published by an eligible active/trialing workspace.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Vulnerability reporting</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">If you believe you found a security issue, email support@idanceflow.com with a description, affected URL, steps to reproduce, and any relevant screenshots or logs. Do not access, modify, delete, or disclose data that does not belong to you.</p>
            </section>
            <section>
              <h2 className="text-xl font-semibold text-slate-950">Roadmap controls</h2>
              <p className="mt-3 text-sm leading-7 text-slate-600">DanceFlow is building toward stronger security maturity, including audit logs for sensitive role/billing changes, platform admin MFA enforcement, alerting for server errors and billing risks, data export/deletion procedures, accessibility improvements, and future SOC 2 readiness.</p>
            </section>

          </div>

          <div className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-5 text-sm leading-6 text-slate-600">
            Questions about this page? Contact{" "}
            <a className="font-semibold text-slate-950 hover:underline" href="mailto:support@idanceflow.com">
              support@idanceflow.com
            </a>
            .
          </div>

          <div className="mt-8">
            <Link href="/" className="text-sm font-semibold text-slate-700 hover:text-slate-950">
              ← Back to DanceFlow
            </Link>
          </div>
        </section>
      </main>

      
      <PublicSiteFooter />
    </>
  );
}
