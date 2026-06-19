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

function getTodayDateValue() {
  return new Date().toISOString().slice(0, 10);
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
  accountCreditBalance = 0,
}: {
  clientId: string;
  returnTo: string;
  packages?: PackageOption[];
  packageTemplates?: PackageTemplateOption[];
  activeMembership?: ActiveMembership | null;
  accountCreditBalance?: number;
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
  const [accountCreditToApply, setAccountCreditToApply] = useState("");
  const [paymentDate, setPaymentDate] = useState(getTodayDateValue());
  const [activePaymentAction, setActivePaymentAction] = useState<
    "manual" | "charge_now" | "terminal" | "send_to_portal" | null
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

  const availableAccountCredit = Math.max(0, Number(accountCreditBalance ?? 0));

  const packageSalePriceAmount = useMemo(() => {
    const parsedSalePrice = Number(salePrice || 0);
    return Number.isFinite(parsedSalePrice) && parsedSalePrice > 0 ? parsedSalePrice : 0;
  }, [salePrice]);

  const appliedAccountCreditAmount = useMemo(() => {
    const parsedCredit = Number(accountCreditToApply || 0);
    if (!Number.isFinite(parsedCredit) || parsedCredit <= 0) return 0;

    return Math.min(parsedCredit, availableAccountCredit, packageSalePriceAmount);
  }, [accountCreditToApply, availableAccountCredit, packageSalePriceAmount]);

  const packageAmountDueAfterCredit = Math.max(
    0,
    Number((packageSalePriceAmount - appliedAccountCreditAmount).toFixed(2))
  );

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
      setAccountCreditToApply("");
    }
  }, [entryMode]);

  useEffect(() => {
    if (!selectedPackageTemplate) return;

    const templatePrice = formatMoneyInput(selectedPackageTemplate.price);

    setSalePrice(templatePrice);
    const templateAmount = Number(templatePrice || 0);
    const creditAmount = Number(accountCreditToApply || 0);
    const adjustedAmount = Math.max(0, templateAmount - Math.min(creditAmount, availableAccountCredit, templateAmount));
    setAmount(formatMoneyInput(adjustedAmount));
  }, [selectedPackageTemplate, accountCreditToApply, availableAccountCredit]);

  useEffect(() => {
    if (entryMode !== "sell_package_and_pay") return;

    const adjustedAmount = Math.max(0, Number((packageSalePriceAmount - appliedAccountCreditAmount).toFixed(2)));
    setAmount(formatMoneyInput(adjustedAmount));
  }, [packageSalePriceAmount, appliedAccountCreditAmount, entryMode]);

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
      <input type="hidden" name="accountCreditToApply" value={entryMode === "sell_package_and_pay" ? accountCreditToApply : ""} />

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
                const nextSalePrice = event.target.value;
                setSalePrice(nextSalePrice);

                const parsedSalePrice = Number(nextSalePrice || 0);
                const parsedCredit = Number(accountCreditToApply || 0);
                if (Number.isFinite(parsedSalePrice)) {
                  const adjustedAmount = Math.max(
                    0,
                    parsedSalePrice - Math.min(parsedCredit, availableAccountCredit, Math.max(parsedSalePrice, 0))
                  );
                  setAmount(formatMoneyInput(adjustedAmount));
                } else {
                  setAmount(nextSalePrice);
                }
              }}
              onBlur={() => {
                if (!salePrice) return;

                const parsed = Number(salePrice);
                if (Number.isFinite(parsed)) {
                  const formatted = parsed.toFixed(2);
                  const parsedCredit = Number(accountCreditToApply || 0);
                  const adjustedAmount = Math.max(
                    0,
                    parsed - Math.min(parsedCredit, availableAccountCredit, Math.max(parsed, 0))
                  );
                  setSalePrice(formatted);
                  setAmount(formatMoneyInput(adjustedAmount));
                }
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
              placeholder="Optional override"
            />
          </div>

          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-emerald-950">
                  Client account credit
                </p>
                <p className="mt-1 text-sm text-emerald-800">
                  Available credit: {formatCurrency(availableAccountCredit)}
                </p>
              </div>

              <div className="text-right text-sm text-emerald-900">
                <p>Package price: {formatCurrency(packageSalePriceAmount)}</p>
                <p>Due after credit: {formatCurrency(packageAmountDueAfterCredit)}</p>
              </div>
            </div>

            <label
              htmlFor="accountCreditToApply"
              className="mt-4 block text-sm font-medium text-emerald-950"
            >
              Apply account credit
            </label>
            <input
              id="accountCreditToApply"
              type="number"
              step="0.01"
              min="0"
              max={Math.min(availableAccountCredit, packageSalePriceAmount)}
              value={accountCreditToApply}
              onChange={(event) => {
                const rawValue = event.target.value;
                const parsed = Number(rawValue || 0);

                if (!rawValue) {
                  setAccountCreditToApply("");
                  setAmount(formatMoneyInput(packageSalePriceAmount));
                  return;
                }

                if (!Number.isFinite(parsed)) {
                  setAccountCreditToApply(rawValue);
                  return;
                }

                const cappedCredit = Math.min(
                  Math.max(parsed, 0),
                  availableAccountCredit,
                  packageSalePriceAmount
                );
                setAccountCreditToApply(cappedCredit.toFixed(2));
                setAmount(formatMoneyInput(Math.max(0, packageSalePriceAmount - cappedCredit)));
              }}
              onBlur={() => {
                if (!accountCreditToApply) return;

                const parsed = Number(accountCreditToApply);
                if (Number.isFinite(parsed)) {
                  const cappedCredit = Math.min(
                    Math.max(parsed, 0),
                    availableAccountCredit,
                    packageSalePriceAmount
                  );
                  setAccountCreditToApply(cappedCredit.toFixed(2));
                  setAmount(formatMoneyInput(Math.max(0, packageSalePriceAmount - cappedCredit)));
                }
              }}
              disabled={availableAccountCredit <= 0 || packageSalePriceAmount <= 0}
              className="mt-1 w-full rounded-xl border border-emerald-300 bg-white px-3 py-2 disabled:bg-slate-100 disabled:text-slate-500"
              placeholder="0.00"
            />
            <p className="mt-2 text-xs leading-5 text-emerald-800">
              Applying credit creates a client account ledger entry and reduces the payment due today without changing the original credit record.
            </p>
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

      <div className="grid gap-4 md:grid-cols-3">
        <div>
          <label htmlFor="paymentDate" className="mb-1 block text-sm font-medium">
            Payment Date
          </label>
          <input
            id="paymentDate"
            name="paymentDate"
            type="date"
            value={paymentDate}
            onChange={(event) => setPaymentDate(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
            required
          />
          <p className="mt-1 text-xs text-slate-500">
            Use the date the payment or sale actually happened.
          </p>
        </div>

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
            <option value="ach">ACH</option>
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
          Record Manual Payment saves a payment you already collected. Charge Now opens Stripe Checkout. In-person Card Reader starts a front-desk reader payment. Submit to Client Portal creates a pending payment request the client can pay later.
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
            value="terminal"
            disabled={pending}
            onClick={() => setActivePaymentAction("terminal")}
            className="rounded-xl bg-emerald-600 px-4 py-2 text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {pending && activePaymentAction === "terminal"
              ? "Opening reader..."
              : "In-person Card Reader"}
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