"use client";

import Link from "next/link";
import {
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  CreditCard,
  DoorOpen,
  GraduationCap,
  LayoutDashboard,
  Megaphone,
  Package,
  Search,
  Settings,
  Sparkles,
  Ticket,
  UserRoundPlus,
  Users,
  Wallet,
} from "lucide-react";
import type { NavItem } from "./types";
import { isActivePath } from "./navUtils";

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
  if (icon === "memberships") return CreditCard;
  if (icon === "balances") return Wallet;
  if (icon === "payments") return CreditCard;
  if (icon === "reports") return BarChart3;
  if (icon === "settings") return Settings;
  if (icon === "notifications") return Bell;
  if (icon === "discovery") return Search;
  if (icon === "marketing") return Megaphone;
  if (icon === "automations") return Sparkles;
  return LayoutDashboard;
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
  return (
    <div>
      <p className="px-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
        {title}
      </p>

      <div className="mt-3 space-y-1">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = getIcon(item.icon);

          return (
            <Link
              key={`${title}-${item.label}-${item.href}`}
              href={item.href}
              className={[
                "flex items-center justify-between rounded-xl px-3 py-2 text-sm transition",
                active ? "brand-nav-active" : "brand-nav-idle",
              ].join(" ")}
            >
              <span className="flex items-center gap-3">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </span>

              {typeof item.badge === "number" && item.badge > 0 ? (
                <span
                  className={[
                    "inline-flex min-w-[1.5rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
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
  return (
    <div>
      <p className="px-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]/70">
        {title}
      </p>

      <div className="mt-2 space-y-1">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = getIcon(item.icon);

          return (
            <Link
              key={`${title}-${item.label}-${item.href}`}
              href={item.href}
              onClick={onNavigate}
              className={[
                "flex items-center justify-between rounded-xl px-3 py-3 text-sm transition",
                active
                  ? "bg-[var(--brand-primary)] text-white"
                  : "text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]",
              ].join(" ")}
            >
              <span className="flex items-center gap-3">
                <Icon className="h-5 w-5 shrink-0" />
                <span className="text-[15px]">{item.label}</span>
              </span>

              {typeof item.badge === "number" && item.badge > 0 ? (
                <span
                  className={[
                    "inline-flex min-w-[1.6rem] items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium",
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
    </div>
  );
}
