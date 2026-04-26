"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { createPaymentAction } from "@/app/app/payments/actions";

const initialState = { error: "" };

type PackageOption = {
  id: string;
  name_snapshot: string;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price?: number | string | null;
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

function formatCurrency(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatMoneyInput(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);

  if (!Number.isFinite(amount)) {
    return "";
  }

  return amount.toFixed(2);
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

function applyDiscount(
  baseAmount: number,
  discount: {
    discountPercent: number | null;
    discountAmount: number | null;
  } | null
) {
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
  packages = [],
  packageTemplates = [],
  activeMembership = null,
}: {
  clientId: string;
  returnTo: string;
  packages?: PackageOption[];
  packageTemplates?: PackageTemplateOption[];
  activeMembership?: ActiveMembership | null;
}) {
  const [state, formAction, pending] = useActionState(
    createPaymentAction,
    initialState
  );

  const [entryMode, setEntryMode] = useState("standalone_payment");
  const [serviceType, setServiceType] = useState("general");
  const [selectedPackageTemplateId, setSelectedPackageTemplateId] =
    useState("");
  const [salePrice, setSalePrice] = useState("");
  const [amount, setAmount] = useState("");
  const [activePaymentAction, setActivePaymentAction] = useState<
    "manual" | "charge_now" | "send_to_portal" | null
  >(null);

  const selectedPackageTemplate = useMemo(
    () =>
      packageTemplates.find(
        (template) => template.id === selectedPackageTemplateId
      ) ?? null,
    [packageTemplates, selectedPackageTemplateId]
  );

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

  useEffect(() => {
    if (entryMode !== "sell_package_and_pay") {
      setSelectedPackageTemplateId("");
      setSalePrice("");
      setAmount("");
    }
  }, [entryMode]);

  useEffect(() => {
    if (!selectedPackageTemplate) return;

    const templatePrice = formatMoneyInput(selectedPackageTemplate.price);

    setSalePrice(templatePrice);
    setAmount(templatePrice);
  }, [selectedPackageTemplate]);

  useEffect(() => {
    if (suggestedAmount == null) return;
    if (entryMode !== "sell_package_and_pay") return;

    setAmount(formatMoneyInput(suggestedAmount));
  }, [suggestedAmount, entryMode]);

  useEffect(() => {
    if (!pending) {
      setActivePaymentAction(null);
    }
  }, [pending]);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <input type="hidden" name="serviceType" value={serviceType} />

      {activeMembership ? (
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-slate-900">
              {activeMembership.name_snapshot}
            </p>
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
              Floor rental membership discount available:{" "}
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
          onChange={(event) => setEntryMode(event.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="standalone_payment">Standalone Payment</option>
          <option value="existing_package_payment">
            Attach to Existing Package
          </option>
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
          onChange={(event) => setServiceType(event.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        >
          <option value="general">General</option>
          <option value="floor_rental">Floor Rental</option>
          <option value="event_registration">Event Registration</option>
        </select>
      </div>

      {entryMode === "existing_package_payment" ? (
        <div>
          <label
            htmlFor="clientPackageId"
            className="mb-1 block text-sm font-medium"
          >
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

          {packages.length === 0 ? (
            <p className="mt-1 text-xs text-slate-500">
              This client does not have any active packages yet.
            </p>
          ) : null}
        </div>
      ) : null}

      {entryMode === "sell_package_and_pay" ? (
        <>
          <div>
            <label
              htmlFor="packageTemplateId"
              className="mb-1 block text-sm font-medium"
            >
              Package Template
            </label>
            <select
              id="packageTemplateId"
              name="packageTemplateId"
              value={selectedPackageTemplateId}
              onChange={(event) =>
                setSelectedPackageTemplateId(event.target.value)
              }
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              required={entryMode === "sell_package_and_pay"}
            >
              <option value="">Select package</option>
              {packageTemplates.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.name}{" "}
                  {pkg.price != null ? `— ${formatCurrency(pkg.price)}` : ""}
                </option>
              ))}
            </select>

            {packageTemplates.length === 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                No active package templates are available. Create a package
                template first.
              </p>
            ) : null}

            {selectedPackageTemplate ? (
              <p className="mt-1 text-xs text-slate-500">
                Package price: {formatCurrency(selectedPackageTemplate.price)}.
                Payment Amount was filled automatically, but you can edit it for
                a deposit or partial payment.
              </p>
            ) : null}
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
              onChange={(event) => {
                setSalePrice(event.target.value);
                setAmount(event.target.value);
              }}
              onBlur={() => {
                if (!salePrice) return;

                const parsed = Number(salePrice);
                if (Number.isFinite(parsed)) {
                  const formatted = parsed.toFixed(2);
                  setSalePrice(formatted);
                  setAmount(formatted);
                }
              }}
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
          onChange={(event) => setAmount(event.target.value)}
          onBlur={() => {
            if (!amount) return;

            const parsed = Number(amount);
            if (Number.isFinite(parsed)) {
              setAmount(parsed.toFixed(2));
            }
          }}
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
          placeholder="0.00"
          required
        />
        {suggestedAmount != null ? (
          <p className="mt-1 text-xs text-slate-500">
            Suggested amount: {formatCurrency(suggestedAmount)}
          </p>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor="paymentMethod"
            className="mb-1 block text-sm font-medium"
          >
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

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-semibold text-slate-950">Choose how to collect this payment</p>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Record Manual Payment saves a payment you already collected. Charge Now opens Stripe Checkout immediately. Submit to Client Portal creates a pending payment request the client can pay later.
        </p>

        <div className="mt-4 flex flex-wrap gap-3">
          <button
            type="submit"
            name="paymentAction"
            value="manual"
            disabled={pending}
            onClick={() => setActivePaymentAction("manual")}
            className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending && activePaymentAction === "manual"
              ? "Saving..."
              : "Record Manual Payment"}
          </button>

          <button
            type="submit"
            name="paymentAction"
            value="charge_now"
            disabled={pending}
            onClick={() => setActivePaymentAction("charge_now")}
            className="rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-white hover:opacity-95 disabled:opacity-60"
          >
            {pending && activePaymentAction === "charge_now"
              ? "Opening Stripe..."
              : "Charge Now"}
          </button>

          <button
            type="submit"
            name="paymentAction"
            value="send_to_portal"
            disabled={pending}
            onClick={() => setActivePaymentAction("send_to_portal")}
            className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            {pending && activePaymentAction === "send_to_portal"
              ? "Sending..."
              : "Submit to Client Portal"}
          </button>
        </div>
      </div>
    </form>
  );
}