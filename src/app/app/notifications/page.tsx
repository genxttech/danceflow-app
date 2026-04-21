import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "../dashboard-actions";
import { syncStudioNotifications } from "@/lib/notifications/sync";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { Bell, CalendarDays, Sparkles } from "lucide-react";

type SearchParams = Promise<{
  status?: string;
  type?: string;
}>;

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  read_at: string | null;
  created_at: string;
  client_id: string | null;
  appointment_id: string | null;
  lead_activity_id: string | null;
  client_package_id: string | null;
};

type NotificationTypeOption = {
  value: string;
  label: string;
};

type WorkspaceRow = {
  id: string;
  name: string | null;
  public_name: string | null;
};

const studioNotificationTypeOptions: NotificationTypeOption[] = [
  { value: "public_intro_booking", label: "Public Intro" },
  { value: "floor_rental_upcoming", label: "Floor Rental" },
  { value: "follow_up_overdue", label: "Follow-Up Overdue" },
  { value: "package_low_balance", label: "Package Low Balance" },
  { value: "package_depleted", label: "Package Depleted" },
];

function isOrganizerWorkspaceName(value: string | null | undefined) {
  const normalized = (value ?? "").trim().toLowerCase();

  if (!normalized) return false;

  return (
    normalized.endsWith(" organizer") ||
    normalized.includes(" organizer ") ||
    normalized.endsWith(" events")
  );
}

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function notificationBadgeClass(type: string) {
  if (type === "public_intro_booking") return "bg-blue-50 text-blue-700 ring-1 ring-blue-200";
  if (type === "follow_up_overdue") return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  if (type === "package_low_balance") return "bg-orange-50 text-orange-700 ring-1 ring-orange-200";
  if (type === "package_depleted") return "bg-red-50 text-red-700 ring-1 ring-red-200";
  if (type === "floor_rental_upcoming") return "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function notificationTypeLabel(type: string) {
  const match = studioNotificationTypeOptions.find((option) => option.value === type);
  if (match) return match.label;
  return type.replaceAll("_", " ");
}

function getNotificationHref(notification: NotificationRow) {
  if (notification.appointment_id) {
    return `/app/schedule/${notification.appointment_id}?notificationId=${encodeURIComponent(
      notification.id
    )}`;
  }

  if (notification.client_id) {
    return `/app/clients/${notification.client_id}?notificationId=${encodeURIComponent(
      notification.id
    )}`;
  }

  return "/app";
}

function buildFilterHref(status: string, type: string, organizerWorkspace: boolean) {
  const params = new URLSearchParams();

  if (status !== "all") params.set("status", status);
  if (!organizerWorkspace && type !== "all") params.set("type", type);

  const query = params.toString();
  return query ? `/app/notifications?${query}` : "/app/notifications";
}

function StatCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">{value}</p>
        </div>
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </div>
  );
}

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const statusFilter = params.status ?? "all";
  const typeFilter = params.type ?? "all";

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const { data: workspace, error: workspaceError } = await supabase
    .from("studios")
    .select("id, name, public_name")
    .eq("id", studioId)
    .maybeSingle<WorkspaceRow>();

  if (workspaceError) {
    throw new Error(`Failed to load workspace: ${workspaceError.message}`);
  }

  const organizerWorkspace = isOrganizerWorkspaceName(workspace?.name);
  const workspaceName =
    workspace?.public_name?.trim() || workspace?.name?.trim() || "Workspace";

  const notificationTypeOptions = organizerWorkspace
    ? []
    : studioNotificationTypeOptions;

  await syncStudioNotifications(studioId);

  let notificationsQuery = supabase
    .from("notifications")
    .select(`
      id,
      type,
      title,
      body,
      read_at,
      created_at,
      client_id,
      appointment_id,
      lead_activity_id,
      client_package_id
    `)
    .eq("studio_id", studioId)
    .order("created_at", { ascending: false })
    .limit(100);

  if (statusFilter === "unread") {
    notificationsQuery = notificationsQuery.is("read_at", null);
  } else if (statusFilter === "read") {
    notificationsQuery = notificationsQuery.not("read_at", "is", null);
  }

  if (!organizerWorkspace && typeFilter !== "all") {
    notificationsQuery = notificationsQuery.eq("type", typeFilter);
  }

  const [
    { data: notifications, error: notificationsError },
    { count: unreadCount, error: unreadCountError },
  ] = await Promise.all([
    notificationsQuery,
    supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("studio_id", studioId)
      .is("read_at", null),
  ]);

  if (notificationsError) {
    throw new Error(`Failed to load notifications: ${notificationsError.message}`);
  }

  if (unreadCountError) {
    throw new Error(`Failed to load unread notifications count: ${unreadCountError.message}`);
  }

  const typedNotifications = (notifications ?? []) as NotificationRow[];
  const unread = unreadCount ?? 0;
  const readCount = typedNotifications.filter((item) => item.read_at).length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {organizerWorkspace ? "DanceFlow Organizer Workspace" : "DanceFlow Studio Workspace"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                {organizerWorkspace ? "Organizer Notifications" : "Notifications"}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                {organizerWorkspace
                  ? `Review workspace alerts for ${workspaceName} without the studio CRM-only noise.`
                  : "Review internal alerts for leads, packages, intro bookings, floor rentals, and daily studio operations."}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span className="inline-flex rounded-full bg-white/10 px-3 py-1 text-sm font-medium text-white ring-1 ring-white/15">
                {unread} unread
              </span>

              {unread > 0 ? (
                <form action={markAllNotificationsReadAction}>
                  <button
                    type="submit"
                    className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
                  >
                    Mark all read
                  </button>
                </form>
              ) : null}
            </div>
          </div>
        </div>

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <StatCard label="Unread" value={unread} icon={Bell} />
            <StatCard label="Loaded" value={typedNotifications.length} icon={CalendarDays} />
            <StatCard
              label={organizerWorkspace ? "Reviewed" : "Read"}
              value={readCount}
              icon={Sparkles}
            />
          </div>
        </div>
      </section>

      <section className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
        <div
          className={`grid gap-4 ${
            organizerWorkspace ? "lg:grid-cols-[220px_auto]" : "lg:grid-cols-[220px_220px_auto]"
          }`}
        >
          <div>
            <label htmlFor="status" className="mb-1.5 block text-sm font-medium text-slate-800">
              Read Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              form="notification-filter-form"
              className="w-full rounded-2xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary)]/10"
            >
              <option value="all">All</option>
              <option value="unread">Unread</option>
              <option value="read">Read</option>
            </select>
          </div>

          {!organizerWorkspace ? (
            <div>
              <label htmlFor="type" className="mb-1.5 block text-sm font-medium text-slate-800">
                Type
              </label>
              <select
                id="type"
                name="type"
                defaultValue={typeFilter}
                form="notification-filter-form"
                className="w-full rounded-2xl border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-4 focus:ring-[var(--brand-primary)]/10"
              >
                <option value="all">All Types</option>
                {notificationTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div className="flex items-end gap-3">
            <form id="notification-filter-form" action="/app/notifications" method="get">
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
              >
                Apply Filters
              </button>
            </form>

            <Link
              href="/app/notifications"
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>

        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap gap-3">
            <Link
              href={buildFilterHref("all", typeFilter, organizerWorkspace)}
              className={`rounded-full px-4 py-2 text-sm ${
                statusFilter === "all"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              All
            </Link>
            <Link
              href={buildFilterHref("unread", typeFilter, organizerWorkspace)}
              className={`rounded-full px-4 py-2 text-sm ${
                statusFilter === "unread"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Unread
            </Link>
            <Link
              href={buildFilterHref("read", typeFilter, organizerWorkspace)}
              className={`rounded-full px-4 py-2 text-sm ${
                statusFilter === "read"
                  ? "bg-slate-900 text-white"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              Read
            </Link>
          </div>

          {!organizerWorkspace ? (
            <div className="flex flex-wrap gap-3">
              <Link
                href={buildFilterHref(statusFilter, "all", organizerWorkspace)}
                className={`rounded-full px-4 py-2 text-sm ${
                  typeFilter === "all"
                    ? "bg-slate-900 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                }`}
              >
                All Types
              </Link>

              {notificationTypeOptions.map((option) => (
                <Link
                  key={option.value}
                  href={buildFilterHref(statusFilter, option.value, organizerWorkspace)}
                  className={`rounded-full px-4 py-2 text-sm ${
                    typeFilter === option.value
                      ? "bg-slate-900 text-white"
                      : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {option.label}
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      </section>

      <section className="space-y-4">
        {typedNotifications.length === 0 ? (
          <div className="rounded-[32px] border border-slate-200 bg-white p-10 text-center text-slate-500 shadow-sm">
            No notifications match your current filters.
          </div>
        ) : (
          typedNotifications.map((notification) => (
            <div
              key={notification.id}
              className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <Link href={getNotificationHref(notification)} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {notification.title}
                    </h3>

                    {!organizerWorkspace ? (
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${notificationBadgeClass(
                          notification.type
                        )}`}
                      >
                        {notificationTypeLabel(notification.type)}
                      </span>
                    ) : null}

                    {!notification.read_at ? (
                      <span className="inline-flex rounded-full bg-slate-900 px-2.5 py-1 text-xs font-medium text-white">
                        Unread
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
                        Read
                      </span>
                    )}
                  </div>

                  {notification.body ? (
                    <p className="mt-2 text-sm leading-7 text-slate-600">
                      {notification.body}
                    </p>
                  ) : null}

                  <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
                    <span>Created: {fmtDateTime(notification.created_at)}</span>
                    {notification.read_at ? (
                      <span>Read: {fmtDateTime(notification.read_at)}</span>
                    ) : null}
                  </div>
                </Link>

                <div className="flex flex-wrap gap-3">
                  <Link
                    href={getNotificationHref(notification)}
                    className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Open
                  </Link>

                  {!notification.read_at ? (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={notification.id} />
                      <button
                        type="submit"
                        className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Mark read
                      </button>
                    </form>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}