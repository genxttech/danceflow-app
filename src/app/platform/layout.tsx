import Image from "next/image";
import Link from "next/link";
import PlatformAdminNav from "./PlatformAdminNav";
import { requirePlatformAdmin } from "@/lib/auth/platform";
import {
  enterStudioContextAction,
  getPlatformSelectedStudioId,
} from "@/app/platform/actions";
import { signOutAction } from "@/app/(auth)/actions";
import { requirePlatformMfa } from "@/lib/auth/platform-mfa";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePlatformAdmin();
  await requirePlatformMfa();

  const selectedStudioId = await getPlatformSelectedStudioId();

  const navItems = [
    { href: "/platform", label: "Dashboard" },
    { href: "/platform/studios", label: "Studios" },
    { href: "/platform/organizers", label: "Organizers" },
    { href: "/platform/billing", label: "Billing" },
    { href: "/platform/invites", label: "Invites" },
    { href: "/platform/credentials", label: "Credentials" },
    { href: "/platform/support-notes", label: "Support Notes" },
    { href: "/platform/webhooks", label: "Webhook Health" },
  ];

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,#f8fafc_0%,#eef2ff_28%,#f8fafc_58%,#f8fafc_100%)]">
      <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
            <Link
              href="/platform"
              className="shrink-0 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]"
            >
              <Image
                src="/brand/logo/danceflow-logo-primary-320.png"
                alt="DanceFlow"
                width={320}
                height={112}
                sizes="130px"
                className="h-auto w-[130px]"
                priority
              />
            </Link>

            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
                Platform Admin
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

            <form action={signOutAction}>
              <button
                type="submit"
                className="inline-flex rounded-xl border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-700 shadow-sm transition hover:bg-rose-100"
              >
                Log Out
              </button>
            </form>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[260px_minmax(0,1fr)] lg:px-8">
        <aside className="h-fit rounded-[2rem] border border-slate-200/80 bg-white/95 p-4 shadow-sm">
          <div className="mb-4 rounded-2xl bg-gradient-to-br from-[var(--brand-primary-soft)] via-white to-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Navigation
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Move between platform operations without losing the branded public-facing feel of DanceFlow.
            </p>
          </div>

          <PlatformAdminNav items={navItems} />

          <div className="mt-6 border-t border-slate-200 pt-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Session
            </p>

            <form action={signOutAction}>
              <button
                type="submit"
                className="w-full rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 transition hover:bg-rose-100"
              >
                Log Out
              </button>
            </form>
          </div>
        </aside>

        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}




