import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type PackageTemplateDetail = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  expiration_days: number | null;
  active: boolean;
  package_template_items: {
    id: string;
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return value;
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value));
}

export default async function PackageTemplateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  const studioId = context.studioId;

  const { data, error } = await supabase
    .from("package_templates")
    .select(`
      id,
      name,
      description,
      price,
      expiration_days,
      active,
      package_template_items (
        id,
        usage_type,
        quantity,
        is_unlimited
      )
    `)
    .eq("id", id)
    .eq("studio_id", studioId)
    .single();

  if (error || !data) {
    notFound();
  }

  const pkg = data as PackageTemplateDetail;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">{pkg.name}</h2>
          <p className="mt-2 text-slate-600">Package template detail</p>
        </div>

        <div className="flex gap-3">
          <Link
            href={`/app/packages/${pkg.id}/edit`}
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Edit Package Template
          </Link>
          <Link
            href="/app/packages"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Packages
          </Link>
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Price</p>
          <p className="mt-1 font-medium">{formatCurrency(pkg.price)}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Expiration Days</p>
          <p className="mt-1 font-medium">{pkg.expiration_days ?? "—"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5">
          <p className="text-sm text-slate-500">Status</p>
          <p className="mt-1 font-medium">{pkg.active ? "active" : "inactive"}</p>
        </div>

        <div className="rounded-2xl border bg-white p-5 md:col-span-2">
          <p className="text-sm text-slate-500">Description</p>
          <p className="mt-1 whitespace-pre-wrap text-slate-700">
            {pkg.description ?? "—"}
          </p>
        </div>

        <div className="rounded-2xl border bg-white p-5 md:col-span-2">
          <p className="text-sm text-slate-500">Included Items</p>
          <div className="mt-3 space-y-2">
            {pkg.package_template_items.length === 0 ? (
              <p className="text-slate-600">No items configured.</p>
            ) : (
              pkg.package_template_items.map((item) => (
                <div key={item.id} className="rounded-xl bg-slate-50 px-3 py-2">
                  <span className="font-medium">{usageLabel(item.usage_type)}:</span>{" "}
                  {item.is_unlimited ? "Unlimited" : item.quantity}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}