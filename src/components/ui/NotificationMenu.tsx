"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useMemo, useState } from "react";
import {
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/app/app/dashboard-actions";

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

function fmtShortDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function notificationBadgeClass(type: string) {
  if (type === "public_intro_booking") return "bg-blue-50 text-blue-700";
  if (type === "follow_up_overdue") return "bg-amber-50 text-amber-700";
  if (type === "package_low_balance") return "bg-orange-50 text-orange-700";
  if (type === "package_depleted") return "bg-red-50 text-red-700";
  return "bg-slate-100 text-slate-700";
}

function notificationTypeLabel(type: string) {
  if (type === "public_intro_booking") return "Public Intro";
  if (type === "follow_up_overdue") return "Follow-Up";
  if (type === "package_low_balance") return "Low Balance";
  if (type === "package_depleted") return "Package";
  return type.replaceAll("_", " ");
}

function getNotificationHref(notification: NotificationItem) {
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
  return "/app/notifications";
}

export default function NotificationMenu({
  notifications,
  unreadCount,
  className = "",
}: {
  notifications: NotificationItem[];
  unreadCount: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  const orderedNotifications = useMemo(() => {
    return [...notifications].sort((a, b) => {
      if (!a.read_at && b.read_at) return -1;
      if (a.read_at && !b.read_at) return 1;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [notifications]);

  return (
    <div className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative rounded-xl border bg-white p-2 text-slate-700 hover:bg-slate-50"
        aria-label="Open notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 ? (
          <span className="absolute -right-1 -top-1 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close notifications"
          />

          <div className="absolute right-0 z-40 mt-2 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border bg-white shadow-xl">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <p className="font-semibold text-slate-900">Notifications</p>
                <p className="text-xs text-slate-500">{unreadCount} unread</p>
              </div>

              {unreadCount > 0 ? (
                <form action={markAllNotificationsReadAction}>
                  <button
                    type="submit"
                    className="rounded-lg border px-3 py-1.5 text-xs hover:bg-slate-50"
                  >
                    Mark all read
                  </button>
                </form>
              ) : null}
            </div>

            <div className="max-h-[26rem] overflow-y-auto">
              {orderedNotifications.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-slate-500">
                  No notifications yet.
                </div>
              ) : (
                <div className="divide-y">
                  {orderedNotifications.slice(0, 8).map((notification) => (
                    <div key={notification.id} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <Link
                          href={getNotificationHref(notification)}
                          onClick={() => setOpen(false)}
                          className="min-w-0 flex-1"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium text-slate-900">
                              {notification.title}
                            </p>

                            <span
                              className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${notificationBadgeClass(
                                notification.type
                              )}`}
                            >
                              {notificationTypeLabel(notification.type)}
                            </span>

                            {!notification.read_at ? (
                              <span className="inline-flex h-2 w-2 rounded-full bg-slate-900" />
                            ) : null}
                          </div>

                          {notification.body ? (
                            <p className="mt-1 line-clamp-2 text-xs text-slate-600">
                              {notification.body}
                            </p>
                          ) : null}

                          <p className="mt-2 text-[11px] text-slate-500">
                            {fmtShortDateTime(notification.created_at)}
                          </p>
                        </Link>

                        {!notification.read_at ? (
                          <form action={markNotificationReadAction}>
                            <input
                              type="hidden"
                              name="notificationId"
                              value={notification.id}
                            />
                            <button
                              type="submit"
                              className="rounded-lg border px-2 py-1 text-[11px] hover:bg-slate-50"
                            >
                              Read
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t px-4 py-3">
              <Link
                href="/app/notifications"
                onClick={() => setOpen(false)}
                className="block rounded-xl bg-slate-900 px-4 py-2 text-center text-sm text-white hover:bg-slate-800"
              >
                View all notifications
              </Link>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}