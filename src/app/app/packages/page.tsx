import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { deactivatePackageTemplateAction } from "./actions";
import { canManagePackages } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to load package templates: ${error.message}`);
  }

  const packageTemplates = (data ?? []) as PackageRow[];
  const activeCount = packageTemplates.filter((pkg) => pkg.active).length;
  const inactiveCount = packageTemplates.filter((pkg) => !pkg.active).length;

  return (
    <div className="space-y-8">
      <section className="rounded-[32px] border border-white/15 bg-[linear-gradient(135deg,#0d1536_0%,#111b45_50%,#5b145e_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">DanceFlow</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">Package Templates</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Build reusable lesson, group class, and party credit packages for quick sales.
            </p>
          </div>
          <Link href="/app/packages/new" className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white/90">New Package Template</Link>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Total Templates</p>
          <p className="mt-2 text-3xl font-semibold">{packageTemplates.length}</p>
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

      <div className="overflow-hidden rounded-2xl border bg-white">
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
                  No package templates yet.
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
                  <td className="px-4 py-3 text-slate-600">
                    {pkg.active ? "active" : "inactive"}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/app/packages/${pkg.id}`}
                        className="text-slate-900 underline"
                      >
                        View
                      </Link>
                      <Link
                        href={`/app/packages/${pkg.id}/edit`}
                        className="text-slate-900 underline"
                      >
                        Edit
                      </Link>
                      {pkg.active ? (
                        <form action={deactivatePackageTemplateAction}>
                          <input type="hidden" name="packageTemplateId" value={pkg.id} />
                          <button type="submit" className="text-red-600 underline">
                            Deactivate
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