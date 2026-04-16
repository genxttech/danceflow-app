import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

type Params = Promise<{
  studioSlug: string;
}>;

type ActiveMembership = {
  id: string;
  membership_plan_id: string;
  status: string;
  starts_on: string;
  ends_on: string | null;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
  name_snapshot: string;
  description_snapshot: string | null;
  price_snapshot: number;
  signup_fee_snapshot: number | null;
  billing_interval_snapshot: string;
};

type MembershipBenefit = {
  id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
  sort_order: number;
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function usagePeriodLabel(value: string) {
  if (value === "billing_cycle") return "Per Billing Cycle";
  if (value === "monthly") return "Per Month";
  if (value === "unlimited") return "Unlimited";
  return value;
}

function statusBadgeClass(status: string) {
  if (status === "active") return "bg-green-50 text-green-700";
  if (status === "paused") return "bg-amber-50 text-amber-700";
  if (status === "cancelled") return "bg-red-50 text-red-700";
  if (status === "expired") return "bg-slate-100 text-slate-700";
  if (status === "pending") return "bg-blue-50 text-blue-700";
  return "bg-slate-100 text-slate-700";
}

function benefitTypeLabel(value: string) {
  if (value === "unlimited_group_classes") return "Unlimited Group Classes";
  if (value === "unlimited_practice_parties") return "Unlimited Practice Parties";
  if (value === "included_private_lessons") return "Included Private Lessons";
  if (value === "event_discount_percent") return "Event Discount Percent";
  if (value === "floor_rental_discount_percent") return "Floor Rental Discount Percent";
  return value.replaceAll("_", " ");
}

function benefitSummary(benefit: MembershipBenefit) {
  if (benefit.benefit_type === "included_private_lessons") {
    return benefit.quantity != null
      ? `${benefit.quantity} included`
      : "Included benefit";
  }

  if (
    benefit.benefit_type === "event_discount_percent" ||
    benefit.benefit_type === "floor_rental_discount_percent"
  ) {
    if (benefit.discount_percent != null) {
      return `${benefit.discount_percent}% discount`;
    }

    if (benefit.discount_amount != null) {
      return `${formatCurrency(benefit.discount_amount)} discount`;
    }

    return "Discount benefit";
  }

  if (
    benefit.benefit_type === "unlimited_group_classes" ||
    benefit.benefit_type === "unlimited_practice_parties"
  ) {
    return "Unlimited access";
  }

  if (benefit.quantity != null) {
    return `${benefit.quantity}`;
  }

  return "Configured benefit";
}

export default async function PortalMembershipPage({
  params,
}: {
  params: Params;
}) {
  const { studioSlug } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select("id, name, slug")
    .eq("slug", studioSlug)
    .single();

  if (studioError || !studio) {
    redirect("/login");
  }

  const { data: client, error: clientError } = await supabase
    .from("clients")
    .select(`
      id,
      first_name,
      last_name,
      is_independent_instructor
    `)
    .eq("studio_id", studio.id)
    .eq("portal_user_id", user.id)
    .single();

  if (clientError || !client || !client.is_independent_instructor) {
    redirect(`/login?studio=${encodeURIComponent(studioSlug)}`);
  }

  const { data: activeMembership, error: membershipError } = await supabase
    .from("client_memberships")
    .select(`
      id,
      membership_plan_id,
      status,
      starts_on,
      ends_on,
      current_period_start,
      current_period_end,
      auto_renew,
      cancel_at_period_end,
      name_snapshot,
      description_snapshot,
      price_snapshot,
      signup_fee_snapshot,
      billing_interval_snapshot
    `)
    .eq("studio_id", studio.id)
    .eq("client_id", client.id)
    .eq("status", "active")
    .maybeSingle();

  if (membershipError) {
    throw new Error(`Failed to load membership: ${membershipError.message}`);
  }

  const membership = (activeMembership ?? null) as ActiveMembership | null;

  let benefits: MembershipBenefit[] = [];

  if (membership?.membership_plan_id) {
    const { data: benefitRows, error: benefitsError } = await supabase
      .from("membership_plan_benefits")
      .select(`
        id,
        benefit_type,
        quantity,
        discount_percent,
        discount_amount,
        usage_period,
        applies_to,
        sort_order
      `)
      .eq("membership_plan_id", membership.membership_plan_id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });

    if (benefitsError) {
      throw new Error(`Failed to load membership benefits: ${benefitsError.message}`);
    }

    benefits = (benefitRows ?? []) as MembershipBenefit[];
  }

  const fullName = `${client.first_name} ${client.last_name}`.trim();

  return (
    <div className="space-y-8">
      <div className="rounded-3xl border bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">{studio.name}</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-900">
              My Membership
            </h1>
            <p className="mt-2 text-slate-600">
              Review your current membership status, billing cycle, and included benefits.
            </p>
            <p className="mt-2 text-sm text-slate-500">Signed in as {fullName}</p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/portal/${encodeURIComponent(studio.slug)}`}
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Back to Portal
            </Link>

            <Link
              href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
            >
              Book Floor Space
            </Link>
          </div>
        </div>
      </div>

      {!membership ? (
        <div className="rounded-2xl border bg-white p-8 text-center shadow-sm">
          <p className="text-lg font-medium text-slate-900">No active membership</p>
          <p className="mt-2 text-sm text-slate-500">
            Your studio has not assigned an active membership to this account yet.
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <div className="rounded-2xl border bg-white p-5">
              <p className="text-sm text-slate-500">Membership</p>
              <p className="mt-2 text-xl font-semibold">{membership.name_snapshot}</p>
            </div>

            <div className="rounded-2xl border bg-white p-5">
              <p className="text-sm text-slate-500">Status</p>
              <p className="mt-2">
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${statusBadgeClass(
                    membership.status
                  )}`}
                >
                  {membership.status}
                </span>
              </p>
            </div>

            <div className="rounded-2xl border bg-white p-5">
              <p className="text-sm text-slate-500">Billing</p>
              <p className="mt-2 text-xl font-semibold">
                {formatCurrency(membership.price_snapshot)}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                {billingIntervalLabel(membership.billing_interval_snapshot)}
              </p>
            </div>

            <div className="rounded-2xl border bg-white p-5">
              <p className="text-sm text-slate-500">Current Period Ends</p>
              <p className="mt-2 text-xl font-semibold">
                {formatDate(membership.current_period_end)}
              </p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-6">
              <div className="rounded-2xl border bg-white p-6 shadow-sm">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-semibold text-slate-900">
                    {membership.name_snapshot}
                  </h2>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusBadgeClass(
                      membership.status
                    )}`}
                  >
                    {membership.status}
                  </span>
                </div>

                {membership.description_snapshot ? (
                  <p className="mt-3 text-slate-600">{membership.description_snapshot}</p>
                ) : null}

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Started</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {formatDate(membership.starts_on)}
                    </p>
                  </div>

                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Ends</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {formatDate(membership.ends_on)}
                    </p>
                  </div>

                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Current Period</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {formatDate(membership.current_period_start)} –{" "}
                      {formatDate(membership.current_period_end)}
                    </p>
                  </div>

                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Renewal</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {membership.auto_renew ? "Auto renew on" : "Auto renew off"}
                    </p>
                    <p className="mt-1 text-sm text-slate-500">
                      Cancel at period end: {membership.cancel_at_period_end ? "Yes" : "No"}
                    </p>
                  </div>

                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Price</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {formatCurrency(membership.price_snapshot)} /{" "}
                      {billingIntervalLabel(membership.billing_interval_snapshot)}
                    </p>
                  </div>

                  <div className="rounded-xl border bg-slate-50 p-4">
                    <p className="text-sm text-slate-500">Signup Fee</p>
                    <p className="mt-1 font-medium text-slate-900">
                      {membership.signup_fee_snapshot != null
                        ? formatCurrency(membership.signup_fee_snapshot)
                        : "None"}
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border bg-white shadow-sm">
                <div className="border-b px-6 py-4">
                  <h2 className="text-xl font-semibold text-slate-900">
                    Included Benefits
                  </h2>
                </div>

                {benefits.length === 0 ? (
                  <div className="px-6 py-10 text-center text-slate-500">
                    No benefits listed for this membership.
                  </div>
                ) : (
                  <div className="divide-y">
                    {benefits.map((benefit) => (
                      <div key={benefit.id} className="px-6 py-5">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div>
                            <h3 className="font-semibold text-slate-900">
                              {benefitTypeLabel(benefit.benefit_type)}
                            </h3>
                            <p className="mt-1 text-sm text-slate-600">
                              {benefitSummary(benefit)}
                            </p>

                            <div className="mt-3 flex flex-wrap gap-3 text-sm text-slate-500">
                              <span>{usagePeriodLabel(benefit.usage_period)}</span>
                              {benefit.applies_to ? (
                                <span>Applies to: {benefit.applies_to}</span>
                              ) : null}
                            </div>
                          </div>

                          <div className="text-left lg:text-right">
                            {benefit.quantity != null ? (
                              <p className="text-sm text-slate-600">
                                Quantity:{" "}
                                <span className="font-medium text-slate-900">
                                  {benefit.quantity}
                                </span>
                              </p>
                            ) : null}

                            {benefit.discount_percent != null ? (
                              <p className="text-sm text-slate-600">
                                Discount:{" "}
                                <span className="font-medium text-slate-900">
                                  {benefit.discount_percent}%
                                </span>
                              </p>
                            ) : null}

                            {benefit.discount_amount != null ? (
                              <p className="text-sm text-slate-600">
                                Discount:{" "}
                                <span className="font-medium text-slate-900">
                                  {formatCurrency(benefit.discount_amount)}
                                </span>
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-6">
              <div className="rounded-2xl border bg-white p-6 shadow-sm">
                <h2 className="text-xl font-semibold">Quick Links</h2>

                <div className="mt-5 grid gap-3">
                  <Link
                    href={`/portal/${encodeURIComponent(studio.slug)}`}
                    className="rounded-xl border px-4 py-3 hover:bg-slate-50"
                  >
                    Portal Home
                  </Link>

                  <Link
                    href={`/portal/${encodeURIComponent(studio.slug)}/floor-space`}
                    className="rounded-xl border px-4 py-3 hover:bg-slate-50"
                  >
                    Book Floor Space
                  </Link>

                  <Link
                    href={`/portal/${encodeURIComponent(
                      studio.slug
                    )}/floor-space/my-rentals`}
                    className="rounded-xl border px-4 py-3 hover:bg-slate-50"
                  >
                    My Rentals
                  </Link>

                  <Link
                    href={`/portal/${encodeURIComponent(studio.slug)}/profile`}
                    className="rounded-xl border px-4 py-3 hover:bg-slate-50"
                  >
                    My Profile
                  </Link>
                </div>
              </div>

              <div className="rounded-2xl border bg-white p-6 shadow-sm">
                <h2 className="text-xl font-semibold">Membership Notes</h2>

                <ul className="mt-4 space-y-2 text-sm text-slate-600">
                  <li>Membership details shown here are assigned by your studio.</li>
                  <li>Benefits may apply to classes, events, or floor rentals depending on the plan.</li>
                  <li>Contact the studio for billing or membership changes.</li>
                </ul>

                <form action="/auth/logout" method="post" className="mt-6">
                  <button
                    type="submit"
                    className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
                  >
                    Log Out
                  </button>
                </form>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}