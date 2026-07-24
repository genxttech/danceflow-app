import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import SellWorkspaceHeader from "@/components/app/sell/SellWorkspaceHeader";
import SellWorkspaceFeedback from "@/components/app/sell/SellWorkspaceFeedback";
import CompactSummaryStrip from "@/components/app/workspace/CompactSummaryStrip";
import SellWorkspaceEmptyState from "@/components/app/sell/SellWorkspaceEmptyState";
import { canManageCommerce } from "@/lib/auth/permissions";
import CatalogItemForm from "./CatalogItemForm";
import { setCatalogItemActiveAction } from "./actions";

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
  marketplace_visible: boolean;
};


type VariantInventorySummary = {
  catalog_item_id: string;
  active: boolean;
  reorder_threshold: number | null;
  quantity_on_hand: number | null;
};

function money(value: number | string, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD",
  }).format(Number(value ?? 0));
}

function label(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}


function catalogItemHref(item: CatalogItem) {
  return ["digital_video", "video_series", "digital_download"].includes(
    item.item_type,
  )
    ? `/app/catalog/${item.id}/digital`
    : `/app/catalog/${item.id}`;
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (
    !context.isPlatformAdmin &&
    !canManageCommerce(context.studioRole)
  ) {
    redirect("/app");
  }

  const [
    { data, error },
    { data: variantInventoryRows, error: variantInventoryError },
  ] = await Promise.all([
    supabase
      .from("commerce_catalog_items")
      .select(
        "id, name, description, item_type, sku, price, currency, taxable, active, published, marketplace_visible",
      )
      .eq("studio_id", context.studioId)
      .order("active", { ascending: false })
      .order("name", { ascending: true }),
    supabase
      .from("commerce_product_variant_inventory")
      .select(
        "catalog_item_id, active, reorder_threshold, quantity_on_hand",
      )
      .eq("studio_id", context.studioId),
  ]);

  if (error) {
    throw new Error(`Catalog failed to load: ${error.message}`);
  }

  if (variantInventoryError) {
    throw new Error(
      `Inventory summary failed to load: ${variantInventoryError.message}`,
    );
  }

  const items = (data ?? []) as CatalogItem[];
  const variantInventory = (variantInventoryRows ??
    []) as VariantInventorySummary[];
  const inventoryByItemId = variantInventory.reduce<
    Record<string, { variants: number; onHand: number; lowStock: number }>
  >((map, row) => {
    const current = map[row.catalog_item_id] ?? {
      variants: 0,
      onHand: 0,
      lowStock: 0,
    };

    if (row.active) {
      const onHand = Number(row.quantity_on_hand ?? 0);
      const threshold = Number(row.reorder_threshold ?? 0);

      current.variants += 1;
      current.onHand += onHand;
      current.lowStock += onHand <= threshold ? 1 : 0;
    }

    map[row.catalog_item_id] = current;
    return map;
  }, {});
  const physical = items.filter((item) => item.item_type === "physical_product");
  const digital = items.filter((item) =>
    ["digital_video", "video_series", "digital_download"].includes(item.item_type),
  );

  return (
    <div className="space-y-6 p-1">
      <SellWorkspaceHeader
        role={context.studioRole}
        isPlatformAdmin={context.isPlatformAdmin}
        eyebrow="Products and content"
        title="Catalog"
        description="Manage physical products, digital content, and services from one source of truth while packages and memberships remain connected to their operational workflows."
        actions={<CatalogItemForm />}
      />

      {params.error ? (
        <SellWorkspaceFeedback tone="error">
          {decodeURIComponent(params.error)}
        </SellWorkspaceFeedback>
      ) : null}

      {params.success ? (
        <SellWorkspaceFeedback tone="success">Catalog updated.</SellWorkspaceFeedback>
      ) : null}

      <CompactSummaryStrip
        className="rounded-2xl border border-[var(--brand-border)] bg-white"
        items={[
          { key: "items", label: "Catalog items", value: items.length, detail: "All products and content" },
          { key: "physical", label: "Physical", value: physical.length, detail: "Retail products" },
          { key: "digital", label: "Digital", value: digital.length, detail: "Videos and downloads" },
          { key: "low-stock", label: "Low stock", value: variantInventory.filter((variant) => variant.active && Number(variant.quantity_on_hand ?? 0) <= Number(variant.reorder_threshold ?? 0)).length, detail: "Variants needing review", tone: "warning" as const },
        ]}
      />

      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <Boxes className="mt-1 h-5 w-5 text-[var(--brand-primary)]" />
          <div>
            <h2 className="text-xl font-semibold text-slate-950">Sellable items</h2>
            <p className="mt-1 text-sm text-slate-600">
              Inventory, video assets, entitlements, and fulfillment are added
              through dedicated commerce slices rather than overloading this
              shared catalog record.
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-3">
          {items.length === 0 ? (
            <SellWorkspaceEmptyState
              title="No catalog items yet"
              description="Add a physical product, video, download, or service to begin building your studio catalog."
            />
          ) : (
            items.map((item) => (
              <article
                key={item.id}
                className="flex flex-col gap-4 rounded-2xl border border-slate-200 p-4 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
                    <Link
                      href={catalogItemHref(item)}
                      className="font-semibold text-slate-950 hover:text-[var(--brand-primary)]"
                    >
                      {item.name}
                    </Link>
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                      {label(item.item_type)}
                    </span>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      item.active
                        ? "bg-emerald-50 text-emerald-700"
                        : "bg-slate-100 text-slate-600"
                    }`}>
                      {item.active ? "Active" : "Archived"}
                    </span>
                    {item.published ? (
                      <span className="rounded-full bg-purple-50 px-2.5 py-1 text-xs font-medium text-purple-700">
                        Marketplace
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 break-words text-sm text-slate-600">
                    <span className="line-clamp-2">
                      {item.description || "No description"}
                    </span>
                    <span className="mt-1 block font-medium text-slate-700">
                      {money(item.price, item.currency)}
                      {item.sku ? ` · ${item.sku}` : ""}
                    </span>
                  </p>
                  {item.item_type === "physical_product" ? (
                    <p className="mt-2 text-xs font-medium text-slate-500">
                      {inventoryByItemId[item.id]?.variants ?? 0} active variants ·{" "}
                      {inventoryByItemId[item.id]?.onHand ?? 0} units on hand ·{" "}
                      {inventoryByItemId[item.id]?.lowStock ?? 0} low stock
                    </p>
                  ) : null}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={catalogItemHref(item)}
                    className="w-full rounded-xl bg-[var(--brand-primary-soft)] px-3 py-2.5 text-center text-sm font-semibold text-[var(--brand-primary)] sm:w-auto"
                  >
                    Manage
                  </Link>
                <form action={setCatalogItemActiveAction}>
                  <input type="hidden" name="itemId" value={item.id} />
                  <input type="hidden" name="active" value={item.active ? "false" : "true"} />
                  <button className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 sm:w-auto">
                    {item.active ? "Archive" : "Reactivate"}
                  </button>
                </form>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
