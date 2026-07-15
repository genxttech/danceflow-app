"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CreditCard, Package2, Search, UserRound } from "lucide-react";
import { sellPackageToClientAction } from "./actions";

const initialState = { error: "" };

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  status: string;
  account_balance?: number | string | null;
};

type PackageTemplateOption = {
  id: string;
  name: string;
  price: number;
  active: boolean;
  expiration_days?: number | null;
  package_template_items: {
    usage_type: string;
    quantity: number | null;
    is_unlimited: boolean;
  }[];
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private lessons";
  if (value === "group_class") return "Group classes";
  if (value === "practice_party") return "Practice sessions";
  return value.replaceAll("_", " ");
}

function summarizePackageItems(items: PackageTemplateOption["package_template_items"]) {
  if (!items || items.length === 0) return "No included items listed";

  return items
    .map((item) =>
      item.is_unlimited
        ? `${usageLabel(item.usage_type)}: Unlimited`
        : `${usageLabel(item.usage_type)}: ${item.quantity ?? 0}`
    )
    .join(" • ");
}

function formatCurrency(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number.isFinite(amount) ? amount : 0);
}

function formatMoneyInput(value: number | string | null | undefined) {
  const amount = Number(value ?? 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "";
}

function clientName(client: ClientOption) {
  return `${client.first_name} ${client.last_name}`.trim() || client.email || "Unnamed client";
}

export default function SellPackageForm({
  clients,
  packageTemplates,
  clientAccountBalances = {},
}: {
  clients: ClientOption[];
  packageTemplates: PackageTemplateOption[];
  clientAccountBalances?: Record<string, number>;
}) {
  const [state, formAction, pending] = useActionState(sellPackageToClientAction, initialState);
  const today = new Date().toISOString().slice(0, 10);

  const [clientSearch, setClientSearch] = useState("");
  const [packageSearch, setPackageSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPackageTemplateId, setSelectedPackageTemplateId] = useState("");
  const [accountCreditToApply, setAccountCreditToApply] = useState("0.00");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("card");

  const selectedPackageTemplate = useMemo(
    () => packageTemplates.find((pkg) => pkg.id === selectedPackageTemplateId) ?? null,
    [packageTemplates, selectedPackageTemplateId]
  );

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

  const filteredClients = useMemo(() => {
    const search = clientSearch.trim().toLowerCase();
    if (!search) return clients;
    return clients.filter((client) =>
      `${client.first_name} ${client.last_name} ${client.email ?? ""}`.toLowerCase().includes(search)
    );
  }, [clientSearch, clients]);

  const filteredPackages = useMemo(() => {
    const search = packageSearch.trim().toLowerCase();
    if (!search) return packageTemplates;
    return packageTemplates.filter((pkg) =>
      `${pkg.name} ${summarizePackageItems(pkg.package_template_items)}`.toLowerCase().includes(search)
    );
  }, [packageSearch, packageTemplates]);

  const availableAccountCredit = useMemo(() => {
    if (!selectedClientId) return 0;
    const fromMap = clientAccountBalances[selectedClientId];
    const fromClient = selectedClient?.account_balance;
    const value = Number(fromMap ?? fromClient ?? 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }, [clientAccountBalances, selectedClient, selectedClientId]);

  const packagePrice = Number(selectedPackageTemplate?.price ?? 0);
  const appliedCreditAmount = Number(accountCreditToApply || 0);
  const safeAppliedCredit = Number.isFinite(appliedCreditAmount) ? appliedCreditAmount : 0;
  const estimatedDueToday = Math.max(0, packagePrice - safeAppliedCredit);
  const paymentAmountNumber = Number(paymentAmount || 0);
  const safePaymentAmount = Number.isFinite(paymentAmountNumber) ? paymentAmountNumber : 0;
  const collectedTotal = safeAppliedCredit + safePaymentAmount;
  const remainingBalance = Math.max(0, packagePrice - collectedTotal);
  const paymentMatchesTotal =
    packagePrice > 0 && Math.abs(collectedTotal - packagePrice) < 0.005;
  const readyToSubmit = Boolean(
    selectedClientId &&
      selectedPackageTemplateId &&
      paymentAmount !== "" &&
      paymentMatchesTotal,
  );

  useEffect(() => {
    if (!selectedPackageTemplate) {
      setAccountCreditToApply("0.00");
      setPaymentAmount("");
      return;
    }

    setAccountCreditToApply("0.00");
    setPaymentAmount(formatMoneyInput(selectedPackageTemplate.price));
  }, [selectedPackageTemplateId, selectedPackageTemplate]);

  return (
    <form action={formAction} className="space-y-6">
      <input type="hidden" name="clientId" value={selectedClientId} />
      <input type="hidden" name="packageTemplateId" value={selectedPackageTemplateId} />
      <input type="hidden" name="amountPaid" value={paymentAmount} />

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <UserRound className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 1</p>
              <h2 className="text-xl font-semibold text-slate-950">Choose client</h2>
            </div>
          </div>

          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Search client</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={clientSearch}
                onChange={(event) => setClientSearch(event.target.value)}
                placeholder="Name or email"
                maxLength={120}
                autoComplete="off"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <div className="mt-4 max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {filteredClients.map((client) => {
              const active = selectedClientId === client.id;
              return (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => {
                    setSelectedClientId(client.id);
                    setAccountCreditToApply("0.00");
                    if (selectedPackageTemplate) {
                      setPaymentAmount(formatMoneyInput(selectedPackageTemplate.price));
                    }
                  }}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                      : "border-slate-200 bg-slate-50 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{clientName(client)}</p>
                      <p className="mt-1 text-sm text-slate-500">{client.email || "No email on file"}</p>
                    </div>
                    {active ? <CheckCircle2 className="h-5 w-5 text-[var(--brand-primary)]" /> : null}
                  </div>
                  <p className="mt-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                    Credit: {formatCurrency(clientAccountBalances[client.id] ?? client.account_balance ?? 0)}
                  </p>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <Package2 className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 2</p>
              <h2 className="text-xl font-semibold text-slate-950">Choose package</h2>
            </div>
          </div>

          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Search package</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={packageSearch}
                onChange={(event) => setPackageSearch(event.target.value)}
                placeholder="Package name or included item"
                maxLength={120}
                autoComplete="off"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <div className="mt-4 max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {filteredPackages.map((pkg) => {
              const active = selectedPackageTemplateId === pkg.id;
              return (
                <button
                  key={pkg.id}
                  type="button"
                  onClick={() => setSelectedPackageTemplateId(pkg.id)}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                      : "border-slate-200 bg-slate-50 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{pkg.name}</p>
                      <p className="mt-1 text-sm text-slate-500">{summarizePackageItems(pkg.package_template_items)}</p>
                    </div>
                    <p className="shrink-0 rounded-full bg-white px-3 py-1 text-sm font-semibold text-[var(--brand-primary)]">
                      {formatCurrency(pkg.price)}
                    </p>
                  </div>
                  {pkg.expiration_days ? (
                    <p className="mt-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-400">
                      Expires after {pkg.expiration_days} days
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>
      </div>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <CreditCard className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Step 3</p>
            <h2 className="text-xl font-semibold text-slate-950">Review and collect payment</h2>
            <p className="mt-1 text-sm text-slate-500">
              Confirm the sale details once. No extra review page is needed.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Client</p>
            <p className="mt-1 font-semibold text-slate-950">
              {selectedClient ? clientName(selectedClient) : "Not selected"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Package</p>
            <p className="mt-1 font-semibold text-slate-950">
              {selectedPackageTemplate ? selectedPackageTemplate.name : "Not selected"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Package Price</p>
            <p className="mt-1 font-semibold text-slate-950">{formatCurrency(packagePrice)}</p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Purchase date</span>
            <input
              name="purchaseDate"
              type="date"
              required
              defaultValue={today}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Apply account credit</span>
            <input
              name="accountCreditToApply"
              type="number"
              inputMode="decimal"
              min="0"
              max={Math.min(availableAccountCredit, packagePrice || availableAccountCredit)}
              step="0.01"
              value={accountCreditToApply}
              onChange={(event) => {
                const nextValue = event.target.value;
                setAccountCreditToApply(nextValue);
                const credit = Number(nextValue || 0);
                const safeCredit = Number.isFinite(credit) ? credit : 0;
                setPaymentAmount(formatMoneyInput(Math.max(0, packagePrice - safeCredit)));
              }}
              onBlur={() => {
                const credit = Number(accountCreditToApply || 0);
                const maxCredit = Math.min(availableAccountCredit, packagePrice);
                const safeCredit = Number.isFinite(credit) ? Math.min(Math.max(credit, 0), maxCredit) : 0;
                setAccountCreditToApply(safeCredit.toFixed(2));
                setPaymentAmount(formatMoneyInput(Math.max(0, packagePrice - safeCredit)));
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            />
            <p className="mt-1 text-xs text-slate-500">Available: {formatCurrency(availableAccountCredit)}</p>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Payment amount</span>
            <input
              name="paymentAmount"
              type="number"
              inputMode="decimal"
              min="0"
              max="100000"
              step="0.01"
              required
              value={paymentAmount}
              onChange={(event) => setPaymentAmount(event.target.value)}
              onBlur={() => {
                if (!paymentAmount) return;
                const amount = Number(paymentAmount);
                if (Number.isFinite(amount)) setPaymentAmount(amount.toFixed(2));
              }}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            />
            <p className="mt-1 text-xs text-slate-500">Due after credit: {formatCurrency(estimatedDueToday)}</p>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Payment method</span>
            <select
              name="paymentMethod"
              required
              value={paymentMethod}
              onChange={(event) => setPaymentMethod(event.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            >
              <option value="card">Card already collected</option>
              <option value="cash">Cash</option>
              <option value="check">Check</option>
              <option value="ach">ACH</option>
              <option value="venmo">Venmo</option>
              <option value="zelle">Zelle</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sale total</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{formatCurrency(packagePrice)}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Collected today</p>
            <p className="mt-1 text-xl font-semibold text-slate-950">{formatCurrency(collectedTotal)}</p>
          </div>
          <div className={`rounded-2xl border p-4 ${remainingBalance > 0 ? "border-rose-200 bg-rose-50" : "border-emerald-200 bg-emerald-50"}`}>
            <p className={`text-xs font-semibold uppercase tracking-wide ${remainingBalance > 0 ? "text-rose-700" : "text-emerald-700"}`}>Remaining balance</p>
            <p className={`mt-1 text-xl font-semibold ${remainingBalance > 0 ? "text-rose-950" : "text-emerald-950"}`}>{formatCurrency(remainingBalance)}</p>
          </div>
        </div>

        {!paymentMatchesTotal && selectedPackageTemplate ? (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <p className="font-semibold">The collected amount must equal the package price.</p>
            <p className="mt-1 leading-6">
              Partial package sales are blocked until a payment arrangement is created and the remaining balance is recorded.
            </p>
          </div>
        ) : null}

        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-slate-700">Notes</span>
          <textarea
            name="notes"
            rows={3}
            maxLength={1000}
            placeholder="Optional sale note"
            className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
          />
        </label>

        {state?.error ? (
          <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            name="paymentAction"
            value="manual"
            disabled={pending || !readyToSubmit}
            className="rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Saving..." : "Complete Sale"}
          </button>
          <button
            type="submit"
            name="paymentAction"
            value="terminal"
            disabled={pending || !readyToSubmit || safeAppliedCredit > 0}
            className="rounded-xl border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue to Card Reader
          </button>
          <a
            href="/app/packages"
            className="rounded-xl border border-transparent px-5 py-3 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Cancel
          </a>
        </div>

        {safeAppliedCredit > 0 ? (
          <p className="mt-3 text-xs text-amber-700">
            Card reader collection is disabled when account credit is applied. Complete this as a manual sale or remove the credit.
          </p>
        ) : null}
      </section>
    </form>
  );
}
