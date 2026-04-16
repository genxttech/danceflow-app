import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type Params = Promise<{
  id: string;
}>;

type MembershipPlanRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean;
  visibility: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type BenefitRow = {
  id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
  sort_order: number;
};

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
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

function usagePeriodLabel(value: string) {
  if (value === "billing_cycle") return "Per Billing Cycle";
  if (value === "monthly") return "Per Month";
  if (value === "unlimited") return "Unlimited";
  return value;
}

function benefitTypeLabel(value: string) {
  if (value === "unlimited_group_classes") return "Unlimited Group Classes";
  if (value === "unlimited_practice_parties") return "Unlimited Practice Parties";
  if (value === "included_private_lessons") return "Included Private Lessons";
  if (value === "event_discount_percent") return "Event Discount Percent";
  if (value === "floor_rental_discount_percent") return "Floor Rental Discount Percent";
  return value.replaceAll("_", " ");
}

function benefitSummary(benefit: BenefitRow) {
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

export default async function MembershipPlanDetailPage({
  params,
}: {
  params: Params;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const [
    { data: plan, error: planError },
    { data: benefits, error: benefitsError },
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
        auto_renew_default,
        visibility,
        sort_order,
        created_at,
        updated_at
      `)
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
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
      .eq("membership_plan_id", id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (planError || !plan) {
    notFound();
  }

  if (benefitsError) {
    throw new Error(`Failed to load membership benefits: ${benefitsError.message}`);
  }

  const typedPlan = plan as MembershipPlanRow;
  const typedBenefits = (benefits ?? []) as BenefitRow[];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-3xl font-semibold tracking-tight">
              {typedPlan.name}
            </h2>

            <span
              className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${activeBadgeClass(
                typedPlan.active
              )}`}
            >
              {typedPlan.active ? "Active" : "Inactive"}
            </span>

            <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
              {visibilityLabel(typedPlan.visibility)}
            </span>
          </div>

          <p className="mt-2 text-slate-600">
            {typedPlan.description || "No description provided."}
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/memberships"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Memberships
          </Link>

          <Link
            href={`/app/memberships/${typedPlan.id}/edit`}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
          >
            Edit Plan
          </Link>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Price</p>
          <p className="mt-2 text-3xl font-semibold">
            {formatCurrency(typedPlan.price)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Billing Interval</p>
          <p className="mt-2 text-2xl font-semibold">
            {billingIntervalLabel(typedPlan.billing_interval)}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Signup Fee</p>
          <p className="mt-2 text-2xl font-semibold">
            {typedPlan.signup_fee ? formatCurrency(typedPlan.signup_fee) : "None"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Benefits</p>
          <p className="mt-2 text-3xl font-semibold">{typedBenefits.length}</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white shadow-sm">
            <div className="border-b px-6 py-4">
              <h3 className="text-lg font-semibold text-slate-900">
                Membership Benefits
              </h3>
            </div>

            {typedBenefits.length === 0 ? (
              <div className="px-6 py-10 text-center text-slate-500">
                No benefits configured yet.
              </div>
            ) : (
              <div className="divide-y">
                {typedBenefits.map((benefit) => (
                  <div key={benefit.id} className="px-6 py-5">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <h4 className="font-semibold text-slate-900">
                          {benefitTypeLabel(benefit.benefit_type)}
                        </h4>

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
                            Quantity: <span className="font-medium text-slate-900">{benefit.quantity}</span>
                          </p>
                        ) : null}

                        {benefit.discount_percent != null ? (
                          <p className="text-sm text-slate-600">
                            Discount: <span className="font-medium text-slate-900">{benefit.discount_percent}%</span>
                          </p>
                        ) : null}

                        {benefit.discount_amount != null ? (
                          <p className="text-sm text-slate-600">
                            Discount: <span className="font-medium text-slate-900">{formatCurrency(benefit.discount_amount)}</span>
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
            <h3 className="text-lg font-semibold text-slate-900">
              Plan Details
            </h3>

            <div className="mt-5 space-y-4">
              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Visibility</p>
                <p className="mt-1 font-medium text-slate-900">
                  {visibilityLabel(typedPlan.visibility)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Auto Renew Default</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedPlan.auto_renew_default ? "On" : "Off"}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Sort Order</p>
                <p className="mt-1 font-medium text-slate-900">
                  {typedPlan.sort_order}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Created</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedPlan.created_at)}
                </p>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4">
                <p className="text-sm text-slate-500">Last Updated</p>
                <p className="mt-1 font-medium text-slate-900">
                  {formatDateTime(typedPlan.updated_at)}
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-lg font-semibold text-slate-900">
              Next Steps
            </h3>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/app/memberships/${typedPlan.id}/edit`}
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Edit Membership Plan
              </Link>

              <Link
                href="/app/clients"
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Assign to Client
              </Link>

              <Link
                href="/app/memberships"
                className="rounded-xl border px-4 py-3 hover:bg-slate-50"
              >
                Back to Membership List
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}