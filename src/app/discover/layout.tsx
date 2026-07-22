import type { ReactNode } from "react";
import Link from "next/link";
import { BriefcaseBusiness, CalendarDays, GraduationCap, MapPinned, UsersRound } from "lucide-react";

const discoveryLinks = [
  {
    href: "/discover/studios",
    label: "Studios",
    icon: MapPinned,
    classes: "border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100",
  },
  {
    href: "/discover/events",
    label: "Events",
    icon: CalendarDays,
    classes: "border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100",
  },
  {
    href: "/discover/partners",
    label: "Partners",
    icon: UsersRound,
    classes: "border-pink-200 bg-pink-50 text-pink-800 hover:bg-pink-100",
  },
  {
    href: "/discover/jobs",
    label: "Jobs",
    icon: BriefcaseBusiness,
    classes: "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  },
  {
    href: "/marketplace",
    label: "Marketplace",
    icon: GraduationCap,
    classes: "border-blue-200 bg-blue-50 text-blue-800 hover:bg-blue-100",
  },
];

export default function DiscoverLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <header className="border-b border-[var(--brand-border)] bg-white/95">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/discover" className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--brand-primary)]">
            DanceFlow Discovery
          </Link>
          <nav className="flex flex-wrap gap-2">
            {discoveryLinks.map((link) => {
              const Icon = link.icon;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`inline-flex items-center gap-2 rounded-2xl border px-4 py-2.5 text-sm font-semibold shadow-sm transition hover:-translate-y-0.5 ${link.classes}`}
                >
                  <Icon className="h-4 w-4" />
                  {link.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      {children}
    </>
  );
}
