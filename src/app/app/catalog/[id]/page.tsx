import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  History,
  Package,
  Tags,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageCommerce } from "@/lib/auth/permissions";
import {
  setProductVariantActiveAction,
} from "@/app/app/catalog/actions";
import InventoryForms from "./InventoryForms";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ error?: string; success?: string }>;

type CatalogItem = {
  id: string;
  name: string;
  description: string | null;
  item_type: string;
  sku: string | null;
  price: number | string;
  currency: string;
  taxable: boolean;
  active: boolean;
  published: boolean;
};

type VariantRow = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  size: string | null;
  color: string | null;
  unit_cost: number | string | null;
  price_override: number | string | null;
  reorder_threshold: number | null;
  active: boolean;
  quantity_on_hand: number | null;
};

type LedgerRow = {
  id: string;
  quantity_delta: number;
  quantity_after: number;
  reason: string;
  notes: string | null;
  created_at: string;
  commerce_product_variants:
    | { name: string; sku: string | null }
    | { name: string; sku: string | null }[]
    | null;
};

function money(value: number | string | null, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(Number(value ?? 0));
}

function relation<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

export default async function CatalogItemPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const messages = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.isPlatformAdmin &&
    !canManageCommerce(context.studioRole)
  ) {
    redirect("/app");
  }

  const [
    { data: item, error: itemError },
    { data: variantRows, error: variantError },
    { data: ledgerRows, error: ledgerError },
  ] = await Promise.all([
    supabase
      .from("commerce_catalog_items")
      .select(
        "id, name, description, item_type, sku, price, currency, taxable, active, published",
      )
      .eq("id", id)
      .eq("studio_id", context.studioId)
      .maybeSingle(),
    supabase
      .from("commerce_product_variant_inventory")
      .select(
        "id, name, sku, barcode, size, color, unit_cost, price_override, reorder_threshold, active, quantity_on_hand",
      )
      .eq("catalog_item_id", id)
      .eq("studio_id", context.studioId)
      .order("active", { ascending: false })
      .order("name", { ascending: true }),
    supabase
      .from("commerce_inventory_ledger")
      .select(
        "id, quantity_delta, quantity_after, reason, notes, created_at, commerce_product_variants(name, sku)",
      )
      .eq("catalog_item_id", id)
      .eq("studio_id", context.studioId)
      .order("created_at", { ascending: false })
      .limit(100),
  ]);

  if (itemError) {
    throw new Error(`Catalog item failed to load: ${itemError.message}`);
  }

  if (!item) {
    notFound();
  }

  if (variantError) {
    throw new Error(`Variants failed to load: ${variantError.message}`);
  }

  if (ledgerError) {
    throw new Error(`Inventory history failed to load: ${ledgerError.message}`);
  }

  const catalogItem = item as CatalogItem;

  if (
    ["digital_video", "video_series", "digital_download"].includes(
      catalogItem.item_type,
    )
  ) {
    redirect(`/app/catalog/${catalogItem.id}/digital`);
  }

  const variants = (variantRows ?? []) as VariantRow[];
  const ledger = (ledgerRows ?? []) as LedgerRow[];
  const activeVariants = variants.filter((variant) => variant.active);
  const totalOnHand = activeVariants.reduce(
    (sum, variant) => sum + Number(variant.quantity_on_hand ?? 0),
    0,
  );
  const lowStock = activeVariants.filter(
    (variant) =>
      Number(variant.quantity_on_hand ?? 0) <=
      Number(variant.reorder_threshold ?? 0),
  );
  const inventoryValue = activeVariants.reduce(
    (sum, variant) =>
      sum +
      Number(variant.quantity_on_hand ?? 0) *
        Number(variant.unit_cost ?? 0),
    0,
  );

  return (
    <div className="space-y-6 p-1">
      <section className="rounded-[32px] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <Link
          href="/app/catalog"
          className="inline-flex items-center gap-2 text-sm font-semibold text-white/80"
        >
          <ArrowLeft className="h-4 w-4" />
          Catalog
        </Link>

        <div className="mt-5 flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">
              Physical product
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              {catalogItem.name}
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/80">
              {catalogItem.description || "No product description yet."}
            </p>
          </div>

          <div className="rounded-2xl border border-white/15 bg-white/10 p-4 text-sm">
            <p className="text-white/70">Catalog price</p>
            <p className="mt-1 text-2xl font-semibold">
              {money(catalogItem.price, catalogItem.currency)}
            </p>
            <p className="mt-1 text-xs text-white/65">
              {catalogItem.sku || "No parent SKU"} ·{" "}
              {catalogItem.taxable ? "Taxable" : "Not taxable"}
            </p>
          </div>
        </div>
      </section>

      {messages.error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
          {decodeURIComponent(messages.error)}
        </div>
      ) : null}

      {messages.success ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          Product inventory updated.
        </div>
      ) : null}

      {catalogItem.item_type !== "physical_product" ? (
        <section className="rounded-3xl border border-amber-200 bg-amber-50 p-6 text-amber-950">
          Inventory controls are available only for physical products. Digital
          content, downloads, and services use their own fulfillment workflows.
        </section>
      ) : (
        <>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              {
                title: "Active variants",
                value: activeVariants.length,
                icon: Tags,
              },
              {
                title: "Units on hand",
                value: totalOnHand,
                icon: Boxes,
              },
              {
                title: "Low stock",
                value: lowStock.length,
                icon: AlertTriangle,
              },
              {
                title: "Inventory cost value",
                value: money(inventoryValue),
                icon: Package,
              },
            ].map((stat) => {
              const Icon = stat.icon;

              return (
                <div
                  key={stat.title}
                  className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <Icon className="h-5 w-5 text-[var(--brand-primary)]" />
                  <p className="mt-4 text-sm text-slate-500">{stat.title}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">
                    {stat.value}
                  </p>
                </div>
              );
            })}
          </section>

          <InventoryForms
            catalogItemId={catalogItem.id}
            variants={activeVariants.map((variant) => ({
              id: variant.id,
              name: variant.name,
              sku: variant.sku,
              quantityOnHand: Number(variant.quantity_on_hand ?? 0),
            }))}
          />

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <Tags className="mt-1 h-5 w-5 text-[var(--brand-primary)]" />
              <div>
                <h2 className="text-xl font-semibold text-slate-950">
                  Variants and stock
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Inventory remains attached to variants so size and color
                  counts do not overwrite each other.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {variants.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                  Add at least one variant before receiving inventory.
                </div>
              ) : (
                variants.map((variant) => {
                  const onHand = Number(variant.quantity_on_hand ?? 0);
                  const threshold = Number(variant.reorder_threshold ?? 0);
                  const isLow = variant.active && onHand <= threshold;

                  return (
                    <article
                      key={variant.id}
                      className="rounded-2xl border border-slate-200 p-4"
                    >
                      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold text-slate-950">
                              {variant.name}
                            </h3>
                            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              variant.active
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-slate-100 text-slate-600"
                            }`}>
                              {variant.active ? "Active" : "Archived"}
                            </span>
                            {isLow ? (
                              <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-800">
                                Low stock
                              </span>
                            ) : null}
                          </div>
                          <p className="mt-2 text-sm text-slate-600">
                            {[variant.size, variant.color, variant.sku]
                              .filter(Boolean)
                              .join(" · ") || "No variant details"}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-3">
                          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
                            <p className="text-slate-500">On hand</p>
                            <p className="font-semibold text-slate-950">{onHand}</p>
                          </div>
                          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
                            <p className="text-slate-500">Reorder at</p>
                            <p className="font-semibold text-slate-950">{threshold}</p>
                          </div>
                          <div className="rounded-xl bg-slate-50 px-4 py-3 text-sm">
                            <p className="text-slate-500">Unit cost</p>
                            <p className="font-semibold text-slate-950">
                              {variant.unit_cost == null
                                ? "—"
                                : money(variant.unit_cost)}
                            </p>
                          </div>
                          <form action={setProductVariantActiveAction}>
                            <input
                              type="hidden"
                              name="catalogItemId"
                              value={catalogItem.id}
                            />
                            <input type="hidden" name="variantId" value={variant.id} />
                            <input
                              type="hidden"
                              name="active"
                              value={variant.active ? "false" : "true"}
                            />
                            <button className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">
                              {variant.active ? "Archive" : "Reactivate"}
                            </button>
                          </form>
                        </div>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-start gap-3">
              <History className="mt-1 h-5 w-5 text-[var(--brand-primary)]" />
              <div>
                <h2 className="text-xl font-semibold text-slate-950">
                  Inventory history
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Every stock movement keeps its actor, reason, before-and-after
                  count, notes, and timestamp.
                </p>
              </div>
            </div>

            <div className="mt-5 space-y-3">
              {ledger.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
                  No inventory movements have been recorded.
                </div>
              ) : (
                ledger.map((entry) => {
                  const variant = relation(entry.commerce_product_variants);

                  return (
                    <div
                      key={entry.id}
                      className="flex flex-col gap-3 rounded-2xl bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div>
                        <p className="font-semibold text-slate-950">
                          {variant?.name ?? "Variant"} ·{" "}
                          {entry.reason.replaceAll("_", " ")}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {new Date(entry.created_at).toLocaleString()}
                          {entry.notes ? ` · ${entry.notes}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className={`font-semibold ${
                          entry.quantity_delta > 0
                            ? "text-emerald-700"
                            : "text-rose-700"
                        }`}>
                          {entry.quantity_delta > 0 ? "+" : ""}
                          {entry.quantity_delta}
                        </p>
                        <p className="text-xs text-slate-500">
                          {entry.quantity_after} on hand
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
