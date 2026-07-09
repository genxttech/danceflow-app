import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { ArrowLeft, Sparkles, Users, WalletCards } from "lucide-react";
import SellMembershipForm from "./SellMembershipForm";

type SearchParams = Promise<{
  error?: string;
  success?: string;
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
  membership_plan_id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string | null;
  applies_to: string | null;
};

type ExistingMembershipRow = {
  id: string;
  client_id: string;
  status: string;
  name_snapshot: string | null;
};

function canSellMemberships(role: string | null | undefined, isPlatformAdmin: boolean) {
  if (isPlatformAdmin) return true;
  return role === "studio_owner" || role === "studio_admin" || role === "front_desk";
}

function errorMessage(code: string | undefined) {
  if (!code) return null;
  const normalized = decodeURIComponent(code);
  const known: Record<string, string> = {
    missing_client: "Choose a client before completing the membership sale.",
    missing_plan: "Choose a membership plan before completing the sale.",
    missing_start: "Choose a membership start date.",
    client_not_found: "The selected client could not be found.",
    plan_not_found: "The selected membership plan could not be found.",
    plan_inactive: "This membership plan is inactive.",
    active_membership_exists: "This client already has an active or pending membership.",
    recurring_consent_required: "Recurring billing consent is required for card reader enrollment.",
    terminal_membership_amount_required: "Card reader enrollment requires a positive first payment amount.",
  };
  return known[normalized] ?? normalized.replaceAll("_", " ");
}

function successMessage(code: string | undefined) {
  if (!code) return null;
  const normalized = decodeURIComponent(code);
  const known: Record<string, string> = {
    membership_payment_method_saved: "Payment method saved.",
    membership_subscription_created: "Membership subscription created.",
    membership_assigned: "Membership assigned.",
  };
  return known[normalized] ?? normalized.replaceAll("_", " ");
}

export default async function SellMembershipPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const error = errorMessage(params.error);
  const success = successMessage(params.success);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canSellMemberships(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [plansResult, clientsResult, existingResult] = await Promise.all([
    supabase
      .from("membership_plans")
      .select("id, name, description, active, billing_interval, price, signup_fee, auto_renew_default, visibility")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, phone, status")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead", "inactive"])
      .order("first_name", { ascending: true })
      .limit(300),
    supabase
      .from("client_memberships")
      .select("id, client_id, status, name_snapshot")
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid"]),
  ]);

  if (plansResult.error) {
    throw new Error(`Failed to load membership plans: ${plansResult.error.message}`);
  }

  if (clientsResult.error) {
    throw new Error(`Failed to load clients: ${clientsResult.error.message}`);
  }

  if (existingResult.error) {
    throw new Error(`Failed to load existing memberships: ${existingResult.error.message}`);
  }

  const plans = (plansResult.data ?? []) as MembershipPlanRow[];
  const planIds = plans.map((plan) => plan.id);
  const benefitsResult = planIds.length
    ? await supabase
        .from("membership_plan_benefits")
        .select("id, membership_plan_id, benefit_type, quantity, discount_percent, discount_amount, usage_period, applies_to")
        .in("membership_plan_id", planIds)
        .order("sort_order", { ascending: true })
    : { data: [], error: null };

  if (benefitsResult.error) {
    throw new Error(`Failed to load membership benefits: ${benefitsResult.error.message}`);
  }

  const benefitsByPlanId = ((benefitsResult.data ?? []) as MembershipBenefitRow[]).reduce<
    Record<string, MembershipBenefitRow[]>
  >((map, benefit) => {
    map[benefit.membership_plan_id] = [...(map[benefit.membership_plan_id] ?? []), benefit];
    return map;
  }, {});

  const existingMembershipsByClientId = ((existingResult.data ?? []) as ExistingMembershipRow[]).reduce<
    Record<string, ExistingMembershipRow>
  >((map, membership) => {
    if (!map[membership.client_id]) map[membership.client_id] = membership;
    return map;
  }, {});

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
                Sell a membership
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Choose the client, choose the plan, review recurring terms, and complete the sale from one guided screen.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/memberships"
                className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                <ArrowLeft className="h-4 w-4" />
                Membership Plans
              </Link>
              <Link
                href="/app/clients"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Client List
              </Link>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-sm font-medium text-rose-800">
          {error}
        </div>
      ) : null}

      {success ? (
        <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5 text-sm font-medium text-emerald-800">
          {success}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Plans</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{plans.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <WalletCards className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Selectable Clients</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{(clientsResult.data ?? []).length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Sale Flow</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">1 page</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Sparkles className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      <SellMembershipForm
        clients={(clientsResult.data ?? []) as ClientRow[]}
        plans={plans}
        benefitsByPlanId={benefitsByPlanId}
        existingMembershipsByClientId={existingMembershipsByClientId}
      />
    </div>
  );
}
