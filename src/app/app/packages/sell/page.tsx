import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManagePackages } from "@/lib/auth/permissions";
import { ArrowLeft, Package2, ShoppingBag, Users } from "lucide-react";
import SellPackageForm from "./SellPackageForm";

type SearchParams = Promise<{
  error?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: string | null;
};

type PackageTemplateRow = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  expiration_days: number | null;
  package_template_items:
    | {
        usage_type: string;
        quantity: number | null;
        is_unlimited: boolean;
      }[]
    | null;
};

type LedgerRow = {
  client_id: string;
  direction: string | null;
  amount: number | string | null;
};

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function calculateClientBalances(rows: LedgerRow[]) {
  return rows.reduce<Record<string, number>>((map, row) => {
    const amount = Number(row.amount ?? 0);
    if (!row.client_id || !Number.isFinite(amount)) return map;

    map[row.client_id] = roundCurrency(
      (map[row.client_id] ?? 0) + (row.direction === "credit" ? amount : -amount)
    );

    return map;
  }, {});
}

function errorMessage(code: string | undefined) {
  if (!code) return null;

  const normalized = decodeURIComponent(code);

  const known: Record<string, string> = {
    missing_client: "Choose a client before completing the sale.",
    missing_package: "Choose a package before completing the sale.",
    missing_sale_selection: "Choose a client and package before completing the sale.",
  };

  return known[normalized] ?? normalized.replaceAll("_", " ");
}

export default async function SellPackagesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const message = errorMessage(params.error);

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const role = context.studioRole ?? "";

  if (!canManagePackages(role) && !context.isPlatformAdmin) {
    redirect("/app");
  }

  const studioId = context.studioId;

  const [templatesResult, clientsResult, ledgerResult] = await Promise.all([
    supabase
      .from("package_templates")
      .select(`
        id,
        name,
        price,
        active,
        expiration_days,
        package_template_items (
          usage_type,
          quantity,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),
    supabase
      .from("clients")
      .select("id, first_name, last_name, email, status")
      .eq("studio_id", studioId)
      .in("status", ["active", "lead", "inactive"])
      .order("first_name", { ascending: true })
      .limit(300),
    supabase
      .from("client_account_ledger")
      .select("client_id, direction, amount")
      .eq("studio_id", studioId),
  ]);

  if (templatesResult.error) {
    throw new Error(`Failed to load package templates: ${templatesResult.error.message}`);
  }

  if (clientsResult.error) {
    throw new Error(`Failed to load clients: ${clientsResult.error.message}`);
  }

  if (ledgerResult.error) {
    throw new Error(`Failed to load client account credits: ${ledgerResult.error.message}`);
  }

  const templates = (templatesResult.data ?? []) as PackageTemplateRow[];
  const clients = (clientsResult.data ?? []) as ClientRow[];
  const clientAccountBalances = calculateClientBalances((ledgerResult.data ?? []) as LedgerRow[]);

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                DanceFlow Package Sales
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Sell a package
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                Choose the client, choose the package, review the balance, and complete the sale from one guided screen.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/packages"
                className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-white hover:bg-white/15"
              >
                <ArrowLeft className="h-4 w-4" />
                Package Templates
              </Link>
              <Link
                href="/app/packages/client-balances"
                className="rounded-xl bg-white px-4 py-2 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
              >
                Client Balances
              </Link>
            </div>
          </div>
        </div>
      </section>

      {message ? (
        <div className="rounded-3xl border border-rose-200 bg-rose-50 p-5 text-sm font-medium text-rose-800">
          {message}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Active Packages</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{templates.length}</p>
            </div>
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Package2 className="h-5 w-5" />
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-slate-500">Selectable Clients</p>
              <p className="mt-2 text-3xl font-semibold text-slate-950">{clients.length}</p>
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
              <ShoppingBag className="h-5 w-5" />
            </div>
          </div>
        </div>
      </div>

      <SellPackageForm
        clients={clients.map((client) => ({
          ...client,
          status: client.status ?? "active",
          account_balance: clientAccountBalances[client.id] ?? 0,
        }))}
        packageTemplates={templates.map((template) => ({
          ...template,
          package_template_items: template.package_template_items ?? [],
        }))}
        clientAccountBalances={clientAccountBalances}
      />
    </div>
  );
}
