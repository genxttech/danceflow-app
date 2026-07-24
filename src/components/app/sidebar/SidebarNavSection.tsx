"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Bell,
  BookOpen,
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  CreditCard,
  DoorOpen,
  GraduationCap,
  LayoutDashboard,
  Megaphone,
  Package,
  ShoppingBag,
  Store,
  ListOrdered,
  Search,
  Settings,
  Sparkles,
  Ticket,
  UserRoundPlus,
  Users,
  Wallet,
} from "lucide-react";
import type { NavItem } from "./types";
import { getActiveNavHref } from "./navUtils";

function getIcon(icon: string) {
  if (icon === "dashboard") return LayoutDashboard;
  if (icon === "aria") return Sparkles;
  if (icon === "leads") return UserRoundPlus;
  if (icon === "clients") return Users;
  if (icon === "organizer_contacts") return Users;
  if (icon === "organizer_campaigns") return Megaphone;
  if (icon === "syllabus") return BookOpen;
  if (icon === "documents") return BookOpen;
  if (icon === "schedule") return CalendarDays;
  if (icon === "events") return CalendarDays;
  if (icon === "tickets") return Ticket;
  if (icon === "registrations") return ClipboardCheck;
  if (icon === "checkin") return ClipboardCheck;
  if (icon === "instructors") return GraduationCap;
  if (icon === "rooms") return DoorOpen;
  if (icon === "packages") return Package;
  if (icon === "sell") return ShoppingBag;
  if (icon === "catalog") return Store;
  if (icon === "orders") return ListOrdered;
  if (icon === "memberships") return CreditCard;
  if (icon === "balances") return Wallet;
  if (icon === "payments") return CreditCard;
  if (icon === "reports") return BarChart3;
  if (icon === "settings") return Settings;
  if (icon === "notifications") return Bell;
  if (icon === "discovery") return Search;
  if (icon === "now_hiring") return BriefcaseBusiness;
  if (icon === "marketing") return Megaphone;
  if (icon === "automations") return Sparkles;
  return LayoutDashboard;
}

function useCollapsibleSection(args: {
  title: string;
  items: NavItem[];
  pathname: string;
}) {
  const { title, items, pathname } = args;
  const activeHref = useMemo(
    () => getActiveNavHref(pathname, items),
    [items, pathname],
  );
  const [open, setOpen] = useState(Boolean(activeHref) || title === "Today");

  useEffect(() => {
    if (activeHref) setOpen(true);
  }, [activeHref]);

  return { activeHref, open, setOpen };
}

export function DesktopNavSection({
  title,
  items,
  pathname,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
}) {
  const { activeHref, open, setOpen } = useCollapsibleSection({
    title,
    items,
    pathname,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-[0.18em] text-white/50 transition hover:bg-white/6 hover:text-white/80"
      >
        <span>{title}</span>
        {open ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
      </button>

      {open ? (
        <div className="mt-2 space-y-1">
          {items.map((item) => {
            const active = activeHref === item.href;
            const Icon = getIcon(item.icon);

            return (
              <Link
                key={`${title}-${item.label}-${item.href}`}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center justify-between rounded-xl px-3 py-2 text-sm transition",
                  active ? "brand-nav-active" : "brand-nav-idle",
                ].join(" ")}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </span>

                {typeof item.badge === "number" && item.badge > 0 ? (
                  <span
                    className={[
                      "inline-flex min-w-[1.5rem] shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
                      active
                        ? "bg-white/15 text-white"
                        : "bg-[rgba(216,138,45,0.18)] text-[#FFDCA9]",
                    ].join(" ")}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function MobileNavSection({
  title,
  items,
  pathname,
  onNavigate,
}: {
  title: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: () => void;
}) {
  const { activeHref, open, setOpen } = useCollapsibleSection({
    title,
    items,
    pathname,
  });

  return (
    <div className="rounded-2xl border border-[var(--brand-border)] bg-white/70 p-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-xl px-2 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]/75 hover:bg-[var(--brand-primary-soft)]"
      >
        <span>{title}</span>
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </button>

      {open ? (
        <div className="mt-1 space-y-1">
          {items.map((item) => {
            const active = activeHref === item.href;
            const Icon = getIcon(item.icon);

            return (
              <Link
                key={`${title}-${item.label}-${item.href}`}
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={[
                  "flex items-center justify-between rounded-xl px-3 py-3 text-sm transition",
                  active
                    ? "bg-[var(--brand-primary)] text-white"
                    : "text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]",
                ].join(" ")}
              >
                <span className="flex min-w-0 items-center gap-3">
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="truncate text-[15px]">{item.label}</span>
                </span>

                {typeof item.badge === "number" && item.badge > 0 ? (
                  <span
                    className={[
                      "inline-flex min-w-[1.6rem] shrink-0 items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
                      active
                        ? "bg-white/15 text-white"
                        : "bg-[var(--brand-accent-soft)] text-[var(--brand-accent-dark)]",
                    ].join(" ")}
                  >
                    {item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
