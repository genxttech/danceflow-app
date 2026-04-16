import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  enterStudioContextAction,
  getPlatformSelectedStudioId,
} from "@/app/platform/actions";

function isActivePath(currentPath: string, href: string) {
  if (href === "/platform") {
    return currentPath === "/platform";
  }

  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePlatformAdmin();

  const headerStore = await headers();
  const pathname = headerStore.get("x-pathname") ?? "";
  const selectedStudioId = await getPlatformSelectedStudioId();

  const navItems = [
    { href: "/platform", label: "Dashboard" },
    { href: "/platform/studios", label: "Studios" },
    { href: "/platform/organizers", label: "Organizers" },
    { href: "/platform/billing", label: "Billing" },
  ];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f8fafc_0%,#eef2ff_28%,#f8fafc_58%,#f8fafc_100%)]">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
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
                Platform Admin
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950">
                DanceFlow Platform
              </h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage studios, organizer growth, and platform billing from one branded hub.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/"
              className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Marketing Site
            </Link>

            <Link
              href="/platform"
              className="inline-flex rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
            >
              Platform Home
            </Link>

            {selectedStudioId ? (
              <form action={enterStudioContextAction}>
                <input type="hidden" name="studioId" value={selectedStudioId} />
                <button
                  type="submit"
                  className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
                >
                  Open Studio App
                </button>
              </form>
            ) : (
              <Link
                href="/platform/studios"
                className="inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
              >
                Select Studio
              </Link>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8">
        <aside className="h-fit rounded-[2rem] border border-slate-200/80 bg-white/95 p-4 shadow-sm">
          <div className="mb-4 rounded-2xl bg-gradient-to-br from-violet-50 via-white to-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Navigation
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Move between platform operations without losing the branded public-facing feel of DanceFlow.
            </p>
          </div>

          <nav className="space-y-2">
            {navItems.map((item) => {
              const active = isActivePath(pathname, item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`block rounded-2xl px-4 py-3 text-sm font-medium transition ${
                    active
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
