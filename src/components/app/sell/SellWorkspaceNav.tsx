"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BadgeDollarSign,
  Boxes,
  CreditCard,
  Package,
  ReceiptText,
  ShoppingBag,
  UsersRound,
  WalletCards,
} from "lucide-react";
import {
  canManageCommerce,
  canManageMemberships,
  canManagePackages,
  canPreparePayroll,
  canSellCommerce,
  canTakePayments,
  canViewCommerceOrders,
  canViewPayments,
  isOrganizerWorkspaceRole,
} from "@/lib/auth/permissions";

function activePath(pathname: string, href: string) {
  if (href === "/app/sell") return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

// FC-1B4: pulled out as a pure function (icons omitted) so the item list --
// and specifically the FC-1B1 expenses-lockdown contradiction this slice
// fixes -- can be unit-tested without rendering the component.
//
// Scope note: this nav renders only on today's host-studio staff routes
// (/app/sell, /app/catalog, /app/orders, /app/payments, /app/packages,
// /app/memberships, /app/expenses, /app/instructor-pay), so removing
// independent_instructor from canManageExpenses below is correct for the
// CURRENT host-relationship role (it matches the FC-1B1 lockdown on
// /app/expenses itself). It is NOT a statement that this role can never
// manage expenses -- the planned Independent Instructor Business Workspace
// (a studio-owner-equivalent persona, see FC-1B4 revision) may reuse this
// same component/route set once that persona exists as its own role or
// capability, at which point this exclusion will need revisiting. Do not
// read this file as evidence that independent instructors are permanently
// commerce-restricted.
export function getSellWorkspaceNavItems(
  role: string | null | undefined,
  isPlatformAdmin = false,
): { label: string; href: string }[] {
  const canSell =
    isPlatformAdmin ||
    canSellCommerce(role) ||
    canManagePackages(role) ||
    canManageMemberships(role) ||
    canTakePayments(role);
  const canManageExpenses =
    isPlatformAdmin ||
    isOrganizerWorkspaceRole(role) ||
    ["studio_owner", "studio_admin"].includes(role ?? "");

  return [
    canSell ? { label: "Sell", href: "/app/sell" } : null,
    isPlatformAdmin || canManageCommerce(role)
      ? { label: "Catalog", href: "/app/catalog" }
      : null,
    isPlatformAdmin || canViewCommerceOrders(role)
      ? { label: "Orders", href: "/app/orders" }
      : null,
    isPlatformAdmin || canViewPayments(role)
      ? { label: "Payments", href: "/app/payments" }
      : null,
    isPlatformAdmin || canManagePackages(role)
      ? { label: "Packages", href: "/app/packages" }
      : null,
    isPlatformAdmin || canManageMemberships(role)
      ? { label: "Memberships", href: "/app/memberships" }
      : null,
    canManageExpenses ? { label: "Expenses", href: "/app/expenses" } : null,
    isPlatformAdmin || canPreparePayroll(role)
      ? { label: "Instructor Pay", href: "/app/instructor-pay" }
      : null,
  ].filter((item): item is { label: string; href: string } => Boolean(item));
}

const ICONS_BY_HREF: Record<string, typeof ShoppingBag> = {
  "/app/sell": ShoppingBag,
  "/app/catalog": Boxes,
  "/app/orders": ReceiptText,
  "/app/payments": CreditCard,
  "/app/packages": Package,
  "/app/memberships": WalletCards,
  "/app/expenses": BadgeDollarSign,
  "/app/instructor-pay": UsersRound,
};

export default function SellWorkspaceNav({
  role,
  isPlatformAdmin = false,
}: {
  role: string | null | undefined;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname() || "/app/sell";
  const items = getSellWorkspaceNavItems(role, isPlatformAdmin).map((item) => ({
    ...item,
    icon: ICONS_BY_HREF[item.href],
  }));

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="Sell workspace"
      className="overflow-x-auto border-b border-[var(--brand-border)] bg-white"
    >
      <div className="flex min-w-max gap-1 px-4 py-3 sm:px-6 lg:px-8">
        {items.map((item) => {
          const Icon = item.icon;
          const active = activePath(pathname, item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={[
                "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition",
                active
                  ? "bg-[var(--brand-primary)] text-white shadow-sm"
                  : "text-[var(--brand-muted)] hover:bg-[var(--brand-primary-soft)] hover:text-[var(--brand-primary)]",
              ].join(" ")}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
