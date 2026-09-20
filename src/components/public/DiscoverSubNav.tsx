"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BriefcaseBusiness,
  CalendarDays,
  GraduationCap,
  MapPinned,
  UsersRound,
} from "lucide-react";

const discoverLinks = [
  { href: "/discover/studios", label: "Studios", icon: MapPinned },
  { href: "/discover/events", label: "Events", icon: CalendarDays },
  { href: "/discover/partners", label: "Partners", icon: UsersRound },
  { href: "/discover/jobs", label: "Jobs", icon: BriefcaseBusiness },
  { href: "/marketplace", label: "Marketplace", icon: GraduationCap },
];

/** Discover context bar; sits under the canonical public header and scrolls sideways on narrow screens. */
export default function DiscoverSubNav() {
  const pathname = usePathname();

  return (
    <div className="border-b border-[var(--brand-border)] bg-white/95">
      <nav
        aria-label="Discover"
        className="mx-auto flex max-w-7xl items-center gap-2 overflow-x-auto px-4 py-2.5 sm:px-6 lg:px-8"
      >
        <Link
          href="/discover"
          aria-current={pathname === "/discover" ? "page" : undefined}
          className="shrink-0 rounded-xl px-3 py-2 text-sm font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)] aria-[current=page]:bg-[var(--brand-primary-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]"
        >
          Discover
        </Link>
        {discoverLinks.map((link) => {
          const Icon = link.icon;
          const active =
            pathname === link.href || pathname.startsWith(`${link.href}/`);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-[var(--brand-primary-soft)] aria-[current=page]:border-[var(--brand-primary)] aria-[current=page]:bg-[var(--brand-primary-soft)] aria-[current=page]:text-[var(--brand-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]"
            >
              <Icon aria-hidden="true" className="h-4 w-4" />
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
