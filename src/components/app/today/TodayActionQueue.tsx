"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
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

type QueueView = "attention" | "follow-up" | "schedule" | "alerts";

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
      className="flex items-start gap-3 border-b border-[var(--brand-border)] px-4 py-3 transition last:border-b-0 hover:bg-[linear-gradient(90deg,rgba(124,58,237,0.06),rgba(249,115,22,0.05))]"
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

function QueueTab({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs font-semibold transition",
        active
          ? "border-transparent bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] text-white shadow-sm"
          : "border-[var(--brand-border)] bg-white text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]",
      ].join(" ")}
      aria-pressed={active}
    >
      {label}
      <span
        className={[
          "rounded-full px-1.5 py-0.5 text-[10px]",
          active ? "bg-white/15 text-white" : "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]",
        ].join(" ")}
      >
        {count}
      </span>
    </button>
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
  const orderedFollowUps = useMemo(
    () =>
      [...followUps].sort((a, b) => {
        const rank = { high: 0, medium: 1, low: 2 } as const;
        return rank[a.priority] - rank[b.priority];
      }),
    [followUps],
  );

  const [activeView, setActiveView] = useState<QueueView>("attention");
  const [selectedFollowUpId, setSelectedFollowUpId] = useState<string | null>(
    orderedFollowUps[0]?.id ?? null,
  );

  const selectedFollowUp =
    orderedFollowUps.find((item) => item.id === selectedFollowUpId) ??
    orderedFollowUps[0] ??
    null;

  const highPriorityCount = orderedFollowUps.filter((item) => item.priority === "high").length;
  const attentionCount =
    bookingRequestCount + unreadCount + highPriorityCount + (payoutsReady ? 0 : 1);

  const tabs: Array<{ id: QueueView; label: string; count: number }> = [
    { id: "attention", label: "Attention", count: attentionCount },
    { id: "follow-up", label: "Follow-up", count: orderedFollowUps.length },
    { id: "schedule", label: "Schedule", count: appointments.length },
    { id: "alerts", label: "Alerts", count: unreadCount },
  ];

  return (
    <section className="overflow-hidden rounded-3xl border border-violet-200/80 bg-white shadow-[0_18px_50px_rgba(76,29,149,0.10)]">
      <div className="border-b border-violet-100 bg-[linear-gradient(135deg,#faf5ff_0%,#fff7ed_52%,#ffffff_100%)] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Today’s action queue
            </p>
            <h2 className="mt-1 text-xl font-semibold text-[var(--brand-text)]">
              Work that needs attention
            </h2>
            <p className="mt-1 text-sm text-[var(--brand-muted)]">
              Review urgent work first, then move through follow-up, schedule, and alerts.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={[
                "rounded-full px-3 py-1 text-xs font-semibold",
                attentionCount > 0
                  ? "bg-amber-50 text-amber-700"
                  : "bg-emerald-50 text-emerald-700",
              ].join(" ")}
            >
              {attentionCount > 0
                ? `${attentionCount} attention item${attentionCount === 1 ? "" : "s"}`
                : "All clear"}
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

        <div className="-mx-1 mt-4 flex gap-2 overflow-x-auto px-1 pb-1">
          {tabs.map((tab) => (
            <QueueTab
              key={tab.id}
              active={activeView === tab.id}
              label={tab.label}
              count={tab.count}
              onClick={() => setActiveView(tab.id)}
            />
          ))}
        </div>
      </div>

      {activeView === "attention" ? (
        <div className="grid min-h-0 lg:grid-cols-[minmax(18rem,0.9fr)_minmax(0,1.25fr)]">
          <WorkspacePane
            title="Priority queues"
            description="Counts that should be cleared or reviewed today."
            className="border-b border-[var(--brand-border)] lg:border-b-0 lg:border-r"
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
              href="/app/reports/client-birthdays"
              icon={<Cake className="h-4 w-4" />}
              title="Birthday outreach"
              detail={`${birthdays.next7} in the next 7 days; ${birthdays.cardReady} have mailing details ready.`}
              metric={birthdays.next30}
              tone={birthdays.next7 > 0 ? "warning" : "default"}
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
            title={attentionCount > 0 ? "Highest-priority follow-up" : "Today is clear"}
            description={
              attentionCount > 0
                ? "The most urgent client-facing recommendation currently available."
                : "No urgent booking, alert, payout, or high-priority follow-up item is waiting."
            }
          >
            {selectedFollowUp ? (
              <div className="p-4 sm:p-5">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClasses(selectedFollowUp.priority)}`}>
                      {priorityLabel(selectedFollowUp.priority)}
                    </span>
                    <span className="text-xs font-medium text-[var(--brand-muted)]">
                      {selectedFollowUp.type.replaceAll("_", " ")}
                    </span>
                  </div>
                  <h3 className="mt-3 text-lg font-semibold text-[var(--brand-text)]">
                    {selectedFollowUp.personName}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                    {selectedFollowUp.reason}
                  </p>
                  <div className="mt-4 rounded-xl border border-[var(--brand-border)] bg-white p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                      Recommended next step
                    </p>
                    <p className="mt-2 text-sm font-medium leading-6 text-[var(--brand-text)]">
                      {selectedFollowUp.suggestedAction}
                    </p>
                    {selectedFollowUp.context ? (
                      <p className="mt-2 text-xs text-[var(--brand-muted)]">
                        {selectedFollowUp.context}
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={selectedFollowUp.href}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-primary-dark)]"
                  >
                    Open recommended action
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            ) : (
              <WorkspaceEmptyState
                icon={<CheckCircle2 className="h-5 w-5" />}
                title="No urgent follow-up is waiting"
                description="ARIA does not see a high-priority client follow-up in this summary."
              />
            )}
          </WorkspacePane>
        </div>
      ) : null}

      {activeView === "follow-up" ? (
        <div className="grid min-h-[24rem] lg:grid-cols-[minmax(18rem,0.95fr)_minmax(0,1.25fr)]">
          <WorkspacePane
            title="Recommended follow-up"
            description={`${orderedFollowUps.length} active suggestion${orderedFollowUps.length === 1 ? "" : "s"}, ordered by priority.`}
            className="border-b border-[var(--brand-border)] lg:border-b-0 lg:border-r"
          >
            {orderedFollowUps.length ? (
              orderedFollowUps.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedFollowUpId(item.id)}
                  className={[
                    "block w-full border-b border-[var(--brand-border)] px-4 py-3 text-left transition last:border-b-0",
                    selectedFollowUp?.id === item.id
                      ? "bg-[var(--brand-primary-soft)]"
                      : "hover:bg-[var(--brand-primary-soft)]/55",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
                          {item.personName}
                        </p>
                        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClasses(item.priority)}`}>
                          {priorityLabel(item.priority)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-[var(--brand-muted)]">
                        {item.reason}
                      </p>
                    </div>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-[var(--brand-muted)]" />
                  </div>
                </button>
              ))
            ) : (
              <WorkspaceEmptyState
                icon={<CheckCircle2 className="h-5 w-5" />}
                title="No follow-up work is waiting"
                description="ARIA does not see an overdue lead, low package, inactive-client, or event-attendee follow-up in this summary."
              />
            )}
          </WorkspacePane>

          <WorkspacePane
            title="Selected recommendation"
            description="Review the context before leaving Today to complete the work."
          >
            {selectedFollowUp ? (
              <div className="p-4 sm:p-5">
                <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${priorityClasses(selectedFollowUp.priority)}`}>
                      {priorityLabel(selectedFollowUp.priority)}
                    </span>
                    <span className="text-xs font-medium capitalize text-[var(--brand-muted)]">
                      {selectedFollowUp.type.replaceAll("_", " ")}
                    </span>
                  </div>
                  <h3 className="mt-3 text-xl font-semibold text-[var(--brand-text)]">
                    {selectedFollowUp.personName}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
                    {selectedFollowUp.reason}
                  </p>
                  <div className="mt-4 rounded-xl bg-[var(--brand-primary-soft)] p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
                      Suggested action
                    </p>
                    <p className="mt-2 text-sm font-medium leading-6 text-[var(--brand-text)]">
                      {selectedFollowUp.suggestedAction}
                    </p>
                    {selectedFollowUp.context ? (
                      <p className="mt-2 text-xs text-[var(--brand-muted)]">
                        {selectedFollowUp.context}
                      </p>
                    ) : null}
                  </div>
                  <Link
                    href={selectedFollowUp.href}
                    className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-primary-dark)]"
                  >
                    Open client workflow
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            ) : (
              <WorkspaceEmptyState
                icon={<CheckCircle2 className="h-5 w-5" />}
                title="Nothing selected"
                description="Choose a recommendation to review its context."
              />
            )}
          </WorkspacePane>
        </div>
      ) : null}

      {activeView === "schedule" ? (
        <WorkspacePane
          title="Upcoming schedule"
          description="The next active calendar items."
          actions={
            <Link href="/app/schedule" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              Open schedule
            </Link>
          }
        >
          {appointments.length ? (
            <div className="grid gap-0 md:grid-cols-2">
              {appointments.slice(0, 8).map((appointment) => (
                <Link
                  key={appointment.id}
                  href={appointment.href}
                  className="border-b border-[var(--brand-border)] px-4 py-4 transition hover:bg-[var(--brand-primary-soft)]/55 md:odd:border-r"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700">
                      <CalendarDays className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-[var(--brand-text)]">
                        {appointment.title}
                      </span>
                      <span className="mt-0.5 block text-xs font-medium text-[var(--brand-primary)]">
                        {appointment.dateTime}
                      </span>
                      <span className="mt-1 block text-xs text-[var(--brand-muted)]">
                        {appointment.typeLabel}
                      </span>
                      <span className="mt-1 block line-clamp-2 text-xs text-[var(--brand-muted)]">
                        {appointment.detail}
                      </span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
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
      ) : null}

      {activeView === "alerts" ? (
        <WorkspacePane
          title="Recent alerts"
          description="Latest workspace notifications, with unread items first."
          actions={
            <Link href="/app/notifications" className="text-xs font-semibold text-[var(--brand-primary)] hover:underline">
              View all
            </Link>
          }
        >
          {notifications.length ? (
            [...notifications]
              .sort((a, b) => Number(b.unread) - Number(a.unread))
              .map((notification) => (
                <Link
                  key={notification.id}
                  href="/app/notifications"
                  className="block border-b border-[var(--brand-border)] px-4 py-4 transition last:border-b-0 hover:bg-[var(--brand-primary-soft)]/55"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={[
                        "mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl",
                        notification.unread
                          ? "bg-amber-50 text-amber-700"
                          : "bg-slate-100 text-slate-600",
                      ].join(" ")}
                    >
                      <Bell className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm font-semibold text-[var(--brand-text)]">
                          {notification.title}
                        </p>
                        {notification.unread ? (
                          <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            Unread
                          </span>
                        ) : null}
                      </div>
                      {notification.body ? (
                        <p className="mt-1 text-xs leading-5 text-[var(--brand-muted)]">
                          {notification.body}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </Link>
              ))
          ) : (
            <div className="flex items-center gap-3 px-4 py-8 text-sm text-[var(--brand-muted)]">
              <AlertTriangle className="h-4 w-4" />
              No recent notifications.
            </div>
          )}
        </WorkspacePane>
      ) : null}

      {birthdays.missingBirthday > 0 || birthdays.missingAddress > 0 ? (
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
