import Link from "next/link";
import { redirect } from "next/navigation";
import { headers, cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { getCurrentStudioContext } from "@/lib/auth/studio";
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

type WorkspaceItem = {
  studioId: string;
  studioRole: string;
  studioName: string;
  studioSlug: string | null;
  studioPublicName: string | null;
  isSelected: boolean;
};

type RoleRow = {
  studio_id: string;
  role: string;
};

type StudioRow = {
  id: string;
  name: string;
  slug: string | null;
  public_name: string | null;
};

type ProfileRow = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  email: string | null;
};

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events")
  );
}

function formatRoleLabel(role: string | null | undefined) {
  return (role ?? "").replaceAll("_", " ").trim();
}

function buildDisplayName(params: {
  profile: ProfileRow | null;
  fallbackEmail: string | null | undefined;
}) {
  const { profile, fallbackEmail } = params;

  const fullName = profile?.full_name?.trim();
  if (fullName) return fullName;

  const firstLast = [profile?.first_name ?? "", profile?.last_name ?? ""]
    .join(" ")
    .trim();

  if (firstLast) return firstLast;

  return fallbackEmail ?? "Unknown User";
}

function buildStudioSections(params: {
  leadsBadgeCount: number;
  unreadNotificationsCount: number;
}) {
  const { leadsBadgeCount, unreadNotificationsCount } = params;

  return [
    {
      title: "Daily Operations",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        { label: "Schedule", href: "/app/schedule", icon: "schedule" },
        { label: "Clients", href: "/app/clients", icon: "clients" },
        {
          label: "Leads",
          href: "/app/leads",
          icon: "leads",
          badge: leadsBadgeCount,
        },
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
        { label: "Events", href: "/app/events", icon: "events" },
        { label: "Instructors", href: "/app/instructors", icon: "instructors" },
        { label: "Rooms", href: "/app/rooms", icon: "rooms" },
      ],
    },
    {
      title: "Sales & Billing",
      items: [
        { label: "Payments", href: "/app/payments", icon: "payments" },
        {
          label: "Client Balances",
          href: "/app/packages/client-balances",
          icon: "balances",
        },
        {
          label: "Package Templates",
          href: "/app/packages",
          icon: "packages",
        },
        {
          label: "Membership Plans",
          href: "/app/memberships",
          icon: "memberships",
        },
        { label: "Reports", href: "/app/reports", icon: "reports" },
      ],
    },
    {
      title: "Public Growth",
      items: [
        {
          label: "Public Profile",
          href: "/app/settings/public-profile",
          icon: "settings",
        },
      ],
    },
    {
      title: "Admin",
      items: [{ label: "Settings", href: "/app/settings", icon: "settings" }],
    },
  ];
}

function buildOrganizerSections(params: {
  unreadNotificationsCount: number;
}) {
  const { unreadNotificationsCount } = params;

  return [
    {
      title: "Organizer Operations",
      items: [
        { label: "Dashboard", href: "/app", icon: "dashboard" },
        { label: "Events", href: "/app/events", icon: "events" },
        { label: "Organizer Profile", href: "/app/organizers", icon: "settings" },
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
    {
      label: "Billing & Payouts",
      href: "/app/settings/billing",
      icon: "payments",
    },
    { label: "Payment History", href: "/app/payments", icon: "payments" },
    { label: "Reports", href: "/app/reports", icon: "reports" },
  ],
},
    {
      title: "Admin",
      items: [{ label: "Settings", href: "/app/settings", icon: "settings" }],
    },
  ];
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
    { data: accessibleRoles },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name, slug, public_name")
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

    supabase
      .from("user_studio_roles")
      .select("studio_id, role")
      .eq("user_id", user.id)
      .eq("active", true),
  ]);

  const currentStudio = studio ?? null;
  const currentStudioName = currentStudio?.name ?? "Workspace";
  const organizerWorkspace = isOrganizerWorkspaceName(currentStudioName);

  const roleRows = ((accessibleRoles ?? []) as RoleRow[]) || [];
  const accessibleStudioIds = Array.from(
    new Set(roleRows.map((row) => row.studio_id).filter(Boolean))
  );

  let accessibleStudios: WorkspaceItem[] = [];

  if (accessibleStudioIds.length > 0) {
    const { data: studiosForSwitcher } = await supabase
      .from("studios")
      .select("id, name, slug, public_name")
      .in("id", accessibleStudioIds);

    const studioById = new Map(
      (((studiosForSwitcher ?? []) as StudioRow[]) || []).map((item) => [
        item.id,
        item,
      ])
    );

    accessibleStudios = roleRows
      .map((row) => {
        const matchedStudio = studioById.get(row.studio_id);
        if (!matchedStudio) return null;

        return {
          studioId: matchedStudio.id,
          studioRole: row.role,
          studioName: matchedStudio.name,
          studioSlug: matchedStudio.slug,
          studioPublicName: matchedStudio.public_name,
          isSelected: matchedStudio.id === context.studioId,
        } satisfies WorkspaceItem;
      })
      .filter((value): value is WorkspaceItem => Boolean(value));
  }

  const safeNotifications = ((notifications ?? []) as NotificationItem[]) || [];
  const unreadNotificationsCount = safeNotifications.filter(
    (item) => !item.read_at
  ).length;

  const leadsBadgeCount = organizerWorkspace ? 0 : (openLeadCount ?? 0);

  const studioName = organizerWorkspace ? currentStudioName : currentStudioName;
  const userName = buildDisplayName({
    profile: profile ?? null,
    fallbackEmail: user.email,
  });
  const userEmail = profile?.email ?? user.email ?? "";

  const baseRoleLabel = context.isPlatformAdmin
    ? "Platform Admin"
    : formatRoleLabel(context.studioRole);

  const roleLabel =
    organizerWorkspace && !context.isPlatformAdmin
      ? `${baseRoleLabel || "organizer"} • organizer workspace`
      : baseRoleLabel;

  const sections = organizerWorkspace
    ? buildOrganizerSections({
        unreadNotificationsCount,
      })
    : buildStudioSections({
        leadsBadgeCount,
        unreadNotificationsCount,
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