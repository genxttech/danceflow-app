"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  archivePackageTemplateAction,
  deletePackageTemplateAction,
  reactivatePackageTemplateAction,
  updatePackageTemplateAction,
} from "../../actions";

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
  usageType: "private_lesson" | "group_class" | "practice_party",
) {
  return items.find((item) => item.usage_type === usageType);
}

function PackageItemRow({
  title,
  subtitle,
  usageKey,
  item,
}: {
  title: string;
  subtitle: string;
  usageKey: "private_lesson" | "group_class" | "practice_party";
  item?: PackageItem;
}) {
  return (
    <div className="rounded-2xl border border-[var(--brand-border)] bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="font-semibold text-[var(--brand-text)]">{title}</p>
          <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
        </div>

        <label className="inline-flex items-center gap-2 rounded-full bg-[var(--brand-surface)] px-3 py-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            name={`${usageKey}_included`}
            defaultChecked={!!item}
            className="h-4 w-4 rounded border-slate-300"
          />
          Include
        </label>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[1fr_auto]">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Quantity
          </label>
          <input
            name={`${usageKey}_quantity`}
            type="number"
            min="0"
            step="0.25"
            defaultValue={item?.quantity ?? ""}
            placeholder="Example: 5"
            className="w-full rounded-xl border border-slate-300 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave quantity blank when the item is unlimited.
          </p>
        </div>

        <label className="mt-6 inline-flex items-center gap-2 rounded-xl border border-[var(--brand-border)] px-3 py-2 text-sm font-medium text-slate-700">
          <input
            type="checkbox"
            name={`${usageKey}_unlimited`}
            defaultChecked={item?.is_unlimited ?? false}
            className="h-4 w-4 rounded border-slate-300"
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
    initialState,
  );

  const privateItem = getItem(pkg.package_template_items, "private_lesson");
  const groupItem = getItem(pkg.package_template_items, "group_class");
  const practiceItem = getItem(pkg.package_template_items, "practice_party");

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] p-6 text-white shadow-sm md:p-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              DanceFlow Packages
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
              Edit Package Template
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/75">
              Update the package clients can buy, what credits it includes, and whether staff can sell it.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href={`/app/packages/${pkg.id}`}
              className="rounded-2xl border border-white/25 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/15"
            >
              View Template
            </Link>
            <Link
              href="/app/packages"
              className="rounded-2xl bg-white px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-white/90"
            >
              Back to Packages
            </Link>
          </div>
        </div>
      </section>

      <form action={formAction} className="space-y-6">
        <input type="hidden" name="packageTemplateId" value={pkg.id} />

        <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
          <div className="border-b border-[var(--brand-border)] pb-5">
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Package Details
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Keep this wording staff-friendly. These details appear wherever the package is sold or reviewed.
            </p>
          </div>

          <div className="mt-6 grid gap-5">
            <div>
              <label htmlFor="name" className="mb-1 block text-sm font-medium text-slate-700">
                Package name
              </label>
              <input
                id="name"
                name="name"
                defaultValue={pkg.name}
                required
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
              />
            </div>

            <div>
              <label htmlFor="description" className="mb-1 block text-sm font-medium text-slate-700">
                Description
              </label>
              <textarea
                id="description"
                name="description"
                rows={4}
                defaultValue={pkg.description ?? ""}
                placeholder="Example: Best for students taking weekly private lessons."
                className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div>
                <label htmlFor="price" className="mb-1 block text-sm font-medium text-slate-700">
                  Sale price
                </label>
                <input
                  id="price"
                  name="price"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={pkg.price}
                  required
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                />
              </div>

              <div>
                <label htmlFor="expirationDays" className="mb-1 block text-sm font-medium text-slate-700">
                  Expiration days
                </label>
                <input
                  id="expirationDays"
                  name="expirationDays"
                  type="number"
                  min="0"
                  defaultValue={pkg.expiration_days ?? ""}
                  placeholder="Blank = no expiration"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                />
              </div>

              <div>
                <label htmlFor="active" className="mb-1 block text-sm font-medium text-slate-700">
                  Sale availability
                </label>
                <select
                  id="active"
                  name="active"
                  defaultValue={pkg.active ? "true" : "false"}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2 outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary)]/15"
                >
                  <option value="true">Available for sale</option>
                  <option value="false">Archived / hidden from new sales</option>
                </select>
              </div>
            </div>
          </div>
        </section>

        <section className="rounded-[28px] border border-[var(--brand-border)] bg-white p-6 shadow-sm">
          <div className="border-b border-[var(--brand-border)] pb-5">
            <h2 className="text-xl font-semibold text-[var(--brand-text)]">
              Included Credits
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              Choose what the package actually gives the client. Removed items are removed from this template after saving.
            </p>
          </div>

          <div className="mt-6 space-y-4">
            <PackageItemRow
              title="Private Lessons"
              subtitle="Credits for one-on-one lessons."
              usageKey="private_lesson"
              item={privateItem}
            />
            <PackageItemRow
              title="Group Classes"
              subtitle="Credits for group classes or recurring classes."
              usageKey="group_class"
              item={groupItem}
            />
            <PackageItemRow
              title="Practice Parties"
              subtitle="Credits for practice parties or socials."
              usageKey="practice_party"
              item={practiceItem}
            />
          </div>
        </section>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-xl bg-[var(--brand-primary)] px-5 py-2.5 text-sm font-semibold text-white hover:opacity-95 disabled:opacity-60"
          >
            {pending ? "Saving..." : "Save Package Template"}
          </button>

          <Link
            href={`/app/packages/${pkg.id}`}
            className="rounded-xl border border-[var(--brand-border)] px-5 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </form>

      <section className="rounded-[28px] border border-amber-200 bg-amber-50/50 p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Template cleanup</h2>
        <p className="mt-2 max-w-3xl text-sm text-slate-700">
          Archive templates that should no longer be sold. Delete is only safe when the template has never been used; if it has history, DanceFlow will archive it instead.
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
      </section>
    </div>
  );
}
