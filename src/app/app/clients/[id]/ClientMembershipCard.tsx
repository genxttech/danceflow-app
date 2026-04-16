import Link from "next/link";

type MembershipPlanOption = {
  id: string;
  name: string;
  billing_interval: string;
  price: number;
  active: boolean;
};

type ActiveMembership = {
  id: string;
  membership_plan_id?: string | null;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  benefits?: unknown[];
};

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function membershipStatusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-blue-50 text-blue-700";
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "unpaid") return "bg-red-50 text-red-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-700";
  if (status === "expired") return "bg-slate-100 text-slate-700";
  if (status === "paused") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-700";
}

function getRenewalBadge(activeMembership: ActiveMembership) {
  if (activeMembership.cancel_at_period_end) {
    return {
      label: "Ending Soon",
      className: "bg-amber-50 text-amber-700",
    };
  }

  if (activeMembership.auto_renew) {
    return {
      label: "Auto Renew",
      className: "bg-green-50 text-green-700",
    };
  }

  return {
    label: "Manual Renewal",
    className: "bg-slate-100 text-slate-700",
  };
}

function getMembershipStateSummary(activeMembership: ActiveMembership) {
  if (activeMembership.status === "past_due") {
    return `Billing issue detected. Coverage is currently marked past due for the period ending ${formatDate(
      activeMembership.current_period_end
    )}.`;
  }

  if (activeMembership.status === "unpaid") {
    return `Billing is unpaid. Review payment collection and membership status immediately.`;
  }

  if (activeMembership.status === "pending") {
    return `Membership has been created and is awaiting final billing confirmation.`;
  }

  if (activeMembership.cancel_at_period_end) {
    return `Active through ${formatDate(
      activeMembership.ends_on ?? activeMembership.current_period_end
    )}. Renewal is turned off.`;
  }

  if (activeMembership.auto_renew) {
    return `Renews automatically after ${formatDate(
      activeMembership.current_period_end
    )}.`;
  }

  return `Does not auto renew after ${formatDate(
    activeMembership.current_period_end
  )}.`;
}

function getMembershipAlert(activeMembership: ActiveMembership) {
  if (activeMembership.status === "unpaid") {
    return {
      className: "border-red-200 bg-red-50 text-red-800",
      message:
        "This membership is unpaid. Review the payment status and billing details before scheduling around membership coverage.",
    };
  }

  if (activeMembership.status === "past_due") {
    return {
      className: "border-amber-200 bg-amber-50 text-amber-800",
      message:
        "This membership is past due. The subscription may need payment recovery or staff follow-up.",
    };
  }

  if (activeMembership.cancel_at_period_end) {
    return {
      className: "border-amber-200 bg-amber-50 text-amber-800",
      message: `This membership will stay active through ${formatDate(
        activeMembership.ends_on ?? activeMembership.current_period_end
      )} and then stop renewing.`,
    };
  }

  if (!activeMembership.auto_renew) {
    return {
      className: "border-slate-200 bg-slate-50 text-slate-700",
      message:
        "Auto-renew is off. This membership will not continue automatically beyond the current period.",
    };
  }

  return null;
}

export default function ClientMembershipCard({
  clientId,
  activeMembership,
  membershipPlans,
}: {
  clientId: string;
  activeMembership: ActiveMembership | null;
  membershipPlans: MembershipPlanOption[];
}) {
  const selectablePlans = membershipPlans.filter((plan) => plan.active);
  const activeBenefitCount = activeMembership?.benefits?.length ?? 0;
  const renewalBadge = activeMembership ? getRenewalBadge(activeMembership) : null;
  const membershipAlert = activeMembership
    ? getMembershipAlert(activeMembership)
    : null;

  return (
    <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,rgba(255,255,255,0.94)_0%,rgba(255,249,243,0.98)_100%)] p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
            Recurring Revenue
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h3 className="text-2xl font-semibold text-[var(--brand-text)]">
              Membership
            </h3>

            {activeMembership ? (
              <span
                className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${membershipStatusBadgeClass(
                  activeMembership.status
                )}`}
              >
                {activeMembership.status.replaceAll("_", " ")}
              </span>
            ) : (
              <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                No Active Membership
              </span>
            )}
          </div>

          <p className="mt-2 text-sm text-slate-600">
            Review the client’s recurring membership and billing state.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/memberships/sell"
            className="rounded-2xl border border-[var(--brand-primary)]/25 bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
          >
            Sell Membership
          </Link>

          <Link
            href="/app/memberships"
            className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
          >
            Manage Plans
          </Link>
        </div>
      </div>

      {activeMembership ? (
        <div className="mt-6 space-y-5">
          <div className="rounded-[28px] border border-[var(--brand-border)] bg-white/90 p-5 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-lg font-semibold text-[var(--brand-text)]">
                    {activeMembership.name_snapshot}
                  </p>

                  {renewalBadge ? (
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${renewalBadge.className}`}
                    >
                      {renewalBadge.label}
                    </span>
                  ) : null}
                </div>

                <p className="mt-2 text-sm text-slate-600">
                  {getMembershipStateSummary(activeMembership)}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 text-right">
                <p className="text-sm text-slate-500">Billing</p>
                <p className="mt-1 font-semibold text-[var(--brand-text)]">
                  {formatCurrency(activeMembership.price_snapshot)} /{" "}
                  {billingIntervalLabel(activeMembership.billing_interval_snapshot)}
                </p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Current Period</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {formatDate(activeMembership.current_period_start)} –{" "}
                  {formatDate(activeMembership.current_period_end)}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Started</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {formatDate(activeMembership.starts_on)}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Ends / Renews</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {activeMembership.cancel_at_period_end
                    ? formatDate(
                        activeMembership.ends_on ?? activeMembership.current_period_end
                      )
                    : formatDate(activeMembership.current_period_end)}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Benefits</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {activeBenefitCount}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Auto Renew</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {activeMembership.auto_renew ? "On" : "Off"}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Cancel at Period End</p>
                <p className="mt-1 font-medium text-[var(--brand-text)]">
                  {activeMembership.cancel_at_period_end ? "Yes" : "No"}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Status</p>
                <p className="mt-1 font-medium capitalize text-[var(--brand-text)]">
                  {activeMembership.status.replaceAll("_", " ")}
                </p>
              </div>
            </div>

            {membershipAlert ? (
              <div
                className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${membershipAlert.className}`}
              >
                {membershipAlert.message}
              </div>
            ) : null}
          </div>

          {activeBenefitCount > 0 ? (
            <div className="rounded-2xl border border-[var(--brand-border)] bg-white/80 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-[var(--brand-text)]">
                    Included Benefits
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    This membership has {activeBenefitCount} configured benefit
                    {activeBenefitCount === 1 ? "" : "s"}.
                  </p>
                </div>

                <Link
                  href={`/app/memberships/${activeMembership.membership_plan_id ?? ""}`}
                  className="text-sm underline"
                >
                  View Plan
                </Link>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <div className="mt-6 rounded-2xl border border-dashed border-[var(--brand-border)] bg-white/60 px-4 py-8 text-center text-slate-500">
            No active membership assigned.
          </div>

          <div className="mt-6 rounded-[28px] border border-[var(--brand-border)] bg-white/85 p-5 shadow-sm">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h4 className="text-base font-semibold text-[var(--brand-text)]">
                  Membership Options
                </h4>
                <p className="mt-1 text-sm text-slate-600">
                  Use the sales flow to charge the first cycle, save the card on file,
                  and start recurring billing.
                </p>
              </div>

              <Link
                href="/app/memberships/sell"
                className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
              >
                Open Sales Page
              </Link>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {selectablePlans.length === 0 ? (
                <p className="text-sm text-slate-500">No active membership plans found.</p>
              ) : (
                selectablePlans.map((plan) => (
                  <div
                    key={plan.id}
                    className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4"
                  >
                    <p className="font-medium text-[var(--brand-text)]">{plan.name}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {formatCurrency(plan.price)} /{" "}
                      {billingIntervalLabel(plan.billing_interval)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}