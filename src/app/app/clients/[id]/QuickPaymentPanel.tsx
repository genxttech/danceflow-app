"use client";

import { useActionState, useMemo, useState } from "react";
import { createPaymentAction } from "@/app/app/payments/actions";

const initialState = { error: "" };

type PackageOption = {
  id: string;
  name_snapshot: string;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price?: number | null;
};

type MembershipBenefit = {
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string;
  applies_to: string | null;
};

type ActiveMembership = {
  id: string;
  name_snapshot: string;
  price_snapshot: number;
  billing_interval_snapshot: string;
  current_period_start: string;
  current_period_end: string;
  auto_renew: boolean;
  benefits: MembershipBenefit[];
};

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function getFloorRentalDiscount(benefits: MembershipBenefit[]) {
  const benefit = benefits.find(
    (item) => item.benefit_type === "floor_rental_discount_percent"
  );

  if (!benefit) return null;

  return {
    discountPercent: benefit.discount_percent,
    discountAmount: benefit.discount_amount,
    usagePeriod: benefit.usage_period,
  };
}

function applyDiscount(baseAmount: number, discount: { discountPercent: number | null; discountAmount: number | null } | null) {
  if (!discount) return baseAmount;

  if (discount.discountPercent != null && discount.discountPercent > 0) {
    const adjusted = baseAmount - baseAmount * (discount.discountPercent / 100);
    return Math.max(0, Number(adjusted.toFixed(2)));
  }

  if (discount.discountAmount != null && discount.discountAmount > 0) {
    return Math.max(0, Number((baseAmount - discount.discountAmount).toFixed(2)));
  }

  return baseAmount;
}

export default function QuickPaymentPanel({
  clientId,
  returnTo,
  packages,
  packageTemplates = [],
  activeMembership = null,
}: {
  clientId: string;
  returnTo: string;
  packages: PackageOption[];
  packageTemplates?: PackageTemplateOption[];
  activeMembership?: ActiveMembership | null;
}) {
  const [state, formAction, pending] = useActionState(
    createPaymentAction,
    initialState
  );

  const [entryMode, setEntryMode] = useState("standalone_payment");
  const [serviceType, setServiceType] = useState("general");
  const [salePrice, setSalePrice] = useState("");
  const [amount, setAmount] = useState("");

  const floorRentalDiscount = useMemo(() => {
    if (!activeMembership) return null;
    return getFloorRentalDiscount(activeMembership.benefits);
  }, [activeMembership]);

  const suggestedAmount = useMemo(() => {
    const parsedSalePrice = Number(salePrice || 0);
    if (Number.isNaN(parsedSalePrice) || parsedSalePrice <= 0) return null;

    if (serviceType === "floor_rental" && floorRentalDiscount) {
      return applyDiscount(parsedSalePrice, floorRentalDiscount);
    }

    return parsedSalePrice;
  }, [salePrice, serviceType, floorRentalDiscount]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="serviceType" value={serviceType} />

      {activeMembership ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-slate-900">{activeMembership.name_snapshot}</p>
            <span className="inline-flex rounded-full bg-green-50 px-2 py-1 text-xs font-medium text-green-700">
              Active Membership
            </span>
          </div>

          <p className="mt-2 text-sm text-slate-600">
            {formatCurrency(activeMembership.price_snapshot)} /{" "}
            {billingIntervalLabel(activeMembership.billing_interval_snapshot)}
          </p>

          <p className="mt-1 text-xs text-slate-500">
            Current period: {formatShortDate(activeMembership.current_period_start)} –{" "}
            {formatShortDate(activeMembership.current_period_end)}
          </p>

          {floorRentalDiscount ? (
            <div className="mt-3 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800">
              Floor rental membership discount available:
              {" "}
              {floorRentalDiscount.discountPercent != null
                ? `${floorRentalDiscount.discountPercent}% off`
                : floorRentalDiscount.discountAmount != null
                ? `${formatCurrency(floorRentalDiscount.discountAmount)} off`
                : "Discount available"}
            </div>
          ) : null}
        </div>
      ) : null}

      <div>
        <label htmlFor="entryMode" className="mb-1 block text-sm font-medium">
          Entry Type
        </label>
        <select
          id="entryMode"
          name="entryMode"
          value={entryMode}
          onChange={(e) => setEntryMode(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="standalone_payment">Standalone Payment</option>
          <option value="existing_package_payment">Attach to Existing Package</option>
          <option value="sell_package_and_pay">Sell Package + Payment</option>
        </select>
      </div>

      <div>
        <label htmlFor="serviceType" className="mb-1 block text-sm font-medium">
          Service Context
        </label>
        <select
          id="serviceType"
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="general">General</option>
          <option value="floor_rental">Floor Rental</option>
          <option value="event_registration">Event Registration</option>
        </select>
      </div>

      {entryMode === "existing_package_payment" ? (
        <div>
          <label htmlFor="clientPackageId" className="mb-1 block text-sm font-medium">
            Existing Package
          </label>
          <select
            id="clientPackageId"
            name="clientPackageId"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            defaultValue=""
          >
            <option value="">Select package</option>
            {packages.map((pkg) => (
              <option key={pkg.id} value={pkg.id}>
                {pkg.name_snapshot}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {entryMode === "sell_package_and_pay" ? (
        <>
          <div>
            <label htmlFor="packageTemplateId" className="mb-1 block text-sm font-medium">
              Package Template
            </label>
            <select
              id="packageTemplateId"
              name="packageTemplateId"
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              defaultValue=""
            >
              <option value="">Select package</option>
              {packageTemplates.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.name}{" "}
                  {pkg.price != null ? `— ${formatCurrency(pkg.price)}` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="salePrice" className="mb-1 block text-sm font-medium">
              Sale Price
            </label>
            <input
              id="salePrice"
              name="salePrice"
              type="number"
              step="0.01"
              min="0"
              value={salePrice}
              onChange={(e) => setSalePrice(e.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Optional override"
            />
          </div>
        </>
      ) : null}

      <div>
        <label htmlFor="amount" className="mb-1 block text-sm font-medium">
          Payment Amount
        </label>
        <input
          id="amount"
          name="amount"
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="0.00"
        />
        {suggestedAmount != null ? (
          <p className="mt-1 text-xs text-slate-500">
            Suggested amount: {formatCurrency(suggestedAmount)}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label htmlFor="paymentMethod" className="mb-1 block text-sm font-medium">
            Payment Method
          </label>
          <select
            id="paymentMethod"
            name="paymentMethod"
            defaultValue="cash"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="cash">Cash</option>
            <option value="card">Card</option>
            <option value="check">Check</option>
            <option value="zelle">Zelle</option>
            <option value="venmo">Venmo</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium">
            Payment Status
          </label>
          <select
            id="status"
            name="status"
            defaultValue="paid"
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
            <option value="failed">Failed</option>
            <option value="refunded">Refunded</option>
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="notes" className="mb-1 block text-sm font-medium">
          Notes
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={4}
          placeholder="Optional payment note"
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
      </div>

      {state?.error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving..." : "Save Payment"}
        </button>
      </div>
    </form>
  );
}