import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  archiveMembershipPlanAction,
  deleteMembershipPlanAction,
  reactivateMembershipPlanAction,
} from "../actions";

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

function clientPortalLabel(value: string) {
  if (value === "public") return "Shown in client portal";
  if (value === "private") return "Hidden from client portal";
  return value;
}

function activeBadgeClass(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

function portalBadgeClass(value: string) {
  return value === "public"
    ? "bg-violet-50 text-violet-700 ring-1 ring-violet-200"
    : "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
}

function usagePeriodLabel(value: string) {
  if (value === "billing_cycle") return "Each billing cycle";
  if (value === "monthly") return "Each month";
  if (value === "unlimited") return "Unlimited";
  return value;
}

function benefitTypeLabel(value: string) {
  if (value === "unlimited_group_classes") return "Unlimited Group Classes";
  if (value === "unlimited_practice_parties")
    return "Unlimited Practice Parties";
  if (value === "included_private_lessons") return "Included Private Lessons";
  if (value === "event_discount_percent") return "Event Discount";
  if (value === "floor_rental_discount_percent") return "Floor Rental Discount";
  return value.replaceAll("_", " ");
}

function benefitSummary(benefit: BenefitRow) {
  if (benefit.benefit_type === "included_private_lessons") {
    return benefit.quantity != null
      ? `${benefit.quantity} included per ${usagePeriodLabel(benefit.usage_period).toLowerCase()}`
      : "Included private lesson benefit";
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
    return "Unlimited access while membership is active";
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
      .select(
        `
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
      `,
      )
      .eq("id", id)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("membership_plan_benefits")
      .select(
        `
        id,
        benefit_type,
        quantity,
        discount_percent,
        discount_amount,
        usage_period,
        applies_to,
        sort_order
      `,
      )
      .eq("membership_plan_id", id)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (planError || !plan) {
    notFound();
  }

  if (benefitsError) {
    throw new Error(
      `Failed to load membership benefits: ${benefitsError.message}`,
    );
  }

  const typedPlan = plan as MembershipPlanRow;
  const typedBenefits = (benefits ?? []) as BenefitRow[];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-violet-100 bg-gradient-to-br from-slate-950 via-violet-950 to-fuchsia-900 p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-amber-200">
              DanceFlow Memberships
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                {typedPlan.name}
              </h1>

              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${activeBadgeClass(
                  typedPlan.active,
                )}`}
              >
                {typedPlan.active ? "Available for sale" : "Inactive"}
              </span>

              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${portalBadgeClass(
                  typedPlan.visibility,
                )}`}
              >
                {clientPortalLabel(typedPlan.visibility)}
              </span>
            </div>

            <p className="mt-3 max-w-2xl text-base leading-7 text-violet-100">
              {typedPlan.description ||
                "No public-facing description has been added yet."}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/memberships"
              className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/20"
            >
              Back to Memberships
            </Link>

            <Link
              href={`/app/memberships/${typedPlan.id}/edit`}
              className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-slate-950 hover:bg-violet-50"
            >
              Edit Plan
            </Link>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Recurring Price</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {formatCurrency(typedPlan.price)}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {billingIntervalLabel(typedPlan.billing_interval)} billing
          </p>
        </div>

        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Signup Fee</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {typedPlan.signup_fee
              ? formatCurrency(typedPlan.signup_fee)
              : "None"}
          </p>
          <p className="mt-1 text-sm text-slate-500">One-time fee</p>
        </div>

        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Benefits</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {typedBenefits.length}
          </p>
          <p className="mt-1 text-sm text-slate-500">Included perks</p>
        </div>

        <div className="rounded-3xl border bg-white p-5 shadow-sm">
          <p className="text-sm font-medium text-slate-500">Renewal Default</p>
          <p className="mt-2 text-3xl font-semibold text-slate-950">
            {typedPlan.auto_renew_default ? "On" : "Off"}
          </p>
          <p className="mt-1 text-sm text-slate-500">For new assignments</p>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-6">
          <div className="rounded-3xl border bg-white shadow-sm">
            <div className="border-b px-6 py-5">
              <h2 className="text-xl font-semibold text-slate-950">
                Included Benefits
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                These are the benefits clients receive when assigned to this
                membership.
              </p>
            </div>

            {typedBenefits.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
                  0
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">
                  No benefits configured
                </h3>
                <p className="mx-auto mt-2 max-w-md text-sm text-slate-600">
                  This plan can still be sold as a recurring membership. Add
                  benefits when the plan should include lessons, classes,
                  discounts, or other perks.
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {typedBenefits.map((benefit) => (
                  <div key={benefit.id} className="px-6 py-5">
                    <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                      <div>
                        <h3 className="font-semibold text-slate-950">
                          {benefitTypeLabel(benefit.benefit_type)}
                        </h3>

                        <p className="mt-1 text-sm text-slate-600">
                          {benefitSummary(benefit)}
                        </p>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs font-medium text-slate-600">
                          <span className="rounded-full bg-slate-100 px-2.5 py-1">
                            {usagePeriodLabel(benefit.usage_period)}
                          </span>

                          {benefit.applies_to ? (
                            <span className="rounded-full bg-slate-100 px-2.5 py-1">
                              Applies to: {benefit.applies_to}
                            </span>
                          ) : null}
                        </div>
                      </div>

                      <div className="min-w-40 rounded-2xl bg-slate-50 p-4 text-left lg:text-right">
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

                        {benefit.quantity == null &&
                        benefit.discount_percent == null &&
                        benefit.discount_amount == null ? (
                          <p className="text-sm text-slate-500">
                            No limit entered
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
          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">
              Selling Settings
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Visibility has been translated into plain language: whether
              clients can see this membership in the portal.
            </p>

            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-500">
                  Client Portal
                </p>
                <p className="mt-1 font-semibold text-slate-950">
                  {clientPortalLabel(typedPlan.visibility)}
                </p>
              </div>

              <div className="rounded-2xl border bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-500">
                  Available for Staff to Sell
                </p>
                <p className="mt-1 font-semibold text-slate-950">
                  {typedPlan.active ? "Yes" : "No"}
                </p>
              </div>

              <div className="rounded-2xl border bg-slate-50 p-4">
                <p className="text-sm font-medium text-slate-500">
                  Display Order
                </p>
                <p className="mt-1 font-semibold text-slate-950">
                  {typedPlan.sort_order}
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-2xl border bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-500">Created</p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {formatDateTime(typedPlan.created_at)}
                  </p>
                </div>

                <div className="rounded-2xl border bg-slate-50 p-4">
                  <p className="text-sm font-medium text-slate-500">
                    Last Updated
                  </p>
                  <p className="mt-1 text-sm font-semibold text-slate-950">
                    {formatDateTime(typedPlan.updated_at)}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-3xl border bg-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-slate-950">Next Steps</h2>

            <div className="mt-5 grid gap-3">
              <Link
                href={`/app/memberships/${typedPlan.id}/edit`}
                className="rounded-xl border px-4 py-3 text-sm font-medium hover:bg-slate-50"
              >
                Edit Membership Plan
              </Link>

              <Link
                href="/app/memberships/sell"
                className="rounded-xl border px-4 py-3 text-sm font-medium hover:bg-slate-50"
              >
                Sell or Assign Membership
              </Link>

              <Link
                href="/app/memberships"
                className="rounded-xl border px-4 py-3 text-sm font-medium hover:bg-slate-50"
              >
                Back to Membership List
              </Link>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-[28px] border border-amber-200 bg-amber-50/50 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Plan cleanup</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          Archive plans that should no longer be sold. Delete is only safe when a plan has never been assigned; if it has membership history, DanceFlow archives it instead.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          {typedPlan.active ? (
            <form action={archiveMembershipPlanAction}>
              <input type="hidden" name="membershipPlanId" value={typedPlan.id} />
              <input type="hidden" name="returnTo" value={`/app/memberships/${typedPlan.id}`} />
              <button
                type="submit"
                className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
              >
                Archive Plan
              </button>
            </form>
          ) : (
            <form action={reactivateMembershipPlanAction}>
              <input type="hidden" name="membershipPlanId" value={typedPlan.id} />
              <input type="hidden" name="returnTo" value={`/app/memberships/${typedPlan.id}`} />
              <button
                type="submit"
                className="rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                Restore Plan
              </button>
            </form>
          )}

          <form action={deleteMembershipPlanAction}>
            <input type="hidden" name="membershipPlanId" value={typedPlan.id} />
            <button
              type="submit"
              className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
            >
              Delete if Unused
            </button>
          </form>
        </div>
      </div>

    </div>
  );
}
