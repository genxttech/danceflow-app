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

export default function SellWorkspaceNav({
  role,
  isPlatformAdmin = false,
}: {
  role: string | null | undefined;
  isPlatformAdmin?: boolean;
}) {
  const pathname = usePathname() || "/app/sell";
  const canSell =
    isPlatformAdmin ||
    canSellCommerce(role) ||
    canManagePackages(role) ||
    canManageMemberships(role) ||
    canTakePayments(role);
  const canManageExpenses =
    isPlatformAdmin ||
    isOrganizerWorkspaceRole(role) ||
    ["studio_owner", "studio_admin", "independent_instructor"].includes(
      role ?? "",
    );

  const items = [
    canSell
      ? { label: "Sell", href: "/app/sell", icon: ShoppingBag }
      : null,
    isPlatformAdmin || canManageCommerce(role)
      ? { label: "Catalog", href: "/app/catalog", icon: Boxes }
      : null,
    isPlatformAdmin || canViewCommerceOrders(role)
      ? { label: "Orders", href: "/app/orders", icon: ReceiptText }
      : null,
    isPlatformAdmin || canViewPayments(role)
      ? { label: "Payments", href: "/app/payments", icon: CreditCard }
      : null,
    isPlatformAdmin || canManagePackages(role)
      ? { label: "Packages", href: "/app/packages", icon: Package }
      : null,
    isPlatformAdmin || canManageMemberships(role)
      ? { label: "Memberships", href: "/app/memberships", icon: WalletCards }
      : null,
    canManageExpenses
      ? { label: "Expenses", href: "/app/expenses", icon: BadgeDollarSign }
      : null,
    isPlatformAdmin || canPreparePayroll(role)
      ? { label: "Instructor Pay", href: "/app/instructor-pay", icon: UsersRound }
      : null,
  ].filter(
    (item): item is { label: string; href: string; icon: typeof ShoppingBag } =>
      Boolean(item),
  );

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
