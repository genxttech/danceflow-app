import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { canManagePackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Client Package Balances</h2>
          <p className="mt-2 text-slate-600">
            View purchased packages and remaining balances by package item.
          </p>
        </div>

        <Link
          href="/app/packages/sell"
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
        >
          Sell Package
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Client Packages</p>
          <p className="mt-2 text-3xl font-semibold">{balances.length}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Active</p>
          <p className="mt-2 text-3xl font-semibold">{activeCount}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Inactive</p>
          <p className="mt-2 text-3xl font-semibold">{inactiveCount}</p>
        </div>
      </div>

      <div className="space-y-4">
        {balances.length === 0 ? (
          <div className="rounded-2xl border bg-white p-6 text-slate-500">
            No client packages yet.
          </div>
        ) : (
          balances.map((balance) => (
            <div key={balance.id} className="rounded-2xl border bg-white p-6">
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