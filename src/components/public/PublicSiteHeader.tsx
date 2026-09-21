import Image from "next/image";
import Link from "next/link";
import PublicMobileMenu from "./PublicMobileMenu";
import SkipToMainLink from "@/components/shell/SkipToMainLink";
import PublicNavLinks from "./PublicNavLinks";
import type { PublicNavPath } from "./publicNav";

type PublicSiteHeaderProps = {
  /** Optional override; by default the active item is derived from the current pathname. */
  currentPath?: PublicNavPath;
  isAuthenticated?: boolean;
};

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

const secondaryAction = `rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:px-4 ${focusRing}`;
const primaryAction = `rounded-xl bg-[var(--brand-primary)] px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[var(--brand-primary-dark)] sm:px-4 ${focusRing}`;

export default function PublicSiteHeader({
  currentPath,
  isAuthenticated = false,
}: PublicSiteHeaderProps) {
  return (
    <>
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur">
      <SkipToMainLink />
      <div className="mx-auto max-w-7xl px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-4">
            <Link
              href="/"
              className={`flex shrink-0 items-center rounded-lg ${focusRing}`}
            >
              {/* Only one of these is displayed at a time, so the brand is announced once. */}
              <Image
                src="/brand/logo/danceflow-symbol-128.png"
                alt="DanceFlow"
                width={128}
                height={177}
                className="h-10 w-auto sm:hidden"
              />
              <Image
                src="/brand/logo/danceflow-logo-primary-640.png"
                alt="DanceFlow"
                width={640}
                height={160}
                sizes="150px"
                className="hidden h-auto w-[150px] sm:block"
              />
            </Link>

            <nav aria-label="Primary" className="hidden items-center gap-1 lg:flex">
              <PublicNavLinks
                isAuthenticated={isAuthenticated}
                currentPath={currentPath}
                variant="bar"
              />
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isAuthenticated ? (
              <>
                <Link href="/app" className={primaryAction}>
                  <span className="sm:hidden">Workspace</span>
                  <span className="hidden sm:inline">Go to Workspace</span>
                </Link>
                <Link href="/account" className={`hidden sm:inline-flex ${secondaryAction}`}>
                  My Account
                </Link>
              </>
            ) : (
              <>
                <Link href="/login?intent=public" className={secondaryAction}>
                  Log In
                </Link>
                <Link href="/signup" className={`hidden sm:inline-flex ${primaryAction}`}>
                  Create Free Account
                </Link>
              </>
            )}

            <PublicMobileMenu>
              <PublicNavLinks
                isAuthenticated={isAuthenticated}
                currentPath={currentPath}
                variant="panel"
              />
              {isAuthenticated ? (
                <Link href="/account" className={`mt-1 sm:hidden ${secondaryAction} text-center`}>
                  My Account
                </Link>
              ) : (
                <Link href="/signup" className={`mt-1 sm:hidden ${primaryAction} text-center`}>
                  Create Free Account
                </Link>
              )}
            </PublicMobileMenu>
          </div>
        </div>
      </div>
    </header>
    {/* Skip-link target: zero-height, programmatically focusable, sits just before page content. */}
    <div id="main-content" tabIndex={-1} className="h-0 outline-none" />
    </>
  );
}
