import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, CalendarDays, CreditCard, ShieldCheck, User, WalletCards } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  assignMembershipToClientAction,
  sellMembershipAction,
  startTerminalMembershipEnrollmentAction,
} from "@/app/app/memberships/actions";

type SearchParams = Promise<{
  clientId?: string;
  membershipPlanId?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
};

type MembershipPlanRow = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean | null;
  visibility: string | null;
};

type MembershipBenefitRow = {
  id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string | null;
  applies_to: string | null;
};

type ExistingMembershipRow = {
  id: string;
  status: string;
  name_snapshot: string | null;
};

function canSellMemberships(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return role === "studio_owner" || role === "studio_admin" || role === "front_desk";
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
  return value.replaceAll("_", " ");
}

function benefitLabel(benefit: MembershipBenefitRow) {
  const pieces = [benefit.benefit_type.replaceAll("_", " ")];

  if (benefit.quantity !== null) {
    pieces.push(`${benefit.quantity}`);
  }

  if (benefit.discount_percent !== null) {
    pieces.push(`${benefit.discount_percent}% off`);
  }

  if (benefit.discount_amount !== null) {
    pieces.push(`${formatCurrency(benefit.discount_amount)} off`);
  }

  if (benefit.usage_period) {
    pieces.push(benefit.usage_period.replaceAll("_", " "));
  }

  if (benefit.applies_to) {
    pieces.push(`applies to ${benefit.applies_to}`);
  }

  return pieces.join(" • ");
}

export default async function ConfirmMembershipSalePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const clientId = params.clientId ?? "";
  const membershipPlanId = params.membershipPlanId ?? "";

  if (!clientId || !membershipPlanId) {
    redirect("/app/memberships/sell?error=missing_sale_selection");
  }

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canSellMemberships(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [clientResult, planResult, benefitsResult, existingResult] = await Promise.all([
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, status")
      .eq("id", clientId)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("membership_plans")
      .select("id, name, description, active, billing_interval, price, signup_fee, auto_renew_default, visibility")
      .eq("id", membershipPlanId)
      .eq("studio_id", studioId)
      .single(),
    supabase
      .from("membership_plan_benefits")
      .select("id, benefit_type, quantity, discount_percent, discount_amount, usage_period, applies_to")
      .eq("membership_plan_id", membershipPlanId)
      .order("sort_order", { ascending: true }),
    supabase
      .from("client_memberships")
      .select("id, status, name_snapshot")
      .eq("studio_id", studioId)
      .eq("client_id", clientId)
      .in("status", ["active", "pending", "past_due", "unpaid"])
      .limit(1),
  ]);

  if (clientResult.error || !clientResult.data) {
    redirect("/app/memberships/sell?error=client_not_found");
  }

  if (planResult.error || !planResult.data) {
    redirect("/app/memberships/sell?error=plan_not_found");
  }

  const client = clientResult.data as ClientRow;
  const plan = planResult.data as MembershipPlanRow;
  const benefits = (benefitsResult.data ?? []) as MembershipBenefitRow[];
  const existingMembership = ((existingResult.data ?? []) as ExistingMembershipRow[])[0] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const returnTo = `/app/memberships/sell/confirm?clientId=${client.id}&membershipPlanId=${plan.id}`;
  const clientName = `${client.first_name} ${client.last_name}`.trim();

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Membership Sales
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Review membership sale
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Confirm the client, membership, start date, and payment path before creating anything.
              </p>
            </div>

            <Link
              href="/app/memberships/sell"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to sell page
            </Link>
          </div>
        </div>
      </section>

      {existingMembership ? (
        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
          <p className="font-semibold">This client already has an active or pending membership.</p>
          <p className="mt-2 leading-6">
            Current membership: {existingMembership.name_snapshot ?? "Membership"} ({existingMembership.status.replaceAll("_", " ")}).
            Review the client record before selling another membership.
          </p>
          <Link
            href={`/app/clients/${client.id}`}
            className="mt-4 inline-flex rounded-xl bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:opacity-95"
          >
            Open Client Record
          </Link>
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <User className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Client</p>
              <h2 className="mt-1 text-xl font-semibold text-slate-950">{clientName || "Unnamed Client"}</h2>
              <p className="mt-2 text-sm text-slate-600">{client.email || "No email on file"}</p>
              {client.phone ? <p className="mt-1 text-sm text-slate-600">{client.phone}</p> : null}
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <WalletCards className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm text-slate-500">Membership</p>
                  <h2 className="mt-1 text-xl font-semibold text-slate-950">{plan.name}</h2>
                </div>
                <span className="rounded-full bg-[var(--brand-primary-soft)] px-3 py-1 text-sm font-semibold text-[var(--brand-primary)]">
                  {formatCurrency(plan.price)} / {billingIntervalLabel(plan.billing_interval)}
                </span>
              </div>

              {plan.description ? <p className="mt-3 text-sm leading-6 text-slate-600">{plan.description}</p> : null}

              {plan.signup_fee ? (
                <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                  Signup fee configured: {formatCurrency(plan.signup_fee)}. Confirm your current billing workflow before charging the client.
                </p>
              ) : null}

              <div className="mt-5">
                <p className="text-sm font-semibold text-slate-900">Included benefits</p>
                {benefits.length > 0 ? (
                  <ul className="mt-3 space-y-2">
                    {benefits.map((benefit) => (
                      <li key={benefit.id} className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                        {benefitLabel(benefit)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm text-slate-500">
                    No benefits are listed for this membership.
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Finish the sale</h2>
            <p className="mt-1 text-sm text-slate-500">
              Start a Stripe subscription checkout, or assign the membership without charging when payment was handled outside DanceFlow.
            </p>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-3">
          <form action={sellMembershipAction} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Start Stripe checkout</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Use this when the client should pay through DanceFlow and Stripe should manage the recurring billing.
                </p>
              </div>
            </div>

            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="membershipPlanId" value={plan.id} />
            <input type="hidden" name="returnTo" value={returnTo} />

            <label className="mt-5 block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Start date</span>
              <input
                type="date"
                name="startsOn"
                defaultValue={today}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </label>

            <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="autoRenew"
                defaultChecked={plan.auto_renew_default ?? true}
                className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
              />
              Auto-renew this membership
            </label>

            <button
              type="submit"
              disabled={!plan.active || Boolean(existingMembership)}
              className="mt-5 w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Checkout
            </button>
          </form>

          <form action={startTerminalMembershipEnrollmentAction} className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-emerald-700 shadow-sm">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Enroll with card reader</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Collect the first period and signup fee in person, then save the generated card for recurring renewals.
                </p>
              </div>
            </div>

            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="membershipPlanId" value={plan.id} />
            <input type="hidden" name="returnTo" value={returnTo} />

            <label className="mt-5 block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Start date</span>
              <input
                type="date"
                name="startsOn"
                defaultValue={today}
                className="w-full rounded-xl border border-emerald-300 bg-white px-3 py-2.5 text-sm text-slate-900"
                required
              />
            </label>

            <label className="mt-4 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-white p-4 text-sm leading-6 text-slate-700">
              <input type="checkbox" name="recurringConsent" required className="mt-1 h-4 w-4 rounded border-slate-300" />
              <span>
                The client authorizes the initial charge of {formatCurrency(Number(plan.price) + Number(plan.signup_fee ?? 0))} and recurring {billingIntervalLabel(plan.billing_interval).toLowerCase()} charges of {formatCurrency(plan.price)} until cancelled under the studio&apos;s membership terms.
              </span>
            </label>

            <button
              type="submit"
              disabled={!plan.active || Boolean(existingMembership)}
              className="mt-5 w-full rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue to Card Reader
            </button>
          </form>

          <form action={assignMembershipToClientAction} className="rounded-3xl border border-slate-200 bg-white p-5">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Assign without charging</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Use this only for comped memberships, imported sales, or payments already handled outside DanceFlow.
                </p>
              </div>
            </div>

            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="membershipPlanId" value={plan.id} />
            <input type="hidden" name="returnTo" value={returnTo} />

            <label className="mt-5 block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Start date</span>
              <input
                type="date"
                name="startsOn"
                defaultValue={today}
                className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </label>

            <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="autoRenew"
                defaultChecked={plan.auto_renew_default ?? true}
                className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
              />
              Auto-renew this membership
            </label>

            <button
              type="submit"
              disabled={!plan.active || Boolean(existingMembership)}
              className="mt-5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Assign Membership
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
