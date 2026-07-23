import Link from "next/link";
import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  Cake,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  Sparkles,
  UserRoundCheck,
} from "lucide-react";
import WorkspaceEmptyState from "@/components/app/workspace/WorkspaceEmptyState";
import WorkspacePane from "@/components/app/workspace/WorkspacePane";

export type TodayFollowUpItem = {
  id: string;
  personName: string;
  reason: string;
  suggestedAction: string;
  context?: string;
  href: string;
  priority: "high" | "medium" | "low";
  type: string;
};

export type TodayAppointmentItem = {
  id: string;
  title: string;
  typeLabel: string;
  dateTime: string;
  detail: string;
  href: string;
};

export type TodayNotificationItem = {
  id: string;
  title: string;
  body: string | null;
  unread: boolean;
};

function priorityClasses(priority: TodayFollowUpItem["priority"]) {
  if (priority === "high") return "border-rose-200 bg-rose-50 text-rose-700";
  if (priority === "medium") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-100 text-slate-600";
}

function priorityLabel(priority: TodayFollowUpItem["priority"]) {
  if (priority === "high") return "High";
  if (priority === "medium") return "Medium";
  return "Low";
}

function QueueLink({
  href,
  icon,
  title,
  detail,
  metric,
  tone = "default",
}: {
  href: string;
  icon: ReactNode;
  title: string;
  detail: string;
  metric?: string | number;
  tone?: "default" | "warning" | "danger" | "success";
}) {
  const toneClass =
    tone === "danger"
      ? "bg-rose-50 text-rose-700"
      : tone === "warning"
        ? "bg-amber-50 text-amber-700"
        : tone === "success"
          ? "bg-emerald-50 text-emerald-700"
          : "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]";

  return (
    <Link
      href={href}
      className="flex items-start gap-3 border-b border-[var(--brand-border)] px-4 py-3 transition last:border-b-0 hover:bg-[var(--brand-primary-soft)]/55"
    >
      <span className={`mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${toneClass}`}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-start justify-between gap-3">
          <span className="text-sm font-semibold text-[var(--brand-text)]">{title}</span>
          {metric !== undefined ? (
            <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs font-semibold text-[var(--brand-text)] ring-1 ring-[var(--brand-border)]">
              {metric}
            </span>
          ) : null}
        </span>
        <span className="mt-1 block text-xs leading-5 text-[var(--brand-muted)]">{detail}</span>
      </span>
      <ArrowRight className="mt-2 h-4 w-4 shrink-0 text-[var(--brand-muted)]" />
    </Link>
  );
}

export default function TodayActionQueue({
  bookingRequestCount,
  unreadCount,
  payoutsReady,
  followUps,
  appointments,
  notifications,
  birthdays,
  planLabel,
}: {
  bookingRequestCount: number;
  unreadCount: number;
  payoutsReady: boolean;
  followUps: TodayFollowUpItem[];
  appointments: TodayAppointmentItem[];
  notifications: TodayNotificationItem[];
  birthdays: {
    next7: number;
    next30: number;
    cardReady: number;
    missingBirthday: number;
    missingAddress: number;
  };
  planLabel: string;
}) {
  const visibleFollowUps = followUps.slice(0, 6);
  const highPriorityCount = followUps.filter((item) => item.priority === "high").length;
  const attentionCount =
    bookingRequestCount + unreadCount + highPriorityCount + (payoutsReady ? 0 : 1);

  return (
    <section className="overflow-hidden rounded-3xl border border-[var(--brand-border)] bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-[var(--brand-border)] px-4 py-4 sm:px-5 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            Today’s action queue
          </p>
          <h2 className="mt-1 text-xl font-semibold text-[var(--brand-text)]">
            Work that needs attention
          </h2>
          <p className="mt-1 text-sm text-[var(--brand-muted)]">
            Review the highest-value studio work without leaving the operating view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-xs font-semibold text-[var(--brand-primary)]">
            {attentionCount} attention item{attentionCount === 1 ? "" : "s"}
          </span>
          <Link
            href="/app/aria/operations"
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--brand-border)] bg-white px-3 py-2 text-sm font-semibold text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
          >
            <Sparkles className="h-4 w-4" />
            ARIA operations
          </Link>
        </div>
      </div>

      <div className="grid min-h-0 xl:grid-cols-[minmax(19rem,0.9fr)_minmax(0,1.35fr)_minmax(18rem,0.75fr)]">
        <WorkspacePane
          title="Priority queues"
          description="Counts that should be cleared or reviewed today."
          className="border-b border-[var(--brand-border)] xl:border-b-0 xl:border-r"
        >
          <QueueLink
            href="/app/schedule/requests"
            icon={<ClipboardList className="h-4 w-4" />}
            title="Booking requests"
            detail="Approve, decline, or schedule new and in-review requests."
            metric={bookingRequestCount}
            tone={bookingRequestCount > 0 ? "warning" : "success"}
          />
          <QueueLink
            href="/app/notifications?status=unread"
            icon={<Bell className="h-4 w-4" />}
            title="Unread alerts"
            detail="Review schedule, payment, document, and client notifications."
            metric={unreadCount}
            tone={unreadCount > 0 ? "warning" : "success"}
          />
          <QueueLink
            href="/app/reports/client-birthdays"
            icon={<Cake className="h-4 w-4" />}
            title="Birthday outreach"
            detail={`${birthdays.next7} in the next 7 days; ${birthdays.cardReady} have mailing details ready.`}
            metric={birthdays.next30}
            tone={birthdays.next7 > 0 ? "warning" : "default"}
          />
          <QueueLink
            href="/app/payments"
            icon={<CreditCard className="h-4 w-4" />}
            title={payoutsReady ? "Payments ready" : "Connect payouts"}
            detail={
              payoutsReady
                ? "Payment collection and payout tools are available."
                : "Stripe payouts must be connected before relying on paid sales."
            }
            metric={payoutsReady ? "Ready" : "Required"}
            tone={payoutsReady ? "success" : "danger"}
          />
          <QueueLink
            href="/app/settings/billing"
            icon={<UserRoundCheck className="h-4 w-4" />}
            title="Plan and access"
            detail={`Current workspace plan: ${planLabel}.`}
            metric={planLabel}
          />
        </WorkspacePane>

        <WorkspacePane
          title="Recommended follow-up"
          description={`${followUps.length} active suggestion${followUps.length === 1 ? "" : "s"}, ordered by priority.`}
          actions={
            <Link href="/app/aria" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              Open ARIA
            </Link>
          }
          className="border-b border-[var(--brand-border)] xl:border-b-0 xl:border-r"
        >
          {visibleFollowUps.length ? (
            <div>
              {visibleFollowUps.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className="block border-b border-[var(--brand-border)] px-4 py-3 transition last:border-b-0 hover:bg-[var(--brand-primary-soft)]/55"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-[var(--brand-text)]">{item.personName}</p>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClasses(item.priority)}`}>
                          {priorityLabel(item.priority)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">{item.reason}</p>
                      <p className="mt-1 text-xs font-medium leading-5 text-[var(--brand-primary)]">{item.suggestedAction}</p>
                      {item.context ? (
                        <p className="mt-1 text-[11px] text-[var(--brand-muted)]">{item.context}</p>
                      ) : null}
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--brand-muted)]" />
                  </div>
                </Link>
              ))}
              {followUps.length > visibleFollowUps.length ? (
                <div className="border-t border-[var(--brand-border)] px-4 py-3">
                  <Link href="/app/aria" className="text-sm font-semibold text-[var(--brand-primary)] hover:underline">
                    Review {followUps.length - visibleFollowUps.length} more suggestion{followUps.length - visibleFollowUps.length === 1 ? "" : "s"}
                  </Link>
                </div>
              ) : null}
            </div>
          ) : (
            <WorkspaceEmptyState
              icon={<CheckCircle2 className="h-5 w-5" />}
              title="No follow-up work is waiting"
              description="ARIA does not see an overdue lead, low package, inactive-client, or event-attendee follow-up in this summary."
            />
          )}
        </WorkspacePane>

        <div className="grid min-h-0 md:grid-cols-2 xl:grid-cols-1">
          <WorkspacePane
            title="Upcoming schedule"
            description="The next five active calendar items."
            actions={
              <Link href="/app/schedule" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
                Open schedule
              </Link>
            }
            className="border-b border-[var(--brand-border)] md:border-b-0 md:border-r xl:border-b xl:border-r-0"
          >
            {appointments.length ? (
              appointments.slice(0, 5).map((appointment) => (
                <Link
                  key={appointment.id}
                  href={appointment.href}
                  className="block border-b border-[var(--brand-border)] px-4 py-3 transition last:border-b-0 hover:bg-[var(--brand-primary-soft)]/55"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                      <CalendarDays className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--brand-text)]">{appointment.title}</span>
                      <span className="mt-0.5 block text-xs font-medium text-[var(--brand-primary)]">{appointment.dateTime}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--brand-muted)]">{appointment.detail}</span>
                    </span>
                  </div>
                </Link>
              ))
            ) : (
              <WorkspaceEmptyState
                icon={<CalendarDays className="h-5 w-5" />}
                title="No upcoming appointments"
                description="The upcoming schedule is currently clear."
                action={
                  <Link href="/app/schedule/new" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white">
                    Schedule appointment
                  </Link>
                }
              />
            )}
          </WorkspacePane>

          <WorkspacePane
            title="Recent alerts"
            description="Latest workspace notifications."
            actions={
              <Link href="/app/notifications" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
                View all
              </Link>
            }
          >
            {notifications.length ? (
              notifications.slice(0, 4).map((notification) => (
                <Link
                  key={notification.id}
                  href="/app/notifications"
                  className="block border-b border-[var(--brand-border)] px-4 py-3 transition last:border-b-0 hover:bg-[var(--brand-primary-soft)]/55"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-[var(--brand-text)]">{notification.title}</p>
                      {notification.body ? (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--brand-muted)]">{notification.body}</p>
                      ) : null}
                    </div>
                    {notification.unread ? (
                      <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--brand-accent)]" aria-label="Unread" />
                    ) : null}
                  </div>
                </Link>
              ))
            ) : (
              <div className="flex items-center gap-3 px-4 py-6 text-sm text-[var(--brand-muted)]">
                <AlertTriangle className="h-4 w-4" />
                No recent notifications.
              </div>
            )}
          </WorkspacePane>
        </div>
      </div>

      {(birthdays.missingBirthday > 0 || birthdays.missingAddress > 0) ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-4 py-3 text-xs text-[var(--brand-muted)]">
          <span>{birthdays.missingBirthday} client record{birthdays.missingBirthday === 1 ? "" : "s"} missing a birthday</span>
          <span>{birthdays.missingAddress} client record{birthdays.missingAddress === 1 ? "" : "s"} missing a mailing address</span>
          <Link href="/app/clients" className="font-semibold text-[var(--brand-primary)] hover:underline">
            Review client records
          </Link>
        </div>
      ) : null}
    </section>
  );
}
