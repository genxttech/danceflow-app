import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "../dashboard-actions";
import { syncStudioNotifications } from "@/lib/notifications/sync";

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
  if (type === "public_intro_booking") return "bg-blue-50 text-blue-700";
  if (type === "follow_up_overdue") return "bg-amber-50 text-amber-700";
  if (type === "package_low_balance") return "bg-orange-50 text-orange-700";
  if (type === "package_depleted") return "bg-red-50 text-red-700";
  if (type === "floor_rental_upcoming") return "bg-indigo-50 text-indigo-700";
  return "bg-slate-100 text-slate-700";
}

function notificationTypeLabel(type: string) {
  if (type === "public_intro_booking") return "Public Intro";
  if (type === "follow_up_overdue") return "Follow-Up Overdue";
  if (type === "package_low_balance") return "Package Low Balance";
  if (type === "package_depleted") return "Package Depleted";
  if (type === "floor_rental_upcoming") return "Floor Rental";
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

function buildFilterHref(status: string, type: string) {
  const params = new URLSearchParams();

  if (status !== "all") params.set("status", status);
  if (type !== "all") params.set("type", type);

  const query = params.toString();
  return query ? `/app/notifications?${query}` : "/app/notifications";
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

  const { data: roleRow } = await supabase
    .from("user_studio_roles")
    .select("studio_id")
    .eq("user_id", user.id)
    .eq("active", true)
    .limit(1)
    .single();

  if (!roleRow) {
    redirect("/login");
  }

  const studioId = roleRow.studio_id as string;

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

  if (typeFilter !== "all") {
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

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight text-slate-900">
            Notifications
          </h2>
          <p className="mt-2 text-slate-600">
            Review internal alerts for public bookings, floor rentals, and studio operations.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <span className="inline-flex rounded-full bg-slate-100 px-3 py-1 text-sm font-medium text-slate-700">
            {unreadCount ?? 0} unread
          </span>

          {(unreadCount ?? 0) > 0 ? (
            <form action={markAllNotificationsReadAction}>
              <button
                type="submit"
                className="rounded-xl border px-4 py-2 hover:bg-slate-50"
              >
                Mark all read
              </button>
            </form>
          ) : null}
        </div>
      </div>

      <div className="rounded-2xl border bg-white p-5">
        <div className="grid gap-4 lg:grid-cols-[220px_220px_auto]">
          <div>
            <label htmlFor="status" className="mb-1 block text-sm font-medium">
              Read Status
            </label>
            <select
              id="status"
              name="status"
              defaultValue={statusFilter}
              form="notification-filter-form"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All</option>
              <option value="unread">Unread</option>
              <option value="read">Read</option>
            </select>
          </div>

          <div>
            <label htmlFor="type" className="mb-1 block text-sm font-medium">
              Type
            </label>
            <select
              id="type"
              name="type"
              defaultValue={typeFilter}
              form="notification-filter-form"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="all">All Types</option>
              <option value="public_intro_booking">Public Intro</option>
              <option value="floor_rental_upcoming">Floor Rental</option>
              <option value="follow_up_overdue">Follow-Up Overdue</option>
              <option value="package_low_balance">Package Low Balance</option>
              <option value="package_depleted">Package Depleted</option>
            </select>
          </div>

          <div className="flex items-end gap-3">
            <form id="notification-filter-form" action="/app/notifications" method="get">
              <button
                type="submit"
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
              >
                Apply Filters
              </button>
            </form>

            <Link
              href="/app/notifications"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Reset
            </Link>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href={buildFilterHref("all", typeFilter)}
            className={`rounded-full px-4 py-2 text-sm ${
              statusFilter === "all"
                ? "bg-slate-900 text-white"
                : "border bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            All
          </Link>
          <Link
            href={buildFilterHref("unread", typeFilter)}
            className={`rounded-full px-4 py-2 text-sm ${
              statusFilter === "unread"
                ? "bg-slate-900 text-white"
                : "border bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Unread
          </Link>
          <Link
            href={buildFilterHref("read", typeFilter)}
            className={`rounded-full px-4 py-2 text-sm ${
              statusFilter === "read"
                ? "bg-slate-900 text-white"
                : "border bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            Read
          </Link>
        </div>
      </div>

      <div className="space-y-4">
        {typedNotifications.length === 0 ? (
          <div className="rounded-2xl border bg-white p-8 text-center text-slate-500">
            No notifications match your current filters.
          </div>
        ) : (
          typedNotifications.map((notification) => (
            <div
              key={notification.id}
              className="rounded-2xl border bg-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <Link href={getNotificationHref(notification)} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {notification.title}
                    </h3>

                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${notificationBadgeClass(
                        notification.type
                      )}`}
                    >
                      {notificationTypeLabel(notification.type)}
                    </span>

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
                    <p className="mt-2 text-sm text-slate-600">{notification.body}</p>
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
                    className="rounded-xl border px-4 py-2 hover:bg-slate-50"
                  >
                    Open
                  </Link>

                  {!notification.read_at ? (
                    <form action={markNotificationReadAction}>
                      <input type="hidden" name="notificationId" value={notification.id} />
                      <button
                        type="submit"
                        className="rounded-xl border px-4 py-2 hover:bg-slate-50"
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
      </div>
    </div>
  );
}