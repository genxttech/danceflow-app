import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";

type BillingPlanRow = {
  key: string;
  label: string;
  amount_monthly_cents: number;
  description: string | null;
};

type StudioBillingRow = {
  id: string;
  name: string | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_connected_account_id: string | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_onboarding_complete: boolean | null;
};

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function statusBadgeClasses(tone: "green" | "yellow" | "red" | "slate") {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "yellow":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    case "red":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
}

function getSubscriptionTone(
  status: string | null
): "green" | "yellow" | "red" | "slate" {
  if (status === "active" || status === "trialing") return "green";
  if (status === "past_due" || status === "incomplete") return "yellow";
  if (status === "canceled" || status === "unpaid") return "red";
  return "slate";
}

function getConnectStatus(studio: StudioBillingRow) {
  if (!studio.stripe_connected_account_id) {
    return {
      label: "Not connected",
      tone: "slate" as const,
      description:
        "Connect Stripe so your studio can accept payments and receive payouts.",
      buttonLabel: "Connect Stripe",
    };
  }

  if (studio.stripe_connect_onboarding_complete) {
    return {
      label: "Ready",
      tone: "green" as const,
      description:
        "Your studio payout account is connected and ready for payout-enabled payment flows.",
      buttonLabel: "Update payout details",
    };
  }

  if (studio.stripe_connect_details_submitted) {
    return {
      label: "Action required",
      tone: "yellow" as const,
      description:
        "Stripe still needs additional information before payouts are fully enabled.",
      buttonLabel: "Continue onboarding",
    };
  }

  return {
    label: "In progress",
    tone: "yellow" as const,
    description:
      "Your studio connected account exists, but onboarding is not complete yet.",
    buttonLabel: "Continue onboarding",
  };
}

function getBillingPlans(): BillingPlanRow[] {
  return [
    {
      key: "starter",
      label: "Starter",
      amount_monthly_cents: 4900,
      description: "Core CRM, scheduling, and payments for a single studio.",
    },
    {
      key: "growth",
      label: "Growth",
      amount_monthly_cents: 9900,
      description:
        "Adds stronger operations, lead handling, and growth workflows.",
    },
    {
      key: "pro",
      label: "Pro",
      amount_monthly_cents: 17900,
      description:
        "Advanced studio operations, memberships, and multi-staff workflows.",
    },
  ];
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const stripe = getStripe();
  const resolvedSearchParams = (await searchParams) ?? {};

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select(
      `
        id,
        name,
        subscription_status,
        stripe_customer_id,
        stripe_subscription_id,
        stripe_connected_account_id,
        stripe_connect_details_submitted,
        stripe_connect_charges_enabled,
        stripe_connect_payouts_enabled,
        stripe_connect_onboarding_complete
      `
    )
    .eq("id", studioId)
    .single<StudioBillingRow>();

  if (studioError || !studio) {
    redirect("/app");
  }

  const plans = getBillingPlans();

  let portalUrl: string | null = null;

  if (studio.stripe_customer_id && studio.stripe_subscription_id) {
    const subscriptions = await stripe.subscriptions.list({
      customer: studio.stripe_customer_id,
      limit: 10,
      status: "all",
    });

    const currentSubscription = subscriptions.data.find(
      (sub) => sub.id === studio.stripe_subscription_id
    );

    if (currentSubscription) {
      const session = await stripe.billingPortal.sessions.create({
        customer: studio.stripe_customer_id,
        return_url: `${
          process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
        }/app/settings/billing`,
      });

      portalUrl = session.url;
    }
  }

  const subscriptionStatus = studio.subscription_status ?? "not_started";
  const connectStatus = getConnectStatus(studio);

  const successParam = Array.isArray(resolvedSearchParams.success)
    ? resolvedSearchParams.success[0]
    : resolvedSearchParams.success;

  const errorParam = Array.isArray(resolvedSearchParams.error)
    ? resolvedSearchParams.error[0]
    : resolvedSearchParams.error;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Billing & payments
        </h1>
        <p className="mt-1 text-sm text-slate-600">
          Manage your DanceFlow subscription and connect your studio payout
          account.
        </p>
      </div>

      {successParam ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {successParam === "stripe_connect_updated"
            ? "Your studio Stripe payout account was updated successfully."
            : "Billing update completed successfully."}
        </div>
      ) : null}

      {errorParam ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorParam === "no_studio_context" &&
            "No studio context was found for this account."}
          {errorParam === "studio_not_found" &&
            "Studio record could not be found."}
          {errorParam === "save_connected_account_failed" &&
            "The connected Stripe account was created but could not be saved locally."}
          {errorParam === "missing_connected_account" &&
            "No Stripe connected account was found for this studio."}
          {errorParam === "sync_connected_account_failed" &&
            "Stripe returned successfully, but the account status could not be synced."}
          {![
            "no_studio_context",
            "studio_not_found",
            "save_connected_account_failed",
            "missing_connected_account",
            "sync_connected_account_failed",
          ].includes(errorParam)
            ? "Something went wrong while updating billing."
            : null}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                DanceFlow subscription
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Your SaaS membership for using DanceFlow.
              </p>
            </div>

            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                getSubscriptionTone(subscriptionStatus)
              )}`}
            >
              {subscriptionStatus.replaceAll("_", " ")}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="space-y-3">
              {plans.map((plan) => (
                <div
                  key={plan.key}
                  className="rounded-2xl border border-slate-200 p-4"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">
                        {plan.label}
                      </div>
                      <div className="mt-1 text-sm text-slate-600">
                        {plan.description || "DanceFlow membership plan"}
                      </div>
                    </div>

                    <div className="flex items-center gap-3">
                      <div className="text-sm font-semibold text-slate-900">
                        {formatMoney(plan.amount_monthly_cents)}/mo
                      </div>

                      <form action="/api/billing/checkout" method="post">
                        <input type="hidden" name="planKey" value={plan.key} />
                        <button
                          type="submit"
                          className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
                        >
                          Choose plan
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {portalUrl ? (
              <div className="pt-2">
                <Link
                  href={portalUrl}
                  className="inline-flex items-center rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Manage subscription
                </Link>
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Studio payout account
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Connect your studio’s Stripe account to accept payments and
                receive payouts.
              </p>
            </div>

            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${statusBadgeClasses(
                connectStatus.tone
              )}`}
            >
              {connectStatus.label}
            </span>
          </div>

          <div className="mt-6 space-y-4">
            <div className="rounded-2xl border border-slate-200 p-4">
              <div className="text-sm text-slate-700">
                {connectStatus.description}
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Details submitted
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {studio.stripe_connect_details_submitted ? "Yes" : "No"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Charges enabled
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {studio.stripe_connect_charges_enabled ? "Yes" : "No"}
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                    Payouts enabled
                  </div>
                  <div className="mt-1 text-sm font-semibold text-slate-900">
                    {studio.stripe_connect_payouts_enabled ? "Yes" : "No"}
                  </div>
                </div>
              </div>

              <form
  action="/api/stripe/connect/onboarding"
  method="post"
  className="mt-4"
>
  <button
    type="submit"
    className="inline-flex items-center rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
  >
    {connectStatus.buttonLabel}
  </button>
</form>
            </div>

            <div className="rounded-2xl border border-dashed border-slate-300 p-4 text-sm text-slate-600">
              Online payment features should be gated until this studio payout
              account is fully connected.
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}