import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { Filter, Search, Sparkles, Users, WalletCards } from "lucide-react";

type SearchParams = Promise<{
  q?: string;
  plan?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
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
  visibility: string;
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
  return value;
}

function matchesSearch(client: ClientRow, q: string) {
  if (!q) return true;
  const haystack = `${client.first_name} ${client.last_name} ${client.email ?? ""}`.toLowerCase();
  return haystack.includes(q.toLowerCase());
}

export default async function SellMembershipPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const query = (params.q ?? "").trim();
  const planFilter = params.plan ?? "all";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canSellMemberships(context.studioRole, context.isPlatformAdmin)) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [{ data: plans, error: plansError }, { data: clients, error: clientsError }] =
    await Promise.all([
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
          visibility
        `)
        .eq("studio_id", studioId)
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("name", { ascending: true }),
      supabase
        .from("clients")
        .select("id, first_name, last_name, email, status")
        .eq("studio_id", studioId)
        .in("status", ["active", "lead", "inactive"])
        .order("first_name", { ascending: true })
        .limit(200),
    ]);

  if (plansError) {
    throw new Error(`Failed to load membership plans: ${plansError.message}`);
  }

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  const allPlans = (plans ?? []) as MembershipPlanRow[];
  const selectedPlan = allPlans.find((plan) => plan.id === planFilter) ?? null;
  const visiblePlans = allPlans.filter((plan) => (planFilter === "all" ? true : plan.id === planFilter));
  const visibleClients = ((clients ?? []) as ClientRow[]).filter((client) => matchesSearch(client, query));

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
                Choose a membership, pick the client, then review the sale before starting checkout or assigning the membership.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/memberships"
                className="rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
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

        <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-sky-200 bg-sky-50 p-5">
              <h2 className="text-lg font-semibold text-sky-950">Choose the plan first</h2>
              <p className="mt-2 text-sm leading-7 text-sky-900">
                Pick the membership you want to sell so staff can stay focused on the right product.
              </p>
            </div>
            <div className="rounded-2xl border border-violet-200 bg-violet-50 p-5">
              <h2 className="text-lg font-semibold text-violet-950">Find the client quickly</h2>
              <p className="mt-2 text-sm leading-7 text-violet-900">
                Search by name or email and move into a dedicated membership sale review step.
              </p>
            </div>
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">Keep the workflow simple</h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                No more hidden sales from the client profile. Staff can confirm the plan, client, start date, and payment path first.
              </p>
            </div>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Plans</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{allPlans.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <WalletCards className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Visible Clients</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{visibleClients.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Users className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Selected Plan</p>
              <p className="mt-2 text-xl font-semibold text-slate-950">
                {selectedPlan ? selectedPlan.name : "Choose any plan"}
              </p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Sparkles className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      <form className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Filter className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Choose a plan and search for a client</h2>
            <p className="mt-1 text-sm text-slate-500">
              Choose a membership first, then select the client who should receive it.
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_320px_auto]">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Search client</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                name="q"
                defaultValue={query}
                placeholder="Name or email"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Membership plan</span>
            <select
              name="plan"
              defaultValue={planFilter}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            >
              <option value="all">All active plans</option>
              {allPlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95"
            >
              Update List
            </button>
          </div>
        </div>
      </form>

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Available membership plans</h2>
          <p className="mt-1 text-sm text-slate-500">
            Click a plan to select it. The selected plan is highlighted and used for the client sale buttons.
          </p>

          <div className="mt-5 space-y-3">
            {visiblePlans.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                No membership plans match this filter.
              </div>
            ) : (
              visiblePlans.map((plan) => {
                const isSelected = selectedPlan?.id === plan.id;
                const chooseHref = `/app/memberships/sell?plan=${plan.id}${
                  query ? `&q=${encodeURIComponent(query)}` : ""
                }`;

                return (
                  <div
                    key={plan.id}
                    className={`rounded-2xl border p-4 transition ${
                      isSelected
                        ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)] shadow-sm ring-2 ring-[var(--brand-primary)]/15"
                        : "border-slate-200 bg-slate-50 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium text-slate-900">{plan.name}</p>
                          {isSelected ? (
                            <span className="rounded-full bg-[var(--brand-primary)] px-2.5 py-1 text-xs font-semibold text-white">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm text-slate-600">
                          {formatCurrency(plan.price)} / {billingIntervalLabel(plan.billing_interval)}
                          {plan.signup_fee ? ` • Signup fee ${formatCurrency(plan.signup_fee)}` : ""}
                        </p>
                        {plan.description ? (
                          <p className="mt-2 text-sm text-slate-500">{plan.description}</p>
                        ) : null}
                      </div>

                      <Link
                        href={chooseHref}
                        aria-current={isSelected ? "true" : undefined}
                        className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                          isSelected
                            ? "bg-[var(--brand-primary)] text-white"
                            : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
                        }`}
                      >
                        {isSelected ? "Selected" : "Choose"}
                      </Link>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-950">Clients ready for membership sale</h2>
          <p className="mt-1 text-sm text-slate-500">
            Choose a client to review and finish the membership sale.
          </p>

          <div className="mt-5 space-y-3">
            {visibleClients.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-500">
                No clients match your search.
              </div>
            ) : (
              visibleClients.map((client) => (
                <div key={client.id} className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium text-slate-900">
                        {client.first_name} {client.last_name}
                      </p>
                      <p className="mt-1 text-sm text-slate-500">{client.email || "No email on file"}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        Status: {client.status ? client.status.replaceAll("_", " ") : "—"}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <Link
                        href={`/app/clients/${client.id}`}
                        className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        View Client
                      </Link>
                      {selectedPlan ? (
                        <Link
                          href={`/app/memberships/sell/confirm?clientId=${client.id}&membershipPlanId=${selectedPlan.id}`}
                          className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-medium text-white hover:opacity-95"
                        >
                          Sell Selected Membership
                        </Link>
                      ) : (
                        <span className="rounded-xl border border-slate-200 bg-slate-100 px-4 py-2 text-sm font-medium text-slate-500">
                          Choose a membership first
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
