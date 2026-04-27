"use client";

import Link from "next/link";
import { useActionState } from "react";
import { createPackageTemplateAction } from "../actions";

const initialState = { error: "" };

function PackageItemRow({
  title,
  usageKey,
}: {
  title: string;
  usageKey: "private_lesson" | "group_class" | "practice_party";
}) {
  return (
    <div className="rounded-xl border p-4">
      <p className="font-medium">{title}</p>

      <div className="mt-3 grid gap-4 md:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name={`${usageKey}_included`} />
          Included
        </label>

        <div>
          <label className="mb-1 block text-sm font-medium">Quantity</label>
          <input
            name={`${usageKey}_quantity`}
            type="number"
            min="0"
            step="0.25"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <label className="flex items-center gap-2 text-sm md:mt-7">
          <input type="checkbox" name={`${usageKey}_unlimited`} />
          Unlimited
        </label>
      </div>
    </div>
  );
}

export default function NewPackageTemplatePage() {
  const [state, formAction, pending] = useActionState(
    createPackageTemplateAction,
    initialState
  );

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <section className="rounded-[28px] border border-violet-100 bg-gradient-to-br from-violet-50 via-white to-amber-50 p-6 shadow-sm md:p-8">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-700">
              DanceFlow Packages
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
              New Package Template
            </h1>
            <p className="mt-3 max-w-2xl text-base leading-7 text-slate-600">
              Create lesson, class, or practice-party packages that your front
              desk can sell quickly.
            </p>
          </div>

          <Link
            href="/app/packages"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Back to Packages
          </Link>
        </div>
      </section>

      <form action={formAction} className="space-y-6 rounded-2xl border bg-white p-6 shadow-sm">
        <div>
          <label htmlFor="name" className="mb-1 block text-sm font-medium">
            Package Name
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="Gold Package"
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
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label
              htmlFor="expirationDays"
              className="mb-1 block text-sm font-medium"
            >
              Expiration Days
            </label>
            <input
              id="expirationDays"
              name="expirationDays"
              type="number"
              min="0"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold">Included Items</h3>
          <p className="mt-1 text-sm text-slate-600">
            Select what this package includes so staff can sell it without extra
            explanation.
          </p>

          <div className="mt-4 space-y-4">
            <PackageItemRow title="Private Lessons" usageKey="private_lesson" />
            <PackageItemRow title="Group Classes" usageKey="group_class" />
            <PackageItemRow title="Practice Parties" usageKey="practice_party" />
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
            {pending ? "Saving..." : "Save Package Template"}
          </button>

          <Link
            href="/app/packages"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}