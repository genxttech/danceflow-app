"use client";

import { useMemo, useState } from "react";
import {
  adjustInventoryAction,
  createProductVariantAction,
} from "@/app/app/catalog/actions";

type Variant = {
  id: string;
  name: string;
  sku: string | null;
  quantityOnHand: number;
};

export default function InventoryForms({
  catalogItemId,
  variants,
}: {
  catalogItemId: string;
  variants: Variant[];
}) {
  const [variantOpen, setVariantOpen] = useState(false);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState(
    variants[0]?.id ?? "",
  );

  const selectedVariant = useMemo(
    () => variants.find((variant) => variant.id === selectedVariantId) ?? null,
    [selectedVariantId, variants],
  );

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-primary)]">
              Product setup
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Add a variant
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Create size, color, style, or single-item variants without
              duplicating the parent catalog product.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setVariantOpen((current) => !current)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
          >
            {variantOpen ? "Close" : "Add variant"}
          </button>
        </div>

        {variantOpen ? (
          <form action={createProductVariantAction} className="mt-5 space-y-4">
            <input type="hidden" name="catalogItemId" value={catalogItemId} />

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Variant name
                <input
                  name="name"
                  required
                  maxLength={120}
                  placeholder="Small / Black"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                SKU
                <input
                  name="sku"
                  maxLength={80}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Size
                <input
                  name="size"
                  maxLength={80}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Color
                <input
                  name="color"
                  maxLength={80}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Unit cost
                <input
                  name="unitCost"
                  inputMode="decimal"
                  placeholder="0.00"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Price override
                <input
                  name="priceOverride"
                  inputMode="decimal"
                  placeholder="Use catalog price"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Reorder threshold
                <input
                  name="reorderThreshold"
                  type="number"
                  min="0"
                  defaultValue="0"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Barcode
                <input
                  name="barcode"
                  maxLength={120}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>
            </div>

            <button className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
              Create variant
            </button>
          </form>
        ) : null}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[var(--brand-primary)]">
              Stock control
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-950">
              Adjust inventory
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Receive merchandise, correct counts, or record damaged and lost
              units through an auditable ledger.
            </p>
          </div>
          <button
            type="button"
            disabled={variants.length === 0}
            onClick={() => setAdjustmentOpen((current) => !current)}
            className="rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"
          >
            {adjustmentOpen ? "Close" : "Adjust stock"}
          </button>
        </div>

        {adjustmentOpen ? (
          <form action={adjustInventoryAction} className="mt-5 space-y-4">
            <input type="hidden" name="catalogItemId" value={catalogItemId} />

            <label className="block space-y-2 text-sm font-medium text-slate-700">
              Variant
              <select
                name="variantId"
                value={selectedVariantId}
                onChange={(event) => setSelectedVariantId(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
              >
                {variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.name} · {variant.quantityOnHand} on hand
                  </option>
                ))}
              </select>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="space-y-2 text-sm font-medium text-slate-700">
                Quantity change
                <input
                  name="quantityDelta"
                  type="number"
                  required
                  placeholder="Use negative to reduce"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-slate-700">
                Reason
                <select
                  name="reason"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
                >
                  <option value="received">Inventory received</option>
                  <option value="opening_balance">Opening balance</option>
                  <option value="return">Customer return</option>
                  <option value="exchange">Exchange adjustment</option>
                  <option value="damaged">Damaged</option>
                  <option value="lost">Lost</option>
                  <option value="correction">Count correction</option>
                </select>
              </label>
            </div>

            <label className="block space-y-2 text-sm font-medium text-slate-700">
              Notes
              <textarea
                name="notes"
                rows={3}
                maxLength={500}
                className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
              />
            </label>

            {selectedVariant ? (
              <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
                Current stock for {selectedVariant.name}:{" "}
                {selectedVariant.quantityOnHand}
              </p>
            ) : null}

            <button className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">
              Save adjustment
            </button>
          </form>
        ) : null}
      </section>
    </div>
  );
}
