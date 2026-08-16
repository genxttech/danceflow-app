import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  archivePackageTemplateAction,
  deletePackageTemplateAction,
  reactivatePackageTemplateAction,
} from "./actions";
import { canManagePackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellWorkspaceHeader from "@/components/app/sell/SellWorkspaceHeader";
import SellWorkspaceEmptyState from "@/components/app/sell/SellWorkspaceEmptyState";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import {
  getClientPackageStatus,
  getItemWarningLevel,
  getUnsuppressedWarningUsageTypes,
} from "@/lib/packages/entitlement";

type PackageRow = {
  id: string;
  name: string;
  price: number;
  expiration_days: number | null;
  active: boolean;
  created_at: string;
  package_template_items: {
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

type ClientPackageItemRow = {
  usage_type: string;
  quantity_remaining: number | null;
  is_unlimited: boolean;
};

type ClientPackageRow = {
  id: string;
  client_id: string;
  name_snapshot: string;
  active: boolean;
  archived_at: string | null;
  expiration_date: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  client_package_items: ClientPackageItemRow[];
};

function clientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null,
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Unknown client";
}

/**
 * Schedule Stabilization Slice 1b-b: canonical status + replacement-coverage
 * suppression, replacing the previous independent threshold-1/lowest-item
 * reimplementation. `otherPackages` should be the same client's other
 * loaded packages (see call site) -- a healthy same-usage-type package
 * suppresses down to "healthy"; an unrelated-usage-type or archived/
 * expired/inactive/depleted "replacement" never does.
 */
function packageBalanceState(pkg: ClientPackageRow, otherPackages: ClientPackageRow[]) {
  if (!pkg.active) return "inactive";

  const status = getClientPackageStatus(pkg);
  if (status === "archived") return "inactive";
  if (status === "expired") return "expired";

  const unsuppressed = getUnsuppressedWarningUsageTypes({
    targetPackage: pkg,
    otherClientPackages: otherPackages,
  });
  if (unsuppressed.length === 0) return "healthy";

  const worstIsDepleted = unsuppressed.some((usageType) => {
    const item = pkg.client_package_items.find((candidate) => candidate.usage_type === usageType);
    return item ? getItemWarningLevel(item) === "depleted" : false;
  });

  return worstIsDepleted ? "depleted" : "low";
}

function packageBalanceBadgeClass(state: string) {
  if (state === "healthy") return "bg-emerald-50 text-emerald-700";
  if (state === "low") return "bg-amber-50 text-amber-700";
  if (state === "depleted") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

function formatPackageItems(items: PackageRow["package_template_items"]) {
  if (!items || items.length === 0) return "No items";

  return items
    .map((item) => {
      const label =
        item.usage_type === "private_lesson"
          ? "Private"
          : item.usage_type === "group_class"
            ? "Group"
            : "Practice";

      return item.is_unlimited
        ? `${label}: Unlimited`
        : `${label}: ${item.quantity}`;
    })
    .join(" • ");
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value));
}

function templateBadgeClass(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
}

export default async function PackagesPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;
  const role = context.studioRole ?? "";

  if (!canManagePackages(role)) {
    redirect("/app");
  }

  const [
    { data: templateData, error: templateError },
    { data: clientPackageData, error: clientPackageError },
  ] = await Promise.all([
    supabase
      .from("package_templates")
      .select(`
        id,
        name,
        price,
        expiration_days,
        active,
        created_at,
        package_template_items (
          usage_type,
          quantity,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .order("active", { ascending: false })
      .order("created_at", { ascending: false }),

    supabase
      .from("client_packages")
      .select(`
        id,
        client_id,
        name_snapshot,
        active,
        archived_at,
        expiration_date,
        clients (
          first_name,
          last_name
        ),
        client_package_items (
          usage_type,
          quantity_remaining,
          is_unlimited
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (templateError) {
    throw new Error(`Failed to load package templates: ${templateError.message}`);
  }

  if (clientPackageError) {
    throw new Error(`Failed to load client package balances: ${clientPackageError.message}`);
  }

  const packageTemplates = (templateData ?? []) as PackageRow[];
  const clientPackages = (clientPackageData ?? []) as ClientPackageRow[];
  const activeCount = packageTemplates.filter((pkg) => pkg.active).length;
  const archivedCount = packageTemplates.filter((pkg) => !pkg.active).length;
  const clientPackagesByClientId = new Map<string, ClientPackageRow[]>();
  for (const pkg of clientPackages) {
    const list = clientPackagesByClientId.get(pkg.client_id);
    if (list) {
      list.push(pkg);
    } else {
      clientPackagesByClientId.set(pkg.client_id, [pkg]);
    }
  }
  const packageBalanceRows = clientPackages.map((pkg) => {
    const otherPackages = (clientPackagesByClientId.get(pkg.client_id) ?? []).filter(
      (candidate) => candidate.id !== pkg.id,
    );
    return { pkg, state: packageBalanceState(pkg, otherPackages) };
  });
  const healthyClientPackages = packageBalanceRows.filter((row) => row.state === "healthy");
  const attentionClientPackages = packageBalanceRows.filter(
    (row) => row.state === "low" || row.state === "depleted" || row.state === "expired",
  );

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow="Offer setup"
        title="Packages"
        description="Monitor client package balances first, then manage the reusable package templates your studio sells."
        actions={(
          <>
            <Link href="/app/sell?type=package" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95">
              Sell package
            </Link>
            <Link href="/app/packages/new" className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]">
              New template
            </Link>
          </>
        )}
      />

      <CompactSummaryStrip
        className="rounded-2xl border border-[var(--brand-border)] bg-white"
        items={[
          { key: "client-packages", label: "Client packages", value: clientPackages.length, detail: "Active balances" },
          { key: "healthy", label: "Healthy", value: healthyClientPackages.length, detail: "No immediate attention", tone: "success" as const },
          { key: "attention", label: "Needs attention", value: attentionClientPackages.length, detail: "Low, depleted, or expired", tone: attentionClientPackages.length ? "warning" as const : "default" as const },
          { key: "templates", label: "Templates", value: packageTemplates.length, detail: `${activeCount} available · ${archivedCount} archived` },
        ]}
      />

      <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Client balances
            </p>
            <h2 className="mt-1 text-xl font-semibold text-[var(--brand-text)]">
              Active Client Packages
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              See which clients are healthy and which package balances need attention before the next booking.
            </p>
          </div>
          <Link
            href="/app/packages/client-balances"
            className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
          >
            View all balances
          </Link>
        </div>

        <div className="mt-5 space-y-3">
          {clientPackages.length === 0 ? (
            <SellWorkspaceEmptyState
              title="No active client packages"
              description="Sell a package from the Sell workspace when a client is ready to purchase credits."
              compact
            />
          ) : (
            packageBalanceRows.slice(0, 12).map(({ pkg, state }) => (
              <Link
                key={pkg.id}
                href={`/app/clients/${pkg.client_id}?tab=billing`}
                className="flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 transition hover:bg-white hover:shadow-sm sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-[var(--brand-text)]">
                      {clientName(pkg.clients)}
                    </p>
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${packageBalanceBadgeClass(state)}`}>
                      {state === "healthy"
                        ? "Healthy"
                        : state === "low"
                          ? "Low balance"
                          : state === "depleted"
                            ? "Depleted"
                            : state === "expired"
                              ? "Expired"
                              : "Inactive"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-slate-600">{pkg.name_snapshot}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {pkg.expiration_date ? `Expires ${pkg.expiration_date}` : "No expiration date"}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-medium text-[var(--brand-primary)]">
                  Open billing
                </span>
              </Link>
            ))
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
        <div className="flex flex-col gap-4 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-accent-dark)]">
              Offer setup
            </p>
            <h2 className="mt-1 text-xl font-semibold text-[var(--brand-text)]">
              Package Templates
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Manage reusable package offers. Selling remains in the unified Sell workflow.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              href="/app/sell?type=package"
              className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95"
            >
              Sell package
            </Link>
            <Link
              href="/app/packages/new"
              className="rounded-xl border border-[var(--brand-border)] bg-white px-4 py-2 text-sm font-semibold text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
            >
              New template
            </Link>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr className="text-left text-slate-600">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Included Items</th>
                <th className="px-4 py-3 font-medium">Price</th>
                <th className="px-4 py-3 font-medium">Expiration</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {packageTemplates.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    <SellWorkspaceEmptyState
                      title="No package templates yet"
                      description="Create a reusable package to sell lesson, class, or practice credits."
                      compact
                    />
                  </td>
                </tr>
              ) : (
                packageTemplates.map((pkg) => (
                  <tr key={pkg.id} className="border-t align-top">
                    <td className="px-4 py-3 font-medium text-slate-900">
                      <Link href={`/app/packages/${pkg.id}`} className="hover:underline">
                        {pkg.name}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {formatPackageItems(pkg.package_template_items)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {formatCurrency(pkg.price)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {pkg.expiration_days ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${templateBadgeClass(
                          pkg.active,
                        )}`}
                      >
                        {pkg.active ? "Available" : "Archived"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/app/packages/${pkg.id}`}
                          className="rounded-lg px-2 py-1 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                        >
                          View
                        </Link>
                        <Link
                          href={`/app/packages/${pkg.id}/edit`}
                          className="rounded-lg px-2 py-1 text-sm font-medium text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                        >
                          Edit
                        </Link>

                        {pkg.active ? (
                          <form action={archivePackageTemplateAction}>
                            <input type="hidden" name="packageTemplateId" value={pkg.id} />
                            <input type="hidden" name="returnTo" value="/app/packages" />
                            <button
                              type="submit"
                              className="rounded-lg px-2 py-1 text-sm font-medium text-amber-700 hover:bg-amber-50"
                            >
                              Archive
                            </button>
                          </form>
                        ) : (
                          <form action={reactivatePackageTemplateAction}>
                            <input type="hidden" name="packageTemplateId" value={pkg.id} />
                            <input type="hidden" name="returnTo" value="/app/packages" />
                            <button
                              type="submit"
                              className="rounded-lg px-2 py-1 text-sm font-medium text-emerald-700 hover:bg-emerald-50"
                            >
                              Restore
                            </button>
                          </form>
                        )}

                        {!pkg.active ? (
                          <form action={deletePackageTemplateAction}>
                            <input type="hidden" name="packageTemplateId" value={pkg.id} />
                            <button
                              type="submit"
                              className="rounded-lg px-2 py-1 text-sm font-medium text-rose-700 hover:bg-rose-50"
                            >
                              Delete if unused
                            </button>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
