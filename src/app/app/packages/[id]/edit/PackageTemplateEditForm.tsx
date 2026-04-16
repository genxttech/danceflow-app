"use client";

import { useActionState } from "react";
import { updatePackageTemplateAction } from "../../actions";

const initialState = { error: "" };

type PackageItem = {
  id: string;
  usage_type: string;
  quantity: number | null;
  is_unlimited: boolean;
};

type PackageTemplateRecord = {
  id: string;
  name: string;
  description: string | null;
  price: number;
  expiration_days: number | null;
  active: boolean;
  package_template_items: PackageItem[];
};

function getItem(
  items: PackageItem[],
  usageType: "private_lesson" | "group_class" | "practice_party"
) {
  return items.find((item) => item.usage_type === usageType);
}

function PackageItemRow({
  title,
  usageKey,
  item,
}: {
  title: string;
  usageKey: "private_lesson" | "group_class" | "practice_party";
  item?: PackageItem;
}) {
  return (
    <div className="rounded-xl border p-4">
      <p className="font-medium">{title}</p>

      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name={`${usageKey}_included`}
            defaultChecked={!!item}
          />
          Included
        </label>

        <div>
          <label className="mb-1 block text-sm font-medium">Quantity</label>
          <input
            name={`${usageKey}_quantity`}
            type="number"
            min="0"
            step="0.25"
            defaultValue={item?.quantity ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <label className="flex items-center gap-2 text-sm md:mt-7">
          <input
            type="checkbox"
            name={`${usageKey}_unlimited`}
            defaultChecked={item?.is_unlimited ?? false}
          />
          Unlimited
        </label>
      </div>
    </div>
  );
}

export default function PackageTemplateEditForm({
  pkg,
}: {
  pkg: PackageTemplateRecord;
}) {
  const [state, formAction, pending] = useActionState(
    updatePackageTemplateAction,
    initialState
  );

  const privateItem = getItem(pkg.package_template_items, "private_lesson");
  const groupItem = getItem(pkg.package_template_items, "group_class");
  const practiceItem = getItem(pkg.package_template_items, "practice_party");

  return (
    <div className="max-w-4xl">
      <h2 className="text-3xl font-semibold tracking-tight">Edit Package Template</h2>
      <p className="mt-2 text-slate-600">Update package template details.</p>

      <form action={formAction} className="mt-8 space-y-6 rounded-2xl border bg-white p-6">
        <input type="hidden" name="packageTemplateId" value={pkg.id} />

        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Package Name
          </label>
          <input
            id="name"
            name="name"
            defaultValue={pkg.name}
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div>
          <label htmlFor="description" className="mb-1 block text-sm font-medium">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={4}
            defaultValue={pkg.description ?? ""}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="price" className="mb-1 block text-sm font-medium">
              Price
            </label>
            <input
              id="price"
              name="price"
              type="number"
              min="0"
              step="0.01"
              defaultValue={pkg.price}
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="expirationDays" className="mb-1 block text-sm font-medium">
              Expiration Days
            </label>
            <input
              id="expirationDays"
              name="expirationDays"
              type="number"
              min="0"
              defaultValue={pkg.expiration_days ?? ""}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="active" className="mb-1 block text-sm font-medium">
              Status
            </label>
            <select
              id="active"
              name="active"
              defaultValue={pkg.active ? "true" : "false"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold">Included Items</h3>
          <div className="mt-4 space-y-4">
            <PackageItemRow
              title="Private Lessons"
              usageKey="private_lesson"
              item={privateItem}
            />
            <PackageItemRow
              title="Group Classes"
              usageKey="group_class"
              item={groupItem}
            />
            <PackageItemRow
              title="Practice Parties"
              usageKey="practice_party"
              item={practiceItem}
            />
          </div>
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Changes"}
          </button>

          <a
            href={`/app/packages/${pkg.id}`}
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}