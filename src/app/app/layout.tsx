import Link from "next/link";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform";
import {
  getAccessibleStudios,
  getCurrentStudioContext,
  getCurrentWorkspaceAccessState,
  isOrganizerRole,
} from "@/lib/auth/studio";
import { clearStudioContextAction } from "@/app/platform/actions";
import AppSidebarShell from "./AppSidebarShell";

const APP_SELECTED_STUDIO_COOKIE = "app_selected_studio_id";

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

type ProfileRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
};

type StudioRow = {
  id: string;
  name: string | null;
  slug: string | null;
};

type NavItem = {
  label: string;
  href: string;
  icon: string;
  badge?: number;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

function buildDisplayName(profile: ProfileRow | null, fallbackEmail: string | null) {
  const fullName = profile?.full_name?.trim();
  if (fullName) return fullName;

  const combined = [profile?.first_name ?? "", profile?.last_name ?? ""]
    .join(" ")
    .trim();

  if (combined) return combined;

  return fallbackEmail ?? "Unknown User";
}

function formatRoleLabel(role: string | null | undefined) {
  if (!role) return "";

  if (role === "studio_admin") return "Studio Manager";

  return role.replaceAll("_", " ").trim();
}

function getBillingLockMessage(status: string | null | undefined) {
  switch (status) {
    case "canceled":
      return "This workspace is canceled. Update billing to restore access.";
    case "unpaid":
      return "This workspace is unpaid. Resolve billing to restore access.";
    case "incomplete":
    case "incomplete_expired":
      return "This workspace setup is incomplete. Complete billing to continue.";
    case "past_due":
      return "This workspace is past due. Resolve billing to regain access.";
    case "inactive":
      return "This workspace is inactive. Billing must be resolved before access is restored.";
    case "suspended":
      return "This workspace is suspended. Billing must be resolved before access is restored.";
    default:
      return "This workspace is paused until billing is resolved.";
  }
}

function compactSections(sections: NavSection[]) {
  return sections.filter((section) => section.items.length > 0);
}

function buildStudioSections(params: {
  unreadNotificationsCount: number;
  leadsBadgeCount: number;
  role: string | null | undefined;
  isPlatformAdmin: boolean;
  portalHref: string | null;
}) {
  const { unreadNotificationsCount, leadsBadgeCount, role, isPlatformAdmin, portalHref } = params;

  const isOwner = isPlatformAdmin || role === "studio_owner";
  const isStudioAdmin = isOwner || role === "studio_admin";
  const isFrontDesk = isStudioAdmin || role === "front_desk";
  const isInstructor = role === "instructor";
  const isIndependentInstructor = role === "independent_instructor";
  const isAnyInstructor = isInstructor || isIndependentInstructor;

  return compactSections([
    {
      title: "Daily Operations",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        { label: "Schedule", href: "/app/schedule", icon: "schedule" },
        ...(isIndependentInstructor && portalHref
          ? [{ label: "My Portal", href: portalHref, icon: "clients" as const }]
          : []),
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [{ label: "Clients", href: "/app/clients", icon: "clients" as const }]
          : []),
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [
              {
                label: "Leads",
                href: "/app/leads",
                icon: "leads" as const,
                badge: leadsBadgeCount,
              },
            ]
          : []),
            
        {
          label: "Notifications",
          href: "/app/notifications",
          icon: "notifications",
          badge: unreadNotificationsCount,
        },
      ],
    },
    {
      title: "Programs & Staff",
      items: [
        ...(isFrontDesk || isStudioAdmin || isOwner || isAnyInstructor
          ? [{ label: "Events", href: "/app/events", icon: "events" as const }]
          : []),
        ...(isStudioAdmin || isOwner
          ? [{ label: "Instructors", href: "/app/instructors", icon: "instructors" as const }]
          : []),
        ...(isStudioAdmin || isOwner
          ? [{ label: "Rooms", href: "/app/rooms", icon: "rooms" as const }]
          : []),
      ],
    },
    {
      title: "Sales & Billing",
      items: [
        ...(isFrontDesk || isStudioAdmin || isOwner || isIndependentInstructor
          ? [{ label: "Payments", href: "/app/payments", icon: "payments" as const }]
          : []),
        ...(isFrontDesk || isStudioAdmin || isOwner
          ? [
                            {
                label: "Sell Packages",
                href: "/app/packages/sell",
                icon: "packages" as const,
              },
              {
                label: "Sell Memberships",
                href: "/app/memberships/sell",
                icon: "memberships" as const,
              },
              {
                label: "Client Balances",
                href: "/app/packages/client-balances",
                icon: "balances" as const,
              },
            ]
          : []),
        ...(isStudioAdmin || isOwner
          ? [{ label: "Package Templates", href: "/app/packages", icon: "packages" as const }]
          : []),
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Membership Plans",
                href: "/app/memberships",
                icon: "memberships" as const,
              },
            ]
          : []),
        ...(isStudioAdmin || isOwner
          ? [{ label: "Reports", href: "/app/reports", icon: "reports" as const }]
          : []),
      ],
    },
    {
      title: "Public Growth",
      items: [
        ...(isStudioAdmin || isOwner
          ? [
              {
                label: "Public Profile",
                href: "/app/settings/public-profile",
                icon: "settings" as const,
              },
            ]
          : []),
      ],
    },
        {
      title: "Support",
      items: [
        {
          label: "Help",
          href: "/app/help",
          icon: "settings",
        },
        {
          label: "Knowledgebase",
          href: "/knowledgebase",
          icon: "settings",
        },
      ],
    },
    {
      title: "Admin",
      items: [
        ...(isStudioAdmin || isOwner
          ? [{ label: "Settings", href: "/app/settings", icon: "settings" as const }]
          : []),
        ...(isOwner
          ? [
              {
                label: "Team & Permissions",
                href: "/app/settings/team",
                icon: "settings" as const,
              },
            ]
          : []),
        ...(isOwner
          ? [
              {
                label: "Billing & Payouts",
                href: "/app/settings/billing",
                icon: "payments" as const,
              },
            ]
          : []),
      ],
    },
  ]);
}

function buildOrganizerSections(params: {
  unreadNotificationsCount: number;
  role: string | null | undefined;
  isPlatformAdmin: boolean;
}) {
  const { unreadNotificationsCount, role, isPlatformAdmin } = params;

  const isOwner = isPlatformAdmin || role === "organizer_owner";
  const isOrganizerAdmin = isOwner || role === "organizer_admin";

  return compactSections([
    {
      title: "Organizer Operations",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        ...(isOrganizerAdmin
          ? [{ label: "Events", href: "/app/events", icon: "events" as const }]
          : []),
        ...(isOrganizerAdmin
          ? [
              {
                label: "Registrations",
                href: "/app/events/registrations",
                icon: "clients" as const,
              },
            ]
          : []),
        ...(isOrganizerAdmin
          ? [{ label: "Check-In", href: "/app/events/checkin", icon: "checkin" as const }]
          : []),
        ...(isOrganizerAdmin
          ? [{ label: "Organizer Profile", href: "/app/organizers", icon: "settings" as const }]
          : []),
                
        {
          label: "Notifications",
          href: "/app/notifications",
          icon: "notifications",
          badge: unreadNotificationsCount,
        },
      ],
    },
    {
      title: "Revenue",
      items: [
        ...(isOwner
          ? [
              {
                label: "Billing & Payouts",
                href: "/app/settings/billing",
                icon: "payments" as const,
              },
            ]
          : []),
        ...(isOrganizerAdmin
          ? [{ label: "Payment History", href: "/app/payments", icon: "payments" as const }]
          : []),
        ...(isOrganizerAdmin
          ? [{ label: "Reports", href: "/app/reports", icon: "reports" as const }]
          : []),
      ],
    },
        {
      title: "Support",
      items: [
        {
          label: "Help",
          href: "/app/help",
          icon: "settings",
        },
        {
          label: "Knowledgebase",
          href: "/knowledgebase",
          icon: "settings",
        },
      ],
    },
    {
      title: "Admin",
      items: [
        ...(isOrganizerAdmin
          ? [{ label: "Settings", href: "/app/settings", icon: "settings" as const }]
          : []),
        ...(isOwner
          ? [
              {
                label: "Team & Permissions",
                href: "/app/settings/team",
                icon: "settings" as const,
              },
            ]
          : []),
      ],
    },
  ]);
}

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const headerStore = await headers();
  const pathname = headerStore.get("x-pathname") ?? "/app";

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const accessState = await getCurrentWorkspaceAccessState();
  const billingPath = "/app/settings/billing";
  const isBillingRoute = pathname.startsWith(billingPath);

  if (!context.isPlatformAdmin && accessState.blocked && !isBillingRoute) {
    redirect(`${billingPath}?reason=access_paused`);
  }

  async function switchWorkspaceAction(formData: FormData) {
    "use server";

    const studioId = String(formData.get("studioId") ?? "").trim();
    if (!studioId) return;

    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      redirect("/login");
    }

    const { data: allowedRole } = await supabase
      .from("user_studio_roles")
      .select("studio_id")
      .eq("user_id", user.id)
      .eq("studio_id", studioId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();

    if (!allowedRole) {
      return;
    }

    const cookieStore = await cookies();
    cookieStore.set(APP_SELECTED_STUDIO_COOKIE, studioId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });

    redirect("/app");
  }

  const [
    { data: studio },
    { data: profile },
    { data: notifications },
    { count: openLeadCount },
    accessibleStudios,
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, slug")
      .eq("id", context.studioId)
      .maybeSingle<StudioRow>(),

    supabase
      .from("profiles")
      .select("id, first_name, last_name, full_name, email")
      .eq("id", user.id)
      .maybeSingle<ProfileRow>(),

    supabase
      .from("notifications")
      .select(
        "id, type, title, body, read_at, created_at, client_id, appointment_id"
      )
      .eq("studio_id", context.studioId)
      .order("created_at", { ascending: false })
      .limit(8),

    supabase
      .from("clients")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", context.studioId)
      .eq("status", "lead"),

    getAccessibleStudios(),
  ]);

  const safeNotifications = ((notifications ?? []) as NotificationItem[]) || [];
  const unreadNotificationsCount = safeNotifications.filter(
    (item) => !item.read_at
  ).length;
  const leadsBadgeCount = openLeadCount ?? 0;

  const studioName = studio?.name ?? "Workspace";
  const portalHref = studio?.slug ? `/portal/${studio.slug}` : null;
  const userName = buildDisplayName(profile ?? null, user.email ?? null);
  const userEmail = profile?.email ?? user.email ?? "";
  const roleLabel = context.isPlatformAdmin
    ? "Platform Admin"
    : formatRoleLabel(context.studioRole);

  const organizerWorkspace = isOrganizerRole(context.studioRole);

  const sections = organizerWorkspace
    ? buildOrganizerSections({
        unreadNotificationsCount,
        role: context.studioRole,
        isPlatformAdmin: context.isPlatformAdmin,
      })
    : buildStudioSections({
        unreadNotificationsCount,
        leadsBadgeCount,
        role: context.studioRole,
        isPlatformAdmin: context.isPlatformAdmin,
        portalHref,
      });

  let studioBanner: React.ReactNode = null;

  if (await isPlatformAdmin()) {
    studioBanner = (
      <div className="border-b border-amber-200 bg-amber-50">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Viewing workspace as platform admin
            </p>
            <p className="text-sm text-amber-800">
              {studioName} • You are in temporary workspace context.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/platform"
              className="rounded-xl border border-amber-300 px-3 py-2 text-sm text-amber-900 hover:bg-amber-100"
            >
              Back to Platform
            </Link>

            <form action={clearStudioContextAction}>
              <button
                type="submit"
                className="rounded-xl bg-amber-900 px-3 py-2 text-sm text-white hover:bg-amber-800"
              >
                Exit Workspace Context
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  if (!context.isPlatformAdmin && accessState.blocked && isBillingRoute) {
    return (
      <div className="min-h-screen bg-slate-50">
        {studioBanner}

        <div className="border-b border-rose-200 bg-rose-50">
          <div className="mx-auto max-w-7xl px-6 py-4">
            <p className="text-sm font-semibold text-rose-900">
              Workspace access paused
            </p>
            <p className="mt-1 text-sm text-rose-800">
              {getBillingLockMessage(accessState.status)}
            </p>
          </div>
        </div>

        <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {studioBanner}

      <AppSidebarShell
        pathname={pathname}
        studioName={studioName}
        userName={userName}
        userEmail={userEmail}
        role={roleLabel}
        sections={sections}
        unreadNotificationsCount={unreadNotificationsCount}
        recentNotifications={safeNotifications}
        workspaces={accessibleStudios}
        currentStudioId={context.studioId}
        switchWorkspaceAction={switchWorkspaceAction}
      >
        {children}
      </AppSidebarShell>
    </div>
  );
}
