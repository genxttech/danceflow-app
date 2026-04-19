import Link from "next/link";

export default function PublicSiteFooter() {
  return (
    <footer className="border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:px-6 lg:grid-cols-[1.3fr_1fr_1fr] lg:px-8">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            DanceFlow
          </p>
          <p className="mt-3 max-w-md text-sm leading-7 text-slate-600">
            A better way for dancers to discover opportunities and for studios to manage
            growth, clients, schedules, memberships, and public events.
          </p>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-900">Explore</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <Link href="/" className="hover:text-slate-900">Home</Link>
            <Link href="/discover/studios" className="hover:text-slate-900">Studios</Link>
            <Link href="/discover/events" className="hover:text-slate-900">Events</Link>
            <Link href="/get-started" className="hover:text-slate-900">Pricing</Link>
          </div>
        </div>

        <div>
          <p className="text-sm font-semibold text-slate-900">Get Started</p>
          <div className="mt-3 grid gap-2 text-sm text-slate-600">
            <Link href="/signup" className="hover:text-slate-900">Create Free Account</Link>
            <Link href="/login" className="hover:text-slate-900">Log In</Link>
            <Link href="/account" className="hover:text-slate-900">Account</Link>
            <Link href="/favorites" className="hover:text-slate-900">Favorites</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}