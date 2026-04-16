import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type SearchParams = Promise<{
  status?: string;
}>;

type MembershipPlanRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  visibility: string;
  auto_renew_default: boolean;
  membership_plan_benefits:
    | { id: string }[]
    | { id: string }
    | null;
};

type ClientMembershipRow = {
  id: string;
  client_id: string;
  membership_plan_id: string | null;
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
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
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

function visibilityLabel(value: string) {
  if (value === "public") return "Public";
  if (value === "private") return "Private";
  return value;
}

function activeBadgeClass(active: boolean) {
  return active
    ? "bg-green-50 text-green-700"
    : "bg-slate-100 text-slate-700";
}

function membershipStatusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "pending") return "bg-blue-50 text-blue-700";
  if (status === "past_due") return "bg-amber-50 text-amber-700";
  if (status === "unpaid") return "bg-red-50 text-red-700";
  if (status === "cancelled") return "bg-slate-100 text-slate-700";
  return "bg-slate-100 text-slate-700";
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown Client";
}

function getBenefitCount(
  value:
    | { id: string }[]
    | { id: string }
    | null
) {
  if (!value) return 0;
  return Array.isArray(value) ? value.length : 1;
}

function filterChipClass(active: boolean) {
  return active
    ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent-dark)] border-[var(--brand-accent-dark)]/15"
    : "bg-white text-slate-700 border-[var(--brand-border)] hover:bg-slate-50";
}

export default async function MembershipPlansPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const statusFilter = params.status ?? "all";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: plans, error: plansError },
    { data: memberships, error: membershipsError },
  ] = await Promise.all([
    supabase
      .from("membership_plans")
      .select(`
        id,
        name,
        description,
        active,
        billing_interval,
        price,
        signup_fee,
        visibility,
        auto_renew_default,
        membership_plan_benefits ( id )
      `)
      .eq("studio_id", studioId)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("client_memberships")
      .select(`
        id,
        client_id,
        membership_plan_id,
        status,
        starts_on,
        ends_on,
        current_period_start,
        current_period_end,
        auto_renew,
        cancel_at_period_end,
        name_snapshot,
        price_snapshot,
        billing_interval_snapshot,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid", "cancelled"])
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (plansError) {
    throw new Error(`Failed to load membership plans: ${plansError.message}`);
  }

  if (membershipsError) {
    throw new Error(`Failed to load client memberships: ${membershipsError.message}`);
  }

  const typedPlans = (plans ?? []) as MembershipPlanRow[];
  const typedMemberships = (memberships ?? []) as ClientMembershipRow[];

  const activeMemberships = typedMemberships.filter((m) => m.status === "active");
  const cancelingMemberships = typedMemberships.filter(
    (m) => m.status === "active" && m.cancel_at_period_end
  );
  const pastDueMemberships = typedMemberships.filter((m) => m.status === "past_due");
  const unpaidMemberships = typedMemberships.filter((m) => m.status === "unpaid");
  const pendingMemberships = typedMemberships.filter((m) => m.status === "pending");

  const filteredMemberships = typedMemberships.filter((membership) => {
    if (statusFilter === "all") return true;
    if (statusFilter === "canceling") {
      return membership.status === "active" && membership.cancel_at_period_end;
    }
    return membership.status === statusFilter;
  });

  return (
    <div className="space-y-8">
      <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,rgba(255,255,255,0.96)_0%,rgba(255,249,243,0.98)_100%)] p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-accent-dark)]">
              Membership Operations
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-[var(--brand-text)] sm:text-4xl">
              Memberships
            </h1>
            <p className="mt-3 max-w-2xl text-sm text-slate-600">
              Review active member billing states, track delinquency, and manage plan configuration from one place.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/memberships/sell"
              className="rounded-2xl bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] px-4 py-2 text-white hover:brightness-105"
            >
              Sell Membership
            </Link>
            <Link
              href="/app/memberships/new"
              className="rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-2 hover:bg-[var(--brand-primary-soft)]"
            >
              New Plan
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Plans</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {typedPlans.length}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {activeMemberships.length}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Canceling</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {cancelingMemberships.length}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Past Due</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {pastDueMemberships.length}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Unpaid</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {unpaidMemberships.length}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Client Memberships
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Filter by billing state to spot healthy, canceling, and delinquent memberships quickly.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              href="/app/memberships?status=all"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "all"
              )}`}
            >
              All
            </Link>
            <Link
              href="/app/memberships?status=active"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "active"
              )}`}
            >
              Active
            </Link>
            <Link
              href="/app/memberships?status=canceling"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "canceling"
              )}`}
            >
              Canceling
            </Link>
            <Link
              href="/app/memberships?status=past_due"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "past_due"
              )}`}
            >
              Past Due
            </Link>
            <Link
              href="/app/memberships?status=unpaid"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "unpaid"
              )}`}
            >
              Unpaid
            </Link>
            <Link
              href="/app/memberships?status=pending"
              className={`rounded-full border px-3 py-2 text-sm font-medium ${filterChipClass(
                statusFilter === "pending"
              )}`}
            >
              Pending
            </Link>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {filteredMemberships.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-500">
              No memberships match this filter.
            </div>
          ) : (
            filteredMemberships.map((membership) => (
              <Link
                key={membership.id}
                href={`/app/clients/${membership.client_id}`}
                className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-[var(--brand-text)]">
                        {getClientName(membership.clients)}
                      </p>

                      <span
                        className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${membershipStatusBadgeClass(
                          membership.status
                        )}`}
                      >
                        {membership.status.replaceAll("_", " ")}
                      </span>

                      {membership.cancel_at_period_end ? (
                        <span className="inline-flex rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700">
                          Canceling
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-1 text-sm text-slate-600">
                      {membership.name_snapshot} • {formatCurrency(membership.price_snapshot)} /{" "}
                      {billingIntervalLabel(membership.billing_interval_snapshot)}
                    </p>

                    <p className="mt-1 text-sm text-slate-500">
                      Current period: {formatDate(membership.current_period_start)} –{" "}
                      {formatDate(membership.current_period_end)}
                    </p>

                    <p className="mt-1 text-sm text-slate-500">
                      Renewal:{" "}
                      {membership.cancel_at_period_end
                        ? `Ends ${formatDate(membership.ends_on ?? membership.current_period_end)}`
                        : membership.auto_renew
                          ? "Auto-renew on"
                          : "Manual / not renewing"}
                    </p>
                  </div>

                  <span className="text-sm underline">Open Client</span>
                </div>
              </Link>
            ))
          )}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-semibold text-[var(--brand-text)]">
                Membership Plans
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Configure the products staff can sell from the front desk.
              </p>
            </div>

            <Link href="/app/memberships/new" className="text-sm underline">
              Create Plan
            </Link>
          </div>

          <div className="mt-5 space-y-3">
            {typedPlans.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-500">
                No membership plans created yet.
              </div>
            ) : (
              typedPlans.map((plan) => (
                <Link
                  key={plan.id}
                  href={`/app/memberships/${plan.id}`}
                  className="block rounded-xl bg-slate-50 p-4 hover:bg-slate-100"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium text-[var(--brand-text)]">{plan.name}</p>
                        <span
                          className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${activeBadgeClass(
                            plan.active
                          )}`}
                        >
                          {plan.active ? "Active" : "Inactive"}
                        </span>
                      </div>

                      {plan.description ? (
                        <p className="mt-1 text-sm text-slate-600">{plan.description}</p>
                      ) : null}

                      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm text-slate-500">
                        <span>
                          {formatCurrency(plan.price)} /{" "}
                          {billingIntervalLabel(plan.billing_interval)}
                        </span>
                        <span>Signup Fee: {formatCurrency(plan.signup_fee)}</span>
                        <span>{visibilityLabel(plan.visibility)}</span>
                        <span>
                          Auto Renew Default: {plan.auto_renew_default ? "Yes" : "No"}
                        </span>
                        <span>Benefits: {getBenefitCount(plan.membership_plan_benefits)}</span>
                      </div>
                    </div>

                    <span className="text-sm underline">View</span>
                  </div>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Quick Actions
            </h2>
            <div className="mt-5 grid gap-3">
              <Link
                href="/app/memberships/sell"
                className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
              >
                Sell Membership
              </Link>
              <Link
                href="/app/payments"
                className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
              >
                Review Payments
              </Link>
              <Link
                href="/app/clients"
                className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
              >
                Find Client
              </Link>
              <Link
                href="/app/memberships/new"
                className="rounded-xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3 hover:bg-white"
              >
                New Membership Plan
              </Link>
            </div>
          </div>

          <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Billing Snapshot
            </h2>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Pending</p>
                <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                  {pendingMemberships.length}
                </p>
              </div>

              <div className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] p-4">
                <p className="text-sm text-slate-500">Delinquent</p>
                <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
                  {pastDueMemberships.length + unpaidMemberships.length}
                </p>
              </div>
            </div>

            <p className="mt-4 text-sm text-slate-600">
              Use the filter chips above to jump directly into memberships that need staff attention.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}