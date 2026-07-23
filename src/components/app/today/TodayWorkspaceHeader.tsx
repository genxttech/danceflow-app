import Link from "next/link";
import {
  CompactSummaryStrip,
  WorkspaceHeader,
} from "@/components/app/workspace";

export default function TodayWorkspaceHeader({
  workspaceName,
  planLabel,
  trialLabel,
  clientCount,
  upcomingCount,
  membershipCount,
  bookingRequestCount,
  unreadCount,
}: {
  workspaceName: string;
  planLabel: string;
  trialLabel?: string | null;
  clientCount: number;
  upcomingCount: number;
  membershipCount: number;
  bookingRequestCount: number;
  unreadCount: number;
}) {
  return (
    <div className="bg-white">
      <WorkspaceHeader
        eyebrow="Studio operations"
        title="Today"
        description={`Focus on what needs attention in ${workspaceName}. Daily work, follow-up, scheduling, and ARIA guidance now begin from one operating view.`}
        actions={
          <>
            <Link
              href="/app/sell"
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:bg-[var(--brand-primary-dark)]"
            >
              Sell
            </Link>
            <Link
              href="/app/schedule/new"
              className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              New appointment
            </Link>
            <Link
              href="/app/clients/new"
              className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              Add client
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--brand-border)] px-4 py-2 text-xs text-[var(--brand-muted)] sm:px-6 lg:px-8">
        <span className="font-medium text-[var(--brand-text)]">{workspaceName}</span>
        <span aria-hidden="true">•</span>
        <span>{planLabel} plan</span>
        {trialLabel ? (
          <>
            <span aria-hidden="true">•</span>
            <span>{trialLabel}</span>
          </>
        ) : null}
      </div>

      <CompactSummaryStrip
        items={[
          {
            key: "clients",
            label: "Clients",
            value: clientCount,
            detail: "Visible records",
          },
          {
            key: "upcoming",
            label: "Upcoming",
            value: upcomingCount,
            detail: "Scheduled ahead",
            tone: upcomingCount > 0 ? "info" : "default",
          },
          {
            key: "memberships",
            label: "Memberships",
            value: membershipCount,
            detail: "Currently active",
            tone: membershipCount > 0 ? "success" : "default",
          },
          {
            key: "requests",
            label: "Booking requests",
            value: bookingRequestCount,
            detail: "New or in review",
            tone: bookingRequestCount > 0 ? "warning" : "default",
          },
          {
            key: "alerts",
            label: "Unread alerts",
            value: unreadCount,
            detail: "Needs review",
            tone: unreadCount > 0 ? "danger" : "default",
          },
        ]}
      />
    </div>
  );
}
