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
  category?: string | null;
  priority?: string | null;
};

function fmtShortDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function notificationBadgeClass(type: string, category?: string | null) {
  const key = category || type;

  if (key === "booking" || type === "public_intro_booking") return "bg-blue-50 text-blue-700";
  if (key === "client" || type === "follow_up_overdue") return "bg-amber-50 text-amber-700";
  if (key === "package" || type === "package_low_balance") return "bg-orange-50 text-orange-700";
  if (type === "package_depleted" || key === "payment") return "bg-red-50 text-red-700";
  if (key === "membership") return "bg-fuchsia-50 text-fuchsia-700";
  if (key === "document") return "bg-cyan-50 text-cyan-700";
  if (key === "event") return "bg-emerald-50 text-emerald-700";
  if (key === "sms") return "bg-rose-50 text-rose-700";
  if (key === "credential") return "bg-violet-50 text-violet-700";
  if (key === "automation") return "bg-purple-50 text-purple-700";
  if (key === "check_in") return "bg-teal-50 text-teal-700";
  return "bg-slate-100 text-slate-700";
}

function notificationTypeLabel(type: string) {
  const labels: Record<string, string> = {
    public_intro_booking: "Public Intro",
    booking_request_pending: "Booking Request",
    booking_request_approved: "Request Approved",
    booking_request_declined: "Request Declined",
    portal_schedule_request: "Portal Request",
    follow_up_overdue: "Follow-Up",
    no_upcoming_lesson: "No Lesson Scheduled",
    package_low_balance: "Low Balance",
    package_depleted: "Package",
    package_renewal_due: "Package Renewal",
    membership_expiring: "Membership",
    membership_expired: "Membership",
    document_signature_needed: "Signature Needed",
    waiver_missing: "Waiver Missing",
    credential_submitted: "Credential",
    credential_verified: "Credential",
    credential_rejected: "Credential",
    client_checked_in: "Check-In",
    client_qr_identity: "Client QR",
    sms_failed: "SMS Failed",
    automation_action_needed: "Automation",
    mambo_opportunity: "ARIA",
    event_registration: "Event",
    event_check_in: "Event Check-In",
  };

  return labels[type] ?? type.replaceAll("_", " ");
}

function priorityBadgeClass(priority?: string | null) {
  if (priority === "urgent") return "bg-red-600 text-white";
  if (priority === "high") return "bg-amber-500 text-white";
  if (priority === "low") return "bg-slate-100 text-slate-600";
  return "bg-slate-100 text-slate-700";
}

function priorityLabel(priority?: string | null) {
  if (!priority || priority === "normal") return null;
  return priority.charAt(0).toUpperCase() + priority.slice(1);
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
                                notification.type,
                                notification.category
                              )}`}
                            >
                              {notificationTypeLabel(notification.type)}
                            </span>

                            {priorityLabel(notification.priority) ? (
                              <span
                                className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${priorityBadgeClass(
                                  notification.priority
                                )}`}
                              >
                                {priorityLabel(notification.priority)}
                              </span>
                            ) : null}

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