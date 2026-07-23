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
    <div className="overflow-hidden border-b border-orange-200/70 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.16),transparent_30%),linear-gradient(180deg,#fff7ed_0%,#ffffff_72%)]">
      <WorkspaceHeader
        eyebrow="Studio operations"
        title="Today"
        description={`Focus on what needs attention in ${workspaceName}. Daily work, follow-up, scheduling, and ARIA guidance now begin from one operating view.`}
        actions={
          <>
            <Link
              href="/app/sell"
              className="rounded-xl bg-[linear-gradient(135deg,#111827_0%,#4c1d95_62%,#f97316_150%)] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:brightness-110"
            >
              Sell
            </Link>
            <Link
              href="/app/schedule/new"
              className="rounded-xl border border-violet-200 bg-white/90 px-4 py-2 text-sm font-semibold text-violet-800 shadow-sm hover:bg-violet-50"
            >
              New appointment
            </Link>
            <Link
              href="/app/clients/new"
              className="rounded-xl border border-orange-200 bg-white/90 px-4 py-2 text-sm font-semibold text-orange-800 shadow-sm hover:bg-orange-50"
            >
              Add client
            </Link>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-2 border-t border-orange-100 bg-white/65 px-4 py-2 text-xs text-[var(--brand-muted)] backdrop-blur sm:px-6 lg:px-8">
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
