import type { ReactNode } from "react";
import Link from "next/link";

const discoveryLinks = [
  { href: "/discover/studios", label: "Studios" },
  { href: "/discover/events", label: "Events" },
  { href: "/discover/partners", label: "Partners" },
  { href: "/discover/jobs", label: "Jobs" },
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
            {discoveryLinks.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:border-[var(--brand-primary)] hover:text-[var(--brand-primary)]"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      {children}
    </>
  );
}
