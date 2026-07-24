import Link from "next/link";
import {
  ArrowRight,
  BadgeDollarSign,
  CircleAlert,
  CreditCard,
  Layers3,
  RefreshCw,
} from "lucide-react";

type DetailRow = {
  label: string;
  value: string;
  helper?: string;
  warning?: boolean;
};

function WorkspaceCard({
  eyebrow,
  title,
  description,
  icon: Icon,
  headline,
  headlineLabel,
  rows,
  primaryAction,
  secondaryAction,
  tone,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: typeof CreditCard;
  headline: string;
  headlineLabel: string;
  rows: DetailRow[];
  primaryAction: { href: string; label: string };
  secondaryAction?: { href: string; label: string };
  tone: "violet" | "orange" | "blue";
}) {
  const toneClasses =
    tone === "orange"
      ? "border-orange-200 bg-[linear-gradient(145deg,#fff7ed_0%,#ffffff_70%)]"
      : tone === "blue"
        ? "border-blue-200 bg-[linear-gradient(145deg,#eff6ff_0%,#ffffff_70%)]"
        : "border-violet-200 bg-[linear-gradient(145deg,#faf5ff_0%,#ffffff_70%)]";
  const iconClasses =
    tone === "orange"
      ? "bg-orange-100 text-orange-700"
      : tone === "blue"
        ? "bg-blue-100 text-blue-700"
        : "bg-violet-100 text-violet-700";

  return (
    <article className={`rounded-[28px] border p-5 shadow-sm ${toneClasses}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.17em] text-slate-500">
            {eyebrow}
          </p>
          <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
            {title}
          </h2>
        </div>
        <span className={`inline-flex h-11 w-11 items-center justify-center rounded-2xl ${iconClasses}`}>
          <Icon className="h-5 w-5" />
        </span>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>

      <div className="mt-5 rounded-2xl border border-white/80 bg-white/90 p-4 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.13em] text-slate-500">
          {headlineLabel}
        </p>
        <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          {headline}
        </p>
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((row) => (
          <div
            key={row.label}
            className={`flex items-start justify-between gap-4 rounded-2xl border px-4 py-3 ${
              row.warning
                ? "border-amber-200 bg-amber-50"
                : "border-white/80 bg-white/75"
            }`}
          >
            <div>
              <p className="text-sm font-medium text-slate-700">{row.label}</p>
              {row.helper ? (
                <p className="mt-1 text-xs leading-5 text-slate-500">{row.helper}</p>
              ) : null}
            </div>
            <p className={`shrink-0 text-sm font-semibold ${row.warning ? "text-amber-900" : "text-slate-950"}`}>
              {row.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        <Link
          href={primaryAction.href}
          className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          {primaryAction.label}
          <ArrowRight className="h-4 w-4" />
        </Link>
        {secondaryAction ? (
          <Link
            href={secondaryAction.href}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50"
          >
            {secondaryAction.label}
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export default function FinancialObligationsWorkspace({
  payoutTotal,
  payoutCount,
  unmatchedPayoutItems,
  failedPayouts,
  packageOutstandingValue,
  packageRemainingCredits,
  lowOrZeroCreditPackages,
  failedPackagePayments,
  membershipMrr,
  activeMemberships,
  pendingMemberships,
  endingMemberships,
  failedMembershipPayments,
}: {
  payoutTotal: string;
  payoutCount: string;
  unmatchedPayoutItems: number;
  failedPayouts: number;
  packageOutstandingValue: string;
  packageRemainingCredits: string;
  lowOrZeroCreditPackages: number;
  failedPackagePayments: number;
  membershipMrr: string;
  activeMemberships: number;
  pendingMemberships: number;
  endingMemberships: number;
  failedMembershipPayments: number;
}) {
  const payoutNeedsAttention = unmatchedPayoutItems > 0 || failedPayouts > 0;
  const packageNeedsAttention = lowOrZeroCreditPackages > 0 || failedPackagePayments > 0;
  const membershipNeedsAttention = pendingMemberships > 0 || endingMemberships > 0 || failedMembershipPayments > 0;

  return (
    <section aria-labelledby="financial-obligations-title" className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
            Financial obligations
          </p>
          <h2 id="financial-obligations-title" className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
            Reconcile cash, credits, and recurring commitments
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Focus first on exceptions that can distort the period close: unmatched payouts,
            unused package obligations, and memberships needing billing or renewal attention.
          </p>
        </div>
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm">
          <CircleAlert className="h-4 w-4 text-orange-600" />
          Exceptions before detail
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <WorkspaceCard
          eyebrow="Cash reconciliation"
          title="Stripe payouts"
          description="Confirm deposited cash matches the payment records DanceFlow can trace back to studio activity."
          icon={BadgeDollarSign}
          headline={unmatchedPayoutItems.toLocaleString()}
          headlineLabel="Unmatched payout items"
          tone="blue"
          rows={[
            { label: "Payout total", value: payoutTotal },
            { label: "Payouts in range", value: payoutCount },
            { label: "Failed payouts", value: failedPayouts.toLocaleString(), warning: failedPayouts > 0 },
            {
              label: "Close status",
              value: payoutNeedsAttention ? "Needs review" : "Reconciled",
              warning: payoutNeedsAttention,
            },
          ]}
          primaryAction={{ href: "#payouts", label: "Review reconciliation" }}
          secondaryAction={{ href: "#exports", label: "Export payout detail" }}
        />

        <WorkspaceCard
          eyebrow="Prepaid obligation"
          title="Package credits"
          description="Unused prepaid lessons are a delivery obligation, not new cash. Watch credit balances before they accumulate."
          icon={Layers3}
          headline={packageOutstandingValue}
          headlineLabel="Outstanding credit value"
          tone="violet"
          rows={[
            { label: "Credits remaining", value: packageRemainingCredits },
            {
              label: "Low or zero credit packages",
              value: lowOrZeroCreditPackages.toLocaleString(),
              warning: lowOrZeroCreditPackages > 0,
            },
            {
              label: "Failed package payments",
              value: failedPackagePayments.toLocaleString(),
              warning: failedPackagePayments > 0,
            },
            {
              label: "Attention status",
              value: packageNeedsAttention ? "Follow up" : "Healthy",
              warning: packageNeedsAttention,
            },
          ]}
          primaryAction={{ href: "#packages", label: "Review package liability" }}
          secondaryAction={{ href: "/app/packages/client-balances", label: "Open client balances" }}
        />

        <WorkspaceCard
          eyebrow="Recurring revenue"
          title="Membership health"
          description="Separate dependable recurring revenue from memberships that are pending, ending, or failing payment."
          icon={RefreshCw}
          headline={membershipMrr}
          headlineLabel="Monthly recurring revenue preview"
          tone="orange"
          rows={[
            { label: "Active memberships", value: activeMemberships.toLocaleString() },
            {
              label: "Pending billing",
              value: pendingMemberships.toLocaleString(),
              warning: pendingMemberships > 0,
            },
            {
              label: "Ending at period close",
              value: endingMemberships.toLocaleString(),
              warning: endingMemberships > 0,
            },
            {
              label: "Failed payments",
              value: failedMembershipPayments.toLocaleString(),
              warning: failedMembershipPayments > 0,
            },
            {
              label: "Revenue status",
              value: membershipNeedsAttention ? "Needs attention" : "Stable",
              warning: membershipNeedsAttention,
            },
          ]}
          primaryAction={{ href: "#memberships", label: "Review membership health" }}
          secondaryAction={{ href: "/app/memberships", label: "Manage memberships" }}
        />
      </div>
    </section>
  );
}
