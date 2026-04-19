import Image from "next/image";
import Link from "next/link";

type PublicSiteHeaderProps = {
  currentPath?: "home" | "discover" | "studios" | "events" | "pricing" | "account" | "favorites";
  isAuthenticated?: boolean;
};

function navClass(active: boolean) {
  return active
    ? "rounded-xl bg-orange-50 px-3 py-2 text-sm font-medium text-[var(--brand-accent-dark)]"
    : "rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900";
}

export default function PublicSiteHeader({
  currentPath,
  isAuthenticated = false,
}: PublicSiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-4">
          <Link href="/" className="flex items-center gap-3">
            <div className="rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
              <Image
                src="/brand/danceflow-logo.png"
                alt="DanceFlow logo"
                width={52}
                height={52}
                className="h-11 w-11 object-contain"
                priority
              />
            </div>

            <div className="min-w-0">
              <p className="truncate text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                DanceFlow
              </p>
              <p className="truncate text-xs text-slate-500">
                Studio software + public discovery
              </p>
            </div>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            <Link href="/" className={navClass(currentPath === "home")}>
              Home
            </Link>

            <Link
              href="/discover/studios"
              className={navClass(
                currentPath === "discover" || currentPath === "studios"
              )}
            >
              Studios
            </Link>

            <Link
              href="/discover/events"
              className={navClass(currentPath === "events")}
            >
              Events
            </Link>

            <Link
              href="/get-started"
              className={navClass(currentPath === "pricing")}
            >
              Pricing
            </Link>

            {isAuthenticated ? (
              <>
                <Link
                  href="/account"
                  className={navClass(currentPath === "account")}
                >
                  Account
                </Link>

                <Link
                  href="/favorites"
                  className={navClass(currentPath === "favorites")}
                >
                  Favorites
                </Link>
              </>
            ) : null}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          {isAuthenticated ? (
            <>
              <Link
                href="/favorites"
                className="hidden rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:inline-flex"
              >
                Favorites
              </Link>

              <Link
                href="/account"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                My Account
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:inline-flex"
              >
                Log In
              </Link>

              <Link
                href="/signup"
                className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Create Free Account
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}