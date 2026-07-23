"use client";

import { useState } from "react";
import { createCatalogItemAction } from "./actions";

const TYPES = [
  ["physical_product", "Physical product"],
  ["digital_video", "Video"],
  ["video_series", "Video series"],
  ["digital_download", "Digital download"],
  ["service", "Service"],
] as const;

export default function CatalogItemForm() {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-[var(--brand-primary)] hover:bg-white/90 sm:w-auto"
      >
        Add catalog item
      </button>
    );
  }

  return (
    <form
      action={createCatalogItemAction}
      className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-primary)]">
            New catalog item
          </p>
          <h2 className="mt-2 text-xl font-semibold text-slate-950">
            Add something to sell
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-sm font-semibold text-slate-500"
        >
          Close
        </button>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm font-medium text-slate-700">
          Name
          <input
            name="name"
            required
            maxLength={160}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          Type
          <select
            name="itemType"
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          >
            {TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          Price
          <input
            name="price"
            required
            inputMode="decimal"
            placeholder="0.00"
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>

        <label className="space-y-2 text-sm font-medium text-slate-700">
          SKU / internal code
          <input
            name="sku"
            maxLength={80}
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
          />
        </label>
      </div>

      <label className="mt-4 block space-y-2 text-sm font-medium text-slate-700">
        Description
        <textarea
          name="description"
          rows={4}
          maxLength={2000}
          className="w-full rounded-xl border border-slate-300 px-3 py-2.5"
        />
      </label>

      <div className="mt-4 flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="taxable" />
          Taxable
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="published" />
          Publish to marketplace
        </label>
      </div>

      <button className="mt-5 w-full rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white sm:w-auto">
        Create item
      </button>
    </form>
  );
}
