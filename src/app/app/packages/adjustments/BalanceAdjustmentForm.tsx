"use client";

import { useActionState, useMemo, useState } from "react";
import { createBalanceAdjustmentAction } from "./actions";

const initialState = { error: "" };

type ClientPackageOption = {
  id: string;
  name_snapshot: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
  client_package_items: {
    id: string;
    usage_type: string;
    quantity_total: number | null;
    quantity_used: number;
    quantity_remaining: number | null;
    is_unlimited: boolean;
  }[];
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private Lessons";
  if (value === "group_class") return "Group Classes";
  if (value === "practice_party") return "Practice Parties";
  return value;
}

export default function BalanceAdjustmentForm({
  clientPackages,
}: {
  clientPackages: ClientPackageOption[];
}) {
  const [state, formAction, pending] = useActionState(
    createBalanceAdjustmentAction,
    initialState
  );

  const [selectedPackageId, setSelectedPackageId] = useState("");

  const selectedPackage = useMemo(
    () => clientPackages.find((pkg) => pkg.id === selectedPackageId),
    [clientPackages, selectedPackageId]
  );

  return (
    <div className="max-w-4xl">
      <h2 className="text-3xl font-semibold tracking-tight">Manual Balance Adjustment</h2>
      <p className="mt-2 text-slate-600">
        Add or remove package credits and create an audit trail.
      </p>

      <form action={formAction} className="mt-8 space-y-6 rounded-2xl border bg-white p-6">
        <div>
          <label htmlFor="clientPackageId" className="mb-1 block text-sm font-medium">
            Client Package
          </label>
          <select
            id="clientPackageId"
            name="clientPackageId"
            required
            value={selectedPackageId}
            onChange={(e) => setSelectedPackageId(e.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Select client package</option>
            {clientPackages.map((pkg) => {
              const client = Array.isArray(pkg.clients) ? pkg.clients[0] : pkg.clients;
              return (
                <option key={pkg.id} value={pkg.id}>
                  {client ? `${client.first_name} ${client.last_name}` : "Unknown Client"} — {pkg.name_snapshot}
                </option>
              );
            })}
          </select>
        </div>

        {selectedPackage ? (
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="font-medium">Current Balances</p>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              {selectedPackage.client_package_items.map((item) => (
                <div key={item.id} className="rounded-xl border bg-white p-3">
                  <p className="text-sm text-slate-500">{usageLabel(item.usage_type)}</p>
                  <p className="mt-1 font-medium">
                    {item.is_unlimited
                      ? "Unlimited"
                      : `${item.quantity_remaining} remaining`}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {item.is_unlimited
                      ? "No quantity limit"
                      : `Used ${item.quantity_used} of ${item.quantity_total}`}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label htmlFor="usageType" className="mb-1 block text-sm font-medium">
              Usage Type
            </label>
            <select
              id="usageType"
              name="usageType"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="">Select type</option>
              <option value="private_lesson">Private Lessons</option>
              <option value="group_class">Group Classes</option>
              <option value="practice_party">Practice Parties</option>
            </select>
          </div>

          <div>
            <label htmlFor="adjustmentType" className="mb-1 block text-sm font-medium">
              Adjustment Type
            </label>
            <select
              id="adjustmentType"
              name="adjustmentType"
              required
              defaultValue="add"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="add">Add Credits</option>
              <option value="remove">Remove Credits</option>
            </select>
          </div>

          <div>
            <label htmlFor="quantity" className="mb-1 block text-sm font-medium">
              Quantity
            </label>
            <input
              id="quantity"
              name="quantity"
              type="number"
              min="0.25"
              step="0.25"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">
            Reason / Audit Note
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
            required
            placeholder="Example: Added 1 private lesson for makeup credit."
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          />
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
            {pending ? "Saving..." : "Save Adjustment"}
          </button>

          <a
            href="/app/packages/client-balances"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}