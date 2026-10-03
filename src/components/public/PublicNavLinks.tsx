"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import ForBusinessMenu from "./ForBusinessMenu";
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

        // Grouped item: a disclosure on the desktop bar, a labelled inline list in the mobile panel.
        if (item.children) {
          if (variant === "bar") {
            return (
              <ForBusinessMenu
                key={item.key}
                label={item.label}
                items={item.children}
                active={isActive}
              />
            );
          }

          return (
            <div key={item.key} className="mt-1">
              <p
                className={`px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.14em] ${
                  isActive ? "text-[var(--brand-primary)]" : "text-slate-500"
                }`}
              >
                {item.label}
              </p>
              {item.children.map((child) => (
                <Link
                  key={child.href}
                  href={child.href}
                  aria-current={pathname === child.href ? "page" : undefined}
                  className={`block rounded-xl px-3 py-2.5 text-base font-medium ${
                    pathname === child.href
                      ? "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                      : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                  } ${focusRing}`}
                >
                  {child.label}
                </Link>
              ))}
            </div>
          );
        }

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
