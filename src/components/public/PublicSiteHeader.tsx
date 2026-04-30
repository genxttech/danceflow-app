import Image from "next/image";
import Link from "next/link";

type PublicSiteHeaderProps = {
  currentPath?:
    | "home"
    | "discover"
    | "studios"
    | "events"
    | "pricing"
    | "account"
    | "favorites";
  isAuthenticated?: boolean;
};

function navClass(active: boolean) {
  return active
    ? "rounded-xl bg-orange-50 px-3 py-2 text-sm font-medium text-[var(--brand-accent-dark)]"
    : "rounded-xl px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900";
}

function mobileNavClass(active: boolean) {
  return active
    ? "rounded-xl bg-orange-50 px-3 py-2 text-sm font-medium text-[var(--brand-accent-dark)]"
    : "rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50";
}

export default function PublicSiteHeader({
  currentPath,
  isAuthenticated = false,
}: PublicSiteHeaderProps) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/" className="flex min-w-0 items-center gap-3">
              <div className="shrink-0 rounded-2xl bg-white p-2 shadow-sm ring-1 ring-slate-200">
                <Image
                  src="/brand/danceflow-logo.png"
                  alt="DanceFlow logo"
                  width={52}
                  height={52}
                  className="h-10 w-10 object-contain sm:h-11 sm:w-11"
                  priority
                />
              </div>

              <div className="hidden min-w-0 sm:block">
                <p className="truncate text-sm font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
                  DanceFlow
                </p>
                <p className="hidden truncate text-xs text-slate-500 sm:block">
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

          <div className="flex shrink-0 items-center gap-2">
            {isAuthenticated ? (
              <>
                <Link
                  href="/app"
                  className="rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-95 sm:px-4"
                >
                  <span className="sm:hidden">Workspace</span>
                  <span className="hidden sm:inline">Go to Workspace</span>
                </Link>

                <Link
                  href="/account"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:px-4"
                >
                  <span className="sm:hidden">Account</span>
                  <span className="hidden sm:inline">My Account</span>
                </Link>
              </>
            ) : (
              <>
                <Link
                  href="/login?intent=public"
                  className="inline-flex rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:px-4"
                >
                  Log In
                </Link>

                <Link
                  href="/signup"
                  className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800 sm:px-4"
                >
                  <span className="sm:hidden">Free Account</span>
                  <span className="hidden sm:inline">Create Free Account</span>
                </Link>
              </>
            )}
          </div>
        </div>

        <nav className="mt-3 flex flex-wrap gap-2 lg:hidden">
          <Link href="/" className={mobileNavClass(currentPath === "home")}>
            Home
          </Link>

          <Link
            href="/discover/studios"
            className={mobileNavClass(
              currentPath === "discover" || currentPath === "studios"
            )}
          >
            Studios
          </Link>

          <Link
            href="/discover/events"
            className={mobileNavClass(currentPath === "events")}
          >
            Events
          </Link>

          <Link
            href="/get-started"
            className={mobileNavClass(currentPath === "pricing")}
          >
            Pricing
          </Link>

          {isAuthenticated ? (
            <>
              <Link href="/app" className={mobileNavClass(false)}>
                Workspace
              </Link>

              <Link
                href="/favorites"
                className={mobileNavClass(currentPath === "favorites")}
              >
                Favorites
              </Link>

              <Link
                href="/account"
                className={mobileNavClass(currentPath === "account")}
              >
                Account
              </Link>
            </>
          ) : null}
        </nav>
      </div>
    </header>
  );
}
