import Link from "next/link";

export default function PublicSiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.3fr_1fr_1fr_1.2fr] lg:px-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            DanceFlow
          </p>
          <p className="mt-3 max-w-md text-sm leading-7 text-slate-600">
            DanceFlow helps run the studio, so owners can focus on teaching.
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-900">Explore</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <Link href="/discover" className="hover:text-slate-900">Discovery Home</Link>
            <Link href="/discover/studios" className="hover:text-slate-900">Studios</Link>
            <Link href="/discover/events" className="hover:text-slate-900">Events</Link>
            <Link href="/discover/partners" className="hover:text-slate-900">Dance Partners</Link>
            <Link href="/discover/jobs" className="hover:text-slate-900">Dance Jobs</Link>
            <Link href="/marketplace" className="hover:text-slate-900">Marketplace</Link>
            <Link href="/get-started" className="hover:text-slate-900">Pricing</Link>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-900">Account &amp; Support</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <Link href="/signup" className="hover:text-slate-900">Create Account</Link>
            <Link href="/login" className="hover:text-slate-900">Log In</Link>
            <Link href="/knowledgebase" className="hover:text-slate-900">Knowledgebase</Link>
            <Link href="/security" className="hover:text-slate-900">Security</Link>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-900">Legal &amp; Trust</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <Link href="/terms" className="hover:text-slate-900">SaaS Terms</Link>
            <Link href="/privacy" className="hover:text-slate-900">Privacy Policy</Link>
            <Link href="/acceptable-use" className="hover:text-slate-900">Acceptable Use</Link>
            <Link href="/dpa" className="hover:text-slate-900">Data Processing Addendum</Link>
            <Link href="/electronic-signature-consent" className="hover:text-slate-900">Electronic Signatures</Link>
            <Link href="/sms-consent" className="hover:text-slate-900">SMS Consent</Link>
            <Link href="/refund-policy" className="hover:text-slate-900">Refund Policy</Link>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-100">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-5 text-sm text-slate-500 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <p>© {new Date().getFullYear()} DanceFlow. All rights reserved.</p>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Link href="/privacy" className="hover:text-slate-900">Privacy</Link>
            <Link href="/terms" className="hover:text-slate-900">Terms</Link>
            <Link href="/security" className="hover:text-slate-900">Security</Link>
            <a href="mailto:support@idanceflow.com" className="hover:text-slate-900">Contact</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
