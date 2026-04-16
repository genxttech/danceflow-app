import Link from "next/link";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/auth/platform";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { clearStudioContextAction } from "@/app/platform/actions";
import AppSidebarShell from "./AppSidebarShell";

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

  const [
    { data: studio },
    { data: profile },
    { data: notifications },
    { count: openLeadCount },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select("id, name")
      .eq("id", context.studioId)
      .maybeSingle(),

    supabase
      .from("profiles")
      .select("id, first_name, last_name, email")
      .eq("id", user.id)
      .maybeSingle(),

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
  ]);

  const safeNotifications = ((notifications ?? []) as NotificationItem[]) || [];
  const unreadNotificationsCount = safeNotifications.filter(
    (item) => !item.read_at
  ).length;
  const leadsBadgeCount = openLeadCount ?? 0;

  const studioName = studio?.name ?? "Studio";
  const userName =
    profile?.first_name || profile?.last_name
      ? [profile?.first_name ?? "", profile?.last_name ?? ""].join(" ").trim()
      : user.email ?? "Unknown User";

  const userEmail = profile?.email ?? user.email ?? "";
  const roleLabel = context.isPlatformAdmin
    ? "Platform Admin"
    : context.studioRole
      ? context.studioRole.replaceAll("_", " ")
      : "";

  const sections = [
    {
      title: "Front Desk",
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
      title: "Programs & Events",
      items: [
        { label: "Events", href: "/app/events", icon: "events" },
        {
          label: "Registrations",
          href: "/app/events",
          icon: "checkin",
        },
        { label: "Instructors", href: "/app/instructors", icon: "instructors" },
        { label: "Rooms", href: "/app/rooms", icon: "rooms" },
      ],
    },
    {
      title: "Revenue",
      items: [
        { label: "Payments", href: "/app/payments", icon: "payments" },
        {
          label: "Balances",
          href: "/app/packages/client-balances",
          icon: "balances",
        },
        { label: "Packages", href: "/app/packages", icon: "packages" },
        { label: "Memberships", href: "/app/memberships", icon: "memberships" },
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

  let studioBanner: React.ReactNode = null;

  if (await isPlatformAdmin()) {
    studioBanner = (
      <div className="border-b border-amber-200 bg-amber-50">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-6 py-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Viewing studio as platform admin
            </p>
            <p className="text-sm text-amber-800">
              {studioName} • You are in temporary studio context.
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
                Exit Studio Context
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
      >
        {children}
      </AppSidebarShell>
    </div>
  );
}