import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { canManagePackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import AriaInsightCard from "@/components/app/AriaInsightCard";

type BalanceRow = {
  id: string;
  name_snapshot: string;
  expiration_date: string | null;
  active: boolean;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  client_package_items: {
    id: string;
    usage_type: string;
    quantity_total: number | null;
    quantity_used: number;
    quantity_remaining: number | null;
    is_unlimited: boolean;
  }[];
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return value;
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

export default async function ClientBalancesPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManagePackages(role)) {
    redirect("/app");
  }

  const { data, error } = await supabase
    .from("client_packages")
    .select(`
      id,
      name_snapshot,
      expiration_date,
      active,
      clients (
        first_name,
        last_name
      ),
      client_package_items (
        id,
        usage_type,
        quantity_total,
        quantity_used,
        quantity_remaining,
        is_unlimited
      )
    `)
    .eq("studio_id", studioId)
    .order("purchase_date", { ascending: false });

  if (error) {
    throw new Error(`Failed to load client package balances: ${error.message}`);
  }

  const balances = (data ?? []) as BalanceRow[];
  const activeCount = balances.filter((balance) => balance.active).length;
  const inactiveCount = balances.filter((balance) => !balance.active).length;
  const lowBalancePackages = balances.filter((balance) =>
    balance.active &&
    balance.client_package_items.some(
      (item) =>
        !item.is_unlimited &&
        item.quantity_remaining !== null &&
        Number(item.quantity_remaining) <= 2,
    ),
  );
  const depletedPackages = balances.filter((balance) =>
    balance.active &&
    balance.client_package_items.some(
      (item) =>
        !item.is_unlimited &&
        item.quantity_remaining !== null &&
        Number(item.quantity_remaining) <= 0,
    ),
  );
  const ariaBalanceInsight =
    lowBalancePackages.length > 0
      ? `${lowBalancePackages.length} active package${lowBalancePackages.length === 1 ? " is" : "s are"} at 2 or fewer remaining credits.`
      : "No active packages are currently at the low-balance threshold.";

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">DanceFlow</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">Client Balances</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Review active client packages, remaining credits, expiration dates, and payment activity.
            </p>
          </div>
          <Link href="/app/packages/sell" className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white/90">Sell Package</Link>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Client Packages</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">{balances.length}</p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">{activeCount}</p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Inactive</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">{inactiveCount}</p>
        </div>
      </div>

      <AriaInsightCard
        eyebrow="ARIA Opportunity"
        title="Package renewal watch"
        insight={ariaBalanceInsight}
        recommendation={
          lowBalancePackages.length > 0
            ? "Review these clients and send renewal prompts before they run out of lesson credits."
            : "Keep monitoring balances weekly so renewal conversations happen before clients run out of credits."
        }
        metric={
          depletedPackages.length > 0
            ? `${depletedPackages.length} depleted`
            : `${lowBalancePackages.length} low balance`
        }
        primaryAction={{ href: "/app/aria", label: "Review with ARIA" }}
        secondaryAction={{ href: "/app/packages/sell", label: "Sell package" }}
      />

      <div className="space-y-4">
        {balances.length === 0 ? (
          <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 text-slate-500 shadow-sm">
            No client package balances yet. Sold packages will appear here with remaining credits and expiration details.
          </div>
        ) : (
          balances.map((balance) => (
            <div key={balance.id} className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <h3 className="text-xl font-semibold">
                    {getClientName(balance.clients)}
                  </h3>
                  <p className="mt-1 text-slate-600">{balance.name_snapshot}</p>
                </div>

                <div className="text-sm text-slate-600">
                  <p>Status: {balance.active ? "active" : "inactive"}</p>
                  <p>Expires: {balance.expiration_date ?? "—"}</p>
                </div>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {balance.client_package_items.length === 0 ? (
                  <p className="text-slate-500">No balance items found.</p>
                ) : (
                  balance.client_package_items.map((item) => (
                    <div key={item.id} className="rounded-xl bg-slate-50 p-4">
                      <p className="text-sm text-slate-500">
                        {usageLabel(item.usage_type)}
                      </p>
                      <p className="mt-2 font-medium">
                        {item.is_unlimited
                          ? "Unlimited"
                          : `${item.quantity_remaining} remaining`}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {item.is_unlimited
                          ? "No deduction limit"
                          : `Used ${item.quantity_used} of ${item.quantity_total}`}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}