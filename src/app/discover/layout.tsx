import Image from "next/image";
import Link from "next/link";

function navLinkClass(href: string) {
  return "text-sm font-medium text-slate-700 transition hover:text-slate-950";
}

export default function DiscoverLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f8fafc_0%,#eef2ff_26%,#f8fafc_58%,#f8fafc_100%)] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
            <Link href="/" className="flex items-center gap-4">
              <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <Image
                  src="/brand/danceflow-logo.png"
                  alt="DanceFlow"
                  width={56}
                  height={56}
                  className="h-12 w-12 object-contain"
                  priority
                />
              </div>

              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-violet-600">
                  Discover Dance
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
                  DanceFlow Discover
                </h1>
                <p className="mt-1 text-sm text-slate-600">
                  The public front door for studios, events, and new dancers.
                </p>
              </div>
            </Link>
          </div>

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <Link href="/" className={navLinkClass("/")}>
              Home
            </Link>
            <Link href="/discover" className={navLinkClass("/discover")}>
              Discover
            </Link>
            <Link href="/discover/studios" className={navLinkClass("/discover/studios")}>
              Studios
            </Link>
            <Link href="/discover/events" className={navLinkClass("/discover/events")}>
              Events
            </Link>
            <Link
              href="/login"
              className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Studio Login
            </Link>
          </div>
        </div>
      </header>

      <div>{children}</div>

      <footer className="border-t border-slate-200/80 bg-white/90">
        <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-8 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div>
            <p className="text-sm font-semibold text-slate-900">DanceFlow</p>
            <p className="mt-1 text-sm text-slate-600">
              Studio management, public discovery, and growth tools for dance businesses.
            </p>
          </div>

          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-600">
            <Link href="/" className="hover:text-slate-900">
              Home
            </Link>
            <Link href="/discover/studios" className="hover:text-slate-900">
              Studios
            </Link>
            <Link href="/discover/events" className="hover:text-slate-900">
              Events
            </Link>
            <Link href="/login" className="hover:text-slate-900">
              Login
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
