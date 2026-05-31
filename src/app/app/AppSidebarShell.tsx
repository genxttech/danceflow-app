"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import {
  LayoutDashboard,
  Users,
  UserRoundPlus,
  CalendarDays,
  GraduationCap,
  BookOpen,
  DoorOpen,
  Package,
  CreditCard,
  BarChart3,
  Settings,
  Menu,
  X,
  LogOut,
  Wallet,
  Bell,
  ClipboardCheck,
  ChevronsUpDown,
  Check,
  Building2,
  Ticket,
  Search,
  Megaphone,
} from "lucide-react";
import NotificationMenu from "@/components/ui/NotificationMenu";

type NavItem = {
  label: string;
  href: string;
  icon: string;
  badge?: number | null;
};

type NavSectionType = {
  title: string;
  items: NavItem[];
};

type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  client_id: string | null;
  appointment_id: string | null;
};

type WorkspaceItem = {
  studioId: string;
  studioRole: string;
  studioName: string;
  studioSlug: string | null;
  studioPublicName: string | null;
  isSelected: boolean;
};

function isActivePath(pathname: string, href: string) {
  if (href === "/app") {
    return pathname === "/app";
  }

  const eventOperationMatches: Record<string, RegExp[]> = {
    "/app/events": [
      /^\/app\/events$/,
      /^\/app\/events\/[^/]+$/,
      /^\/app\/events\/[^/]+\/edit$/,
      /^\/app\/events\/[^/]+\/private-lessons(?:\/.*)?$/,
    ],
    "/app/events/new": [/^\/app\/events\/new$/],
    "/app/events/tickets": [
      /^\/app\/events\/tickets$/,
      /^\/app\/events\/[^/]+\/tickets(?:\/.*)?$/,
    ],
    "/app/events/sell-tickets": [
      /^\/app\/events\/sell-tickets$/,
      /^\/app\/events\/[^/]+\/sell-tickets(?:\/.*)?$/,
    ],
    "/app/events/registrations": [
      /^\/app\/events\/registrations$/,
      /^\/app\/events\/[^/]+\/registrations(?:\/.*)?$/,
    ],
    "/app/events/checkin": [
      /^\/app\/events\/checkin$/,
      /^\/app\/events\/check-in$/,
      /^\/app\/events\/[^/]+\/checkin(?:\/.*)?$/,
      /^\/app\/events\/[^/]+\/check-in(?:\/.*)?$/,
    ],
  };

  const eventMatches = eventOperationMatches[href];
  if (eventMatches) {
    return eventMatches.some((pattern) => pattern.test(pathname));
  }

  const exactOnlyRoutes = new Set([
    "/app/clients/new",
    "/app/events/new",
    "/app/events/sell-tickets",
  ]);

  if (exactOnlyRoutes.has(href)) {
    return pathname === href;
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

function getIcon(icon: string) {
  if (icon === "dashboard") return LayoutDashboard;
  if (icon === "leads") return UserRoundPlus;
  if (icon === "clients") return Users;
  if (icon === "organizer_contacts") return Users;
  if (icon === "syllabus") return BookOpen;
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
  return LayoutDashboard;
}

function normalizeNavLabel(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  if (
    item.href === "/app/settings/billing" ||
    lower === "billing" ||
    lower === "billing & payouts" ||
    lower === "payment settings"
  ) {
    return "Billing & Payouts";
  }

  if (
    lower === "discovery" ||
    lower === "discover" ||
    lower === "public discovery"
  ) {
    return "Discovery Home";
  }

  if (
    lower === "find studios" ||
    lower === "studios near me" ||
    lower === "discover studios"
  ) {
    return "Find Studios";
  }

  if (
    lower === "find events" ||
    lower === "events near me" ||
    lower === "discover events"
  ) {
    return "Find Events";
  }

  if (
    lower === "tickets" ||
    lower === "event tickets" ||
    lower === "manage event tickets"
  ) {
    return "Manage Tickets";
  }

  if (
    lower === "registrations" ||
    lower === "event registrations" ||
    lower === "manage registrations"
  ) {
    return "Registrations";
  }

  if (
    lower === "check in" ||
    lower === "check-in" ||
    lower === "event check-in"
  ) {
    return "Check-In";
  }

  return item.label;
}

function isDiscoveryHomeItem(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  return (
    item.href === "/discover" ||
    item.href === "/app/discover" ||
    lower === "discovery home" ||
    lower === "public discovery" ||
    lower === "discovery"
  );
}

function isRedundantDiscoveryChild(item: NavItem) {
  const lower = item.label.trim().toLowerCase();

  return (
    item.href === "/discover/studios" ||
    item.href === "/discover/events" ||
    item.href === "/app/discover/studios" ||
    item.href === "/app/discover/events" ||
    lower === "find studios" ||
    lower === "find events"
  );
}

function removeRedundantDiscoveryLinks(sections: NavSectionType[]) {
  const hasDiscoveryHome = sections.some((section) =>
    section.items.some(isDiscoveryHomeItem),
  );

  if (!hasDiscoveryHome) {
    return sections;
  }

  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !isRedundantDiscoveryChild(item)),
    }))
    .filter((section) => section.items.length > 0);
}

function injectOrganizerContactsLink(
  sections: NavSectionType[],
): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasOrganizerContacts = flatItems.some(
    (item) => item.href === "/app/organizer-contacts",
  );

  if (hasOrganizerContacts) {
    return sections;
  }

  const hasOrganizerAccess = flatItems.some(
    (item) =>
      item.href === "/app/organizers" ||
      item.href.startsWith("/app/organizers/"),
  );

  if (!hasOrganizerAccess) {
    return sections;
  }

  const organizerContactsItem: NavItem = {
    label: "Organizer Contacts",
    href: "/app/organizer-contacts",
    icon: "organizer_contacts",
  };

  const organizerSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "organizers" ||
      title === "events" ||
      section.items.some((item) => item.href === "/app/organizers")
    );
  });

  if (organizerSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== organizerSectionIndex) {
        return section;
      }

      const organizersIndex = section.items.findIndex(
        (item) => item.href === "/app/organizers",
      );

      if (organizersIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, organizersIndex + 1),
            organizerContactsItem,
            ...section.items.slice(organizersIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, organizerContactsItem],
      };
    });
  }

  return [
    ...sections,
    {
      title: "Organizers",
      items: [organizerContactsItem],
    },
  ];
}

function injectSyllabusLink(sections: NavSectionType[]): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasSyllabus = flatItems.some((item) => item.href === "/app/syllabus");

  if (hasSyllabus) {
    return sections;
  }

  const syllabusItem: NavItem = {
    label: "Syllabus",
    href: "/app/syllabus",
    icon: "syllabus",
  };

  const peopleSectionIndex = sections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "people" ||
      title === "clients" ||
      title === "crm" ||
      section.items.some(
        (item) =>
          item.href === "/app/clients" ||
          item.href === "/app/leads" ||
          item.href === "/app/instructors",
      )
    );
  });

  if (peopleSectionIndex >= 0) {
    return sections.map((section, index) => {
      if (index !== peopleSectionIndex) {
        return section;
      }

      const clientsIndex = section.items.findIndex(
        (item) => item.href === "/app/clients",
      );

      if (clientsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, clientsIndex + 1),
            syllabusItem,
            ...section.items.slice(clientsIndex + 1),
          ],
        };
      }

      const instructorsIndex = section.items.findIndex(
        (item) => item.href === "/app/instructors",
      );

      if (instructorsIndex >= 0) {
        return {
          ...section,
          items: [
            ...section.items.slice(0, instructorsIndex + 1),
            syllabusItem,
            ...section.items.slice(instructorsIndex + 1),
          ],
        };
      }

      return {
        ...section,
        items: [...section.items, syllabusItem],
      };
    });
  }

  const dashboardIndex = sections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...sections.slice(0, dashboardIndex + 1),
      {
        title: "People",
        items: [syllabusItem],
      },
      ...sections.slice(dashboardIndex + 1),
    ];
  }

  return [
    {
      title: "People",
      items: [syllabusItem],
    },
    ...sections,
  ];
}

function injectEventWorkflowLinks(
  sections: NavSectionType[],
): NavSectionType[] {
  const flatItems = sections.flatMap((section) => section.items);
  const hasEventsAccess = flatItems.some((item) => item.href === "/app/events");

  if (!hasEventsAccess) {
    return sections;
  }

  const eventSection: NavSectionType = {
    title: "Events",
    items: [
      {
        label: "Events",
        href: "/app/events",
        icon: "events",
      },
      {
        label: "Create Event",
        href: "/app/events/new",
        icon: "events",
      },
      {
        label: "Manage Tickets",
        href: "/app/events/tickets",
        icon: "tickets",
      },
      {
        label: "Sell Tickets",
        href: "/app/events/sell-tickets",
        icon: "tickets",
      },
      {
        label: "Registrations",
        href: "/app/events/registrations",
        icon: "registrations",
      },
      {
        label: "Check-In",
        href: "/app/events/checkin",
        icon: "checkin",
      },
    ],
  };

  const cleanedSections = sections
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          item.href !== "/app/events" &&
          item.href !== "/app/events/new" &&
          item.href !== "/app/events/tickets" &&
          item.href !== "/app/events/sell-tickets" &&
          item.href !== "/app/events/registrations" &&
          item.href !== "/app/events/checkin",
      ),
    }))
    .filter((section) => section.items.length > 0);

  const salesAndPaymentsIndex = cleanedSections.findIndex((section) => {
    const title = section.title.trim().toLowerCase();

    return (
      title === "sales & payments" ||
      title === "sales and payments" ||
      title === "payments" ||
      section.items.some(
        (item) =>
          item.href.startsWith("/app/payments") ||
          item.href.startsWith("/app/packages") ||
          item.href.startsWith("/app/memberships"),
      )
    );
  });

  if (salesAndPaymentsIndex >= 0) {
    return [
      ...cleanedSections.slice(0, salesAndPaymentsIndex + 1),
      eventSection,
      ...cleanedSections.slice(salesAndPaymentsIndex + 1),
    ];
  }

  const dashboardIndex = cleanedSections.findIndex((section) =>
    section.items.some((item) => item.href === "/app"),
  );

  if (dashboardIndex >= 0) {
    return [
      ...cleanedSections.slice(0, dashboardIndex + 1),
      eventSection,
      ...cleanedSections.slice(dashboardIndex + 1),
    ];
  }

  return [eventSection, ...cleanedSections];
}

function normalizeSections(input: unknown): NavSectionType[] {
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((section) => {
      const rawSection = section as Partial<NavSectionType> | null | undefined;
      const title =
        typeof rawSection?.title === "string" && rawSection.title.trim()
          ? rawSection.title
          : "Section";

      const items = Array.isArray(rawSection?.items)
        ? rawSection.items
            .filter((item) => item && typeof item === "object")
            .map((item) => {
              const rawItem = item as Partial<NavItem>;

              const normalizedItem = {
                label:
                  typeof rawItem.label === "string" && rawItem.label.trim()
                    ? rawItem.label
                    : "Item",
                href:
                  typeof rawItem.href === "string" && rawItem.href.trim()
                    ? rawItem.href
                    : "/app",
                icon:
                  typeof rawItem.icon === "string" && rawItem.icon.trim()
                    ? rawItem.icon
                    : "dashboard",
                badge:
                  typeof rawItem.badge === "number" ? rawItem.badge : undefined,
              } satisfies NavItem;

              return {
                ...normalizedItem,
                label: normalizeNavLabel(normalizedItem),
              } satisfies NavItem;
            })
        : [];

      return {
        title,
        items,
      } satisfies NavSectionType;
    })
    .filter((section) => section.items.length > 0);

  const withoutDiscoveryDuplicates = removeRedundantDiscoveryLinks(normalized);
  const withEventWorkflowLinks = injectEventWorkflowLinks(
    withoutDiscoveryDuplicates,
  );
  const withOrganizerContactsLink = injectOrganizerContactsLink(
    withEventWorkflowLinks,
  );

  return injectSyllabusLink(withOrganizerContactsLink);
}

function prettyRole(role: string) {
  return role.replaceAll("_", " ");
}

function WorkspaceSwitcher({
  workspaces,
  currentStudioId,
  switchWorkspaceAction,
  mobile = false,
}: {
  workspaces: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
  mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!workspaces.length) return null;

  const currentWorkspace =
    workspaces.find((workspace) => workspace.studioId === currentStudioId) ??
    workspaces.find((workspace) => workspace.isSelected) ??
    workspaces[0];

  const wrapperClass = mobile
    ? "rounded-2xl border border-[var(--brand-border)] bg-white p-4"
    : "rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur";

  const labelClass = mobile ? "text-[var(--brand-muted)]" : "text-white/50";
  const titleClass = mobile ? "text-[var(--brand-text)]" : "text-white";
  const subtitleClass = mobile
    ? "text-[var(--brand-accent-dark)]"
    : "text-[#FFDCA9]";
  const buttonClass = mobile
    ? "border-[var(--brand-border)] bg-white text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
    : "border-white/10 bg-white/8 text-white hover:bg-white/12";

  const dropdownClass = mobile
    ? "border-[var(--brand-border)] bg-white shadow-xl"
    : "border-white/10 bg-[#111b45] shadow-2xl";

  const itemClass = mobile
    ? "hover:bg-[var(--brand-primary-soft)] text-[var(--brand-text)]"
    : "hover:bg-white/8 text-white";

  const roleClass = mobile
    ? "text-[var(--brand-accent-dark)]"
    : "text-[#FFDCA9]";

  return (
    <div className={wrapperClass}>
      <p
        className={`text-xs font-semibold uppercase tracking-[0.18em] ${labelClass}`}
      >
        Workspace
      </p>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`mt-3 flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${buttonClass}`}
      >
        <div className="min-w-0">
          <p className={`truncate font-medium ${titleClass}`}>
            {currentWorkspace.studioPublicName?.trim() ||
              currentWorkspace.studioName}
          </p>
          <p className={`mt-1 truncate text-xs ${subtitleClass}`}>
            {prettyRole(currentWorkspace.studioRole)}
          </p>
        </div>

        <ChevronsUpDown className="h-4 w-4 shrink-0" />
      </button>

      {open ? (
        <div
          className={`mt-3 overflow-hidden rounded-2xl border ${dropdownClass}`}
        >
          <div className="max-h-72 overflow-y-auto p-2">
            {workspaces.map((workspace) => {
              const active = workspace.studioId === currentWorkspace.studioId;

              return (
                <form
                  key={workspace.studioId}
                  action={async (formData) => {
                    await switchWorkspaceAction(formData);
                    setOpen(false);
                  }}
                >
                  <input
                    type="hidden"
                    name="studioId"
                    value={workspace.studioId}
                  />
                  <button
                    type="submit"
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition ${itemClass}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {workspace.studioPublicName?.trim() ||
                          workspace.studioName}
                      </p>
                      <p className={`mt-1 truncate text-xs ${roleClass}`}>
                        {prettyRole(workspace.studioRole)}
                      </p>
                    </div>

                    {active ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : (
                      <Building2 className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                  </button>
                </form>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DesktopNavSection({
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

function MobileNavSection({
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

export default function AppSidebarShell({
  pathname,
  studioName,
  userName,
  userEmail,
  role,
  sections,
  unreadNotificationsCount = 0,
  recentNotifications = [],
  workspaces = [],
  currentStudioId,
  switchWorkspaceAction,
  children,
}: {
  pathname?: string;
  studioName?: string;
  userName?: string;
  userEmail?: string;
  role?: string;
  sections?: unknown;
  unreadNotificationsCount?: number;
  recentNotifications?: NotificationItem[];
  workspaces?: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPathname = usePathname();

  const safePathname = currentPathname || pathname || "/app";
  const safeStudioName = studioName || "Workspace";
  const safeUserName = userName || "Unknown User";
  const safeUserEmail = userEmail || "";
  const safeRole = role || "";
  const safeNotifications = Array.isArray(recentNotifications)
    ? recentNotifications
    : [];

  const normalizedSections = useMemo(
    () => normalizeSections(sections),
    [sections],
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="border-b border-[var(--brand-border)] bg-white px-4 py-3 lg:hidden">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
              {safeStudioName}
            </p>
            <p className="truncate text-xs text-[var(--brand-muted)]">
              {safeUserName}
            </p>
          </div>

          <NotificationMenu
            unreadCount={unreadNotificationsCount}
            notifications={safeNotifications}
          />
        </div>
      </div>

      <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-screen">
        <div className="brand-sidebar flex h-full flex-col border-r border-white/10">
          <div className="border-b border-white/10 px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <div className="relative h-16 w-16 overflow-hidden rounded-2xl bg-white/8 p-1 ring-1 ring-white/10">
                    <Image
                      src="/brand/danceflow-logo.png"
                      alt="DanceFlow logo"
                      fill
                      sizes="64px"
                      className="object-contain"
                    />
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
                      Workspace
                    </p>
                    <h1 className="mt-1 truncate text-2xl font-semibold text-white">
                      {safeStudioName}
                    </h1>
                    <p className="mt-1 text-sm text-[#FFDCA9]">DanceFlow</p>
                  </div>
                </div>
              </div>

              <NotificationMenu
                unreadCount={unreadNotificationsCount}
                notifications={safeNotifications}
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-5">
            <div className="space-y-6">
              {workspaces.length > 1 ? (
                <WorkspaceSwitcher
                  workspaces={workspaces}
                  currentStudioId={currentStudioId}
                  switchWorkspaceAction={switchWorkspaceAction}
                />
              ) : null}

              {normalizedSections.map((section) => (
                <DesktopNavSection
                  key={section.title}
                  title={section.title}
                  items={section.items}
                  pathname={safePathname}
                />
              ))}
            </div>

            <div className="mt-10 rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
                Signed in as
              </p>
              <p className="mt-2 font-medium text-white">{safeUserName}</p>
              <p className="text-sm text-white/75">{safeUserEmail}</p>
              <p className="mt-2 text-xs text-[#FFDCA9]">{safeRole}</p>
            </div>
          </div>

          <div className="border-t border-white/10 px-5 py-4">
            <form action="/auth/logout" method="post">
              <button className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 px-4 py-2 text-white hover:bg-white/12">
                <LogOut className="h-4 w-4" />
                <span>Log Out</span>
              </button>
            </form>
          </div>
        </div>
      </aside>

      <main className="min-w-0">{children}</main>

      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 bg-slate-900/45"
            aria-label="Close navigation backdrop"
          />

          <div className="absolute inset-y-0 left-0 w-full max-w-sm bg-[var(--brand-surface)] shadow-xl">
            <div className="flex h-full flex-col">
              <div className="border-b border-[var(--brand-border)] bg-white px-5 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-4">
                      <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-white p-2 shadow-sm">
                        <Image
                          src="/brand/danceflow-logo.png"
                          alt="DanceFlow logo"
                          fill
                          sizes="80px"
                          className="object-contain p-1"
                        />
                      </div>

                      <div className="min-w-0">
                        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
                          Workspace
                        </p>
                        <h2 className="mt-1 truncate text-2xl font-semibold text-[var(--brand-text)]">
                          {safeStudioName}
                        </h2>
                        <p className="mt-1 text-base font-medium text-[var(--brand-accent-dark)]">
                          DanceFlow
                        </p>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => setMobileOpen(false)}
                    className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                    aria-label="Close navigation"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-5">
                <div className="space-y-6">
                  {workspaces.length > 1 ? (
                    <WorkspaceSwitcher
                      workspaces={workspaces}
                      currentStudioId={currentStudioId}
                      switchWorkspaceAction={switchWorkspaceAction}
                      mobile
                    />
                  ) : null}

                  {normalizedSections.map((section) => (
                    <MobileNavSection
                      key={section.title}
                      title={section.title}
                      items={section.items}
                      pathname={safePathname}
                      onNavigate={() => setMobileOpen(false)}
                    />
                  ))}
                </div>

                <div className="mt-8 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
                    Signed in as
                  </p>
                  <p className="mt-2 font-medium text-[var(--brand-text)]">
                    {safeUserName}
                  </p>
                  <p className="text-sm text-[var(--brand-muted)]">
                    {safeUserEmail}
                  </p>
                  <p className="mt-2 text-xs text-[var(--brand-accent-dark)]">
                    {safeRole}
                  </p>
                </div>
              </div>

              <div className="border-t border-[var(--brand-border)] bg-white px-5 py-4">
                <form action="/auth/logout" method="post">
                  <button className="brand-button-primary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2">
                    <LogOut className="h-4 w-4" />
                    <span>Log Out</span>
                  </button>
                </form>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

