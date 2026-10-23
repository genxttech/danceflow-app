"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AudienceMenu from "./AudienceMenu";
import {
  PUBLIC_NAV_ITEMS,
  activePublicNavKey,
  isCurrentPublicNavChild,
  type PublicNavItem,
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
  const groups = items.filter((item) => item.children);
  const links = items.filter((item) => !item.children);

  function renderLink(item: PublicNavItem) {
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
  }

  // Desktop bar: each audience group is a disclosure, followed by the signed-in links.
  if (variant === "bar") {
    return (
      <>
        {groups.map((item) => (
          <AudienceMenu
            key={item.key}
            label={item.label}
            items={item.children!}
            active={active === item.key}
          />
        ))}
        {links.map(renderLink)}
      </>
    );
  }

  // Mobile panel: labelled groups (For Dancers first), side by side from `sm`.
  return (
    <>
      <div className="grid gap-1 sm:grid-cols-2 sm:gap-6">
        {groups.map((item) => {
          const headingId = `public-nav-group-${item.key}`;
          return (
            <div key={item.key} role="group" aria-labelledby={headingId}>
              <p
                id={headingId}
                className={`px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-[0.14em] ${
                  active === item.key ? "text-[var(--brand-primary)]" : "text-slate-500"
                }`}
              >
                {item.label}
              </p>
              <ul>
                {item.children!.map((child) => {
                  const current = isCurrentPublicNavChild(pathname, child.href);
                  return (
                    <li key={child.href}>
                      {child.dividerBefore ? (
                        <hr className="mx-3 my-1.5 border-slate-100" aria-hidden="true" />
                      ) : null}
                      <Link
                        href={child.href}
                        aria-current={current ? "page" : undefined}
                        className={`block rounded-xl px-3 py-2.5 text-base font-medium ${
                          current
                            ? "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]"
                            : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                        } ${focusRing}`}
                      >
                        {child.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {links.length > 0 ? (
        <div className="mt-1 grid gap-1 border-t border-slate-100 pt-2">{links.map(renderLink)}</div>
      ) : null}
    </>
  );
}
