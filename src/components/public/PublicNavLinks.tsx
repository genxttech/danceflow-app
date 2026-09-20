"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  PUBLIC_NAV_ITEMS,
  activePublicNavKey,
  type PublicNavPath,
} from "./publicNav";

type PublicNavLinksProps = {
  isAuthenticated: boolean;
  /** Optional explicit override; otherwise the active item is derived from the pathname. */
  currentPath?: PublicNavPath;
  variant: "bar" | "panel";
};

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

export default function PublicNavLinks({
  isAuthenticated,
  currentPath,
  variant,
}: PublicNavLinksProps) {
  const pathname = usePathname();
  const active = currentPath ?? activePublicNavKey(pathname);
  const items = PUBLIC_NAV_ITEMS.filter((item) => !item.authOnly || isAuthenticated);

  return (
    <>
      {items.map((item) => {
        const isActive = active === item.key;
        const base =
          variant === "bar"
            ? "rounded-xl px-3 py-2 text-sm font-medium"
            : "block rounded-xl px-3 py-2.5 text-base font-medium";
        const state = isActive
          ? "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
          : "text-slate-600 hover:bg-slate-100 hover:text-slate-900";

        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={`${base} ${state} ${focusRing}`}
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
