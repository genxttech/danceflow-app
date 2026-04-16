"use client";

import { useActionState } from "react";
import { sellPackageToClientAction } from "./actions";

const initialState = { error: "" };

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  status: string;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  package_template_items: {
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private";
  if (value === "group_class") return "Group";
  if (value === "practice_party") return "Practice";
  return value;
}

function summarizePackageItems(
  items: PackageTemplateOption["package_template_items"]
) {
  if (!items || items.length === 0) return "No items";

  return items
    .map((item) =>
      item.is_unlimited
        ? `${usageLabel(item.usage_type)}: Unlimited`
        : `${usageLabel(item.usage_type)}: ${item.quantity}`
    )
    .join(" | ");
}

export default function SellPackageForm({
  clients,
  packageTemplates,
}: {
  clients: ClientOption[];
  packageTemplates: PackageTemplateOption[];
}) {
  const [state, formAction, pending] = useActionState(
    sellPackageToClientAction,
    initialState
  );

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl">
      <h2 className="text-3xl font-semibold tracking-tight">Sell Package</h2>
      <p className="mt-2 text-slate-600">
        Assign a mixed-use package to a client and record payment.
      </p>

      <form action={formAction} className="mt-8 space-y-4 rounded-2xl border bg-white p-6">
        <div>
          <label htmlFor="clientId" className="mb-1 block text-sm font-medium">
            Client
          </label>
          <select
            id="clientId"
            name="clientId"
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Select client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.first_name} {client.last_name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="packageTemplateId" className="mb-1 block text-sm font-medium">
            Package Template
          </label>
          <select
            id="packageTemplateId"
            name="packageTemplateId"
            required
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="">Select package</option>
            {packageTemplates.map((pkg) => (
              <option key={pkg.id} value={pkg.id}>
                {pkg.name} —{" "}
                {new Intl.NumberFormat("en-US", {
                  style: "currency",
                  currency: "USD",
                }).format(Number(pkg.price))}{" "}
                — {summarizePackageItems(pkg.package_template_items)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor="purchaseDate" className="mb-1 block text-sm font-medium">
              Purchase Date
            </label>
            <input
              id="purchaseDate"
              name="purchaseDate"
              type="date"
              required
              defaultValue={today}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>

          <div>
            <label htmlFor="amountPaid" className="mb-1 block text-sm font-medium">
              Amount Paid
            </label>
            <input
              id="amountPaid"
              name="amountPaid"
              type="number"
              min="0"
              step="0.01"
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            />
          </div>
        </div>

        <div>
          <label htmlFor="paymentMethod" className="mb-1 block text-sm font-medium">
            Payment Method
          </label>
          <select
            id="paymentMethod"
            name="paymentMethod"
            required
            defaultValue="card"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="check">Check</option>
            <option value="ach">ACH</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">
            Notes
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={4}
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
            {pending ? "Saving..." : "Sell Package"}
          </button>

          <a
            href="/app/packages"
            className="rounded-xl border px-4 py-2 text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}