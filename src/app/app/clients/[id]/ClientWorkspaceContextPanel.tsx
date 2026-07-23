import Link from "next/link";
import {
  AlertTriangle,
  CalendarPlus,
  CircleCheck,
  CreditCard,
  FileSignature,
  PackageOpen,
  UserRoundCog,
} from "lucide-react";

type ClientWorkspaceContextPanelProps = {
  clientId: string;
  activeTab: string;
  clientStatus: string;
  nextAppointmentAt: string | null;
  studioTimeZone: string;
  activePackageCount: number;
  pendingRequiredDocumentCount: number;
  unpaidLessonCount: number;
  accountBalance: number;
  membershipStatus: string | null;
  portalStatus: string;
  canBook: boolean;
};

type ContextItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  actionLabel: string;
  tone: "danger" | "warning" | "info" | "success" | "default";
  icon: React.ComponentType<{ className?: string }>;
};

function fmtNextAppointment(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function toneClasses(tone: ContextItem["tone"]) {
  if (tone === "danger") {
    return {
      card: "border-rose-200 bg-rose-50",
      icon: "bg-white text-rose-700 ring-rose-200",
      action: "text-rose-800",
    };
  }

  if (tone === "warning") {
    return {
      card: "border-amber-200 bg-amber-50",
      icon: "bg-white text-amber-700 ring-amber-200",
      action: "text-amber-800",
    };
  }

  if (tone === "info") {
    return {
      card: "border-sky-200 bg-sky-50",
      icon: "bg-white text-sky-700 ring-sky-200",
      action: "text-sky-800",
    };
  }

  if (tone === "success") {
    return {
      card: "border-emerald-200 bg-emerald-50",
      icon: "bg-white text-emerald-700 ring-emerald-200",
      action: "text-emerald-800",
    };
  }

  return {
    card: "border-[var(--brand-border)] bg-white",
    icon: "bg-[var(--brand-primary-soft)] text-[var(--brand-primary)] ring-[var(--brand-border)]",
    action: "text-[var(--brand-primary)]",
  };
}

export default function ClientWorkspaceContextPanel({
  clientId,
  activeTab,
  clientStatus,
  nextAppointmentAt,
  studioTimeZone,
  activePackageCount,
  pendingRequiredDocumentCount,
  unpaidLessonCount,
  accountBalance,
  membershipStatus,
  portalStatus,
  canBook,
}: ClientWorkspaceContextPanelProps) {
  const issues: ContextItem[] = [];

  if (membershipStatus === "past_due" || membershipStatus === "unpaid") {
    issues.push({
      key: "membership",
      title: membershipStatus === "unpaid" ? "Membership unpaid" : "Membership past due",
      detail: "Review billing status and payment recovery steps.",
      href: `/app/clients/${clientId}?tab=billing#membership-billing-controls`,
      actionLabel: "Review billing",
      tone: membershipStatus === "unpaid" ? "danger" : "warning",
      icon: CreditCard,
    });
  }

  if (unpaidLessonCount > 0) {
    issues.push({
      key: "lessons",
      title: `${unpaidLessonCount} unpaid lesson${unpaidLessonCount === 1 ? "" : "s"}`,
      detail: "Pay-as-you-go lessons still need payment recorded.",
      href: `/app/clients/${clientId}?tab=billing#pay-as-you-go-lessons`,
      actionLabel: "Collect payment",
      tone: "warning",
      icon: CreditCard,
    });
  }

  if (accountBalance < 0) {
    issues.push({
      key: "balance",
      title: "Client has a balance owed",
      detail: "Review the client ledger and outstanding account charges.",
      href: `/app/clients/${clientId}?tab=billing`,
      actionLabel: "Open account",
      tone: "danger",
      icon: CreditCard,
    });
  }

  if (pendingRequiredDocumentCount > 0) {
    issues.push({
      key: "documents",
      title: `${pendingRequiredDocumentCount} required document${pendingRequiredDocumentCount === 1 ? "" : "s"} pending`,
      detail: "A waiver, agreement, or policy still needs completion.",
      href: `/app/clients/${clientId}?tab=documents`,
      actionLabel: "Review documents",
      tone: "warning",
      icon: FileSignature,
    });
  }

  if (portalStatus === "conflict") {
    issues.push({
      key: "portal-conflict",
      title: "Portal relationship conflict",
      detail: "Staff review is required before portal access can be completed.",
      href: `/app/clients/${clientId}?tab=portal`,
      actionLabel: "Resolve conflict",
      tone: "danger",
      icon: UserRoundCog,
    });
  } else if (portalStatus !== "linked" && portalStatus !== "former_client") {
    issues.push({
      key: "portal",
      title: "Portal access not connected",
      detail: "Invite or link the client account when portal access is appropriate.",
      href: `/app/clients/${clientId}?tab=portal`,
      actionLabel: "Manage portal",
      tone: "info",
      icon: UserRoundCog,
    });
  }

  if (!nextAppointmentAt && clientStatus === "active") {
    issues.push({
      key: "schedule",
      title: "No upcoming appointment",
      detail: "This active client has nothing currently scheduled.",
      href: `/app/schedule/new?clientId=${clientId}`,
      actionLabel: "Book next lesson",
      tone: "info",
      icon: CalendarPlus,
    });
  }

  if (activePackageCount === 0 && clientStatus === "active") {
    issues.push({
      key: "package",
      title: "No active package",
      detail: "Review whether this client needs a package or membership.",
      href: `/app/clients/${clientId}?tab=billing#quick-sale-payment`,
      actionLabel: "Review options",
      tone: "default",
      icon: PackageOpen,
    });
  }

  const visibleIssues = issues.slice(0, 4);

  const quickActions: ContextItem[] = [];

  if (canBook) {
    quickActions.push({
      key: "book",
      title: nextAppointmentAt ? "Book another lesson" : "Book next lesson",
      detail: nextAppointmentAt
        ? `Next appointment: ${fmtNextAppointment(nextAppointmentAt, studioTimeZone)}`
        : "No future appointment is currently scheduled.",
      href: `/app/schedule/new?clientId=${clientId}`,
      actionLabel: "Open scheduling",
      tone: nextAppointmentAt ? "success" : "info",
      icon: CalendarPlus,
    });
  }

  quickActions.push(
    {
      key: "payment",
      title: "Take payment or sell",
      detail: "Record a payment, sell a package, or apply account credit.",
      href: `/app/clients/${clientId}?tab=billing#quick-sale-payment`,
      actionLabel: "Open quick sale",
      tone: "default",
      icon: CreditCard,
    },
    {
      key: "documents-action",
      title: "Review documents",
      detail:
        pendingRequiredDocumentCount > 0
          ? `${pendingRequiredDocumentCount} required item${pendingRequiredDocumentCount === 1 ? "" : "s"} pending.`
          : "Required documents are currently complete.",
      href: `/app/clients/${clientId}?tab=documents`,
      actionLabel: "Open documents",
      tone: pendingRequiredDocumentCount > 0 ? "warning" : "success",
      icon: pendingRequiredDocumentCount > 0 ? FileSignature : CircleCheck,
    },
  );

  const visibleQuickActions = quickActions.slice(0, 3);

  return (
    <section
      aria-label="Client context and actions"
      className="rounded-3xl border border-violet-200/80 bg-[linear-gradient(135deg,#ffffff_0%,#faf5ff_52%,#fff7ed_100%)] p-4 shadow-[0_18px_50px_rgba(76,29,149,0.10)] sm:p-5"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-violet-700">
            Client context
          </p>
          <h2 className="mt-1 text-lg font-semibold text-[var(--brand-text)]">
            {visibleIssues.length > 0 ? "What needs attention" : "Relationship is in good standing"}
          </h2>
        </div>
        <span className="rounded-full bg-[linear-gradient(135deg,#ede9fe_0%,#ffedd5_100%)] px-3 py-1 text-xs font-semibold text-violet-800 ring-1 ring-violet-200">
          {activeTab.replaceAll("_", " ")}
        </span>
      </div>

      {visibleIssues.length > 0 ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {visibleIssues.map((item) => {
            const Icon = item.icon;
            const classes = toneClasses(item.tone);

            return (
              <Link
                key={item.key}
                href={item.href}
                className={`group rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:shadow-sm ${classes.card}`}
              >
                <div className="flex items-start gap-3">
                  <span className={`rounded-xl p-2 ring-1 ${classes.icon}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-semibold text-[var(--brand-text)]">
                      {item.title}
                    </span>
                    <span className="mt-1 block text-sm leading-5 text-[var(--brand-muted)]">
                      {item.detail}
                    </span>
                    <span className={`mt-3 block text-xs font-semibold ${classes.action}`}>
                      {item.actionLabel}
                    </span>
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <span className="rounded-xl bg-white p-2 text-emerald-700 ring-1 ring-emerald-200">
            <CircleCheck className="h-4 w-4" />
          </span>
          <div>
            <p className="font-semibold text-emerald-950">No immediate client risks</p>
            <p className="mt-1 text-sm leading-5 text-emerald-800">
              Billing, documents, portal status, scheduling, and active service coverage do not show an immediate exception.
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 border-t border-[var(--brand-border)] pt-4">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-muted)]">
          Quick actions
        </p>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          {visibleQuickActions.map((item) => {
            const Icon = item.icon;
            const classes = toneClasses(item.tone);

            return (
              <Link
                key={item.key}
                href={item.href}
                className="rounded-2xl border border-violet-100 bg-white/85 p-4 transition hover:-translate-y-0.5 hover:border-orange-200 hover:bg-white hover:shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <span className={`rounded-xl p-2 ring-1 ${classes.icon}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="font-semibold text-[var(--brand-text)]">
                    {item.title}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-5 text-[var(--brand-muted)]">
                  {item.detail}
                </p>
                <p className="mt-3 text-xs font-semibold text-[var(--brand-primary)]">
                  {item.actionLabel}
                </p>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
