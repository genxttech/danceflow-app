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

  const { data, error } = await supabase
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
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load package templates: ${error.message}`);
  }

  const packageTemplates = (data ?? []) as PackageRow[];
  const activeCount = packageTemplates.filter((pkg) => pkg.active).length;
  const archivedCount = packageTemplates.filter((pkg) => !pkg.active).length;

  return (
    <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow="Offer setup"
        title="Package Templates"
        description="Build reusable lesson, group class, and party-credit packages for quick sales while preserving historical sales records."
        actions={(
          <Link href="/app/packages/new" className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-sm font-semibold text-white hover:opacity-95">
            New package template
          </Link>
        )}
      />

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Total Templates</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {packageTemplates.length}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Available for Sale</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {activeCount}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Archived</p>
          <p className="mt-2 text-3xl font-semibold text-[var(--brand-text)]">
            {archivedCount}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
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
                  No package templates yet. Create your first reusable package when you are ready to sell lesson or class credits.
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
                            Delete if Unused
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
    </div>
  );
}
