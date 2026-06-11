import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  archivePackageTemplateAction,
  deletePackageTemplateAction,
  reactivatePackageTemplateAction,
} from "../actions";
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

function statusBadgeClass(active: boolean) {
  return active
    ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
    : "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
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
    <div className="mx-auto max-w-5xl space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Packages
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                {pkg.name}
              </h1>
              <span
                className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${statusBadgeClass(
                  pkg.active,
                )}`}
              >
                {pkg.active ? "Available for sale" : "Archived"}
              </span>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Review the package setup, included credits, and whether this template is visible to staff for new sales.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/packages/${pkg.id}/edit`}
              className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white/90"
            >
              Edit Template
            </Link>
            <Link
              href="/app/packages"
              className="rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            >
              Back to Packages
            </Link>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Price</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
            {formatCurrency(pkg.price)}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Expiration</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
            {pkg.expiration_days ? `${pkg.expiration_days} days` : "No expiration"}
          </p>
        </div>

        <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
          <p className="text-sm text-slate-500">Included Credit Types</p>
          <p className="mt-2 text-2xl font-semibold text-[var(--brand-text)]">
            {pkg.package_template_items.length}
          </p>
        </div>
      </div>

      <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[var(--brand-text)]">
          Description
        </h2>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-700">
          {pkg.description ?? "No description has been added yet."}
        </p>
      </div>

      <div className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-[var(--brand-text)]">
          Included Items
        </h2>

        <div className="mt-4 space-y-3">
          {pkg.package_template_items.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-6 text-sm text-slate-600">
              No items configured.
            </p>
          ) : (
            pkg.package_template_items.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-surface)] px-4 py-3"
              >
                <span className="font-semibold text-[var(--brand-text)]">
                  {usageLabel(item.usage_type)}
                </span>
                <span className="text-slate-600">
                  : {item.is_unlimited ? "Unlimited" : item.quantity}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="rounded-[28px] border border-amber-200 bg-amber-50/50 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Template cleanup</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          Archive templates that should no longer appear in new sales. Delete is only safe when the template has never been sold; otherwise DanceFlow archives it to preserve client history and reporting.
        </p>

        <div className="mt-5 flex flex-wrap gap-3">
          {pkg.active ? (
            <form action={archivePackageTemplateAction}>
              <input type="hidden" name="packageTemplateId" value={pkg.id} />
              <input type="hidden" name="returnTo" value={`/app/packages/${pkg.id}`} />
              <button
                type="submit"
                className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
              >
                Archive Template
              </button>
            </form>
          ) : (
            <form action={reactivatePackageTemplateAction}>
              <input type="hidden" name="packageTemplateId" value={pkg.id} />
              <input type="hidden" name="returnTo" value={`/app/packages/${pkg.id}`} />
              <button
                type="submit"
                className="rounded-xl border border-emerald-200 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
              >
                Restore Template
              </button>
            </form>
          )}

          <form action={deletePackageTemplateAction}>
            <input type="hidden" name="packageTemplateId" value={pkg.id} />
            <button
              type="submit"
              className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 hover:bg-rose-50"
            >
              Delete if Unused
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
