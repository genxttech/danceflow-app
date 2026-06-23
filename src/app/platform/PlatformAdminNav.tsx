"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItem = {
  href: string;
  label: string;
};

function isActivePath(currentPath: string, href: string) {
  if (href === "/platform") {
    return currentPath === "/platform";
  }

  return currentPath === href || currentPath.startsWith(`${href}/`);
}

export default function PlatformAdminNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const normalizedItems = [...items];

  if (!normalizedItems.some((item) => item.href === "/platform/alerts")) {
    normalizedItems.splice(1, 0, {
      href: "/platform/alerts",
      label: "Alerts",
    });
  }

  if (!normalizedItems.some((item) => item.href === "/platform/wave")) {
    const billingIndex = normalizedItems.findIndex(
      (item) => item.href === "/platform/billing",
    );
    const insertAt = billingIndex >= 0 ? billingIndex + 1 : normalizedItems.length;
    normalizedItems.splice(insertAt, 0, {
      href: "/platform/wave",
      label: "Wave Rollout",
    });
  }

  return (
    <nav className="space-y-2">
      {normalizedItems.map((item) => {
        const active = isActivePath(pathname, item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
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
  );
}

