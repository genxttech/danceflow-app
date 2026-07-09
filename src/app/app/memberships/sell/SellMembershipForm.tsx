"use client";

import { useMemo, useState } from "react";
import { CalendarDays, CheckCircle2, CreditCard, Search, ShieldCheck, UserRound, WalletCards } from "lucide-react";
import {
  assignMembershipToClientAction,
  sellMembershipAction,
  startTerminalMembershipEnrollmentAction,
} from "@/app/app/memberships/actions";

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string | null;
};

type MembershipPlanOption = {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
  auto_renew_default: boolean | null;
  visibility: string | null;
};

type MembershipBenefitOption = {
  id: string;
  membership_plan_id: string;
  benefit_type: string;
  quantity: number | null;
  discount_percent: number | null;
  discount_amount: number | null;
  usage_period: string | null;
  applies_to: string | null;
};

type ExistingMembership = {
  id: string;
  client_id: string;
  status: string;
  name_snapshot: string | null;
};

function formatCurrency(value: number | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value.replaceAll("_", " ");
}

function clientName(client: ClientOption) {
  return `${client.first_name} ${client.last_name}`.trim() || client.email || "Unnamed client";
}

function benefitLabel(benefit: MembershipBenefitOption) {
  const pieces = [benefit.benefit_type.replaceAll("_", " ")];

  if (benefit.quantity !== null) pieces.push(`${benefit.quantity}`);
  if (benefit.discount_percent !== null) pieces.push(`${benefit.discount_percent}% off`);
  if (benefit.discount_amount !== null) pieces.push(`${formatCurrency(benefit.discount_amount)} off`);
  if (benefit.usage_period) pieces.push(benefit.usage_period.replaceAll("_", " "));
  if (benefit.applies_to) pieces.push(`applies to ${benefit.applies_to}`);

  return pieces.join(" • ");
}

export default function SellMembershipForm({
  clients,
  plans,
  benefitsByPlanId,
  existingMembershipsByClientId,
}: {
  clients: ClientOption[];
  plans: MembershipPlanOption[];
  benefitsByPlanId: Record<string, MembershipBenefitOption[]>;
  existingMembershipsByClientId: Record<string, ExistingMembership>;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [clientSearch, setClientSearch] = useState("");
  const [planSearch, setPlanSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [startsOn, setStartsOn] = useState(today);
  const [autoRenew, setAutoRenew] = useState(true);
  const [recurringConsent, setRecurringConsent] = useState(false);

  const selectedClient = useMemo(
    () => clients.find((client) => client.id === selectedClientId) ?? null,
    [clients, selectedClientId]
  );

  const selectedPlan = useMemo(
    () => plans.find((plan) => plan.id === selectedPlanId) ?? null,
    [plans, selectedPlanId]
  );

  const selectedBenefits = selectedPlan ? benefitsByPlanId[selectedPlan.id] ?? [] : [];
  const existingMembership = selectedClient ? existingMembershipsByClientId[selectedClient.id] ?? null : null;
  const totalInitialDue = Number(selectedPlan?.price ?? 0) + Number(selectedPlan?.signup_fee ?? 0);
  const ready = Boolean(selectedClient && selectedPlan && startsOn && !existingMembership);
  const returnTo = "/app/memberships/sell";

  const filteredClients = useMemo(() => {
    const search = clientSearch.trim().toLowerCase();
    if (!search) return clients;
    return clients.filter((client) =>
      `${client.first_name} ${client.last_name} ${client.email ?? ""} ${client.phone ?? ""}`.toLowerCase().includes(search)
    );
  }, [clientSearch, clients]);

  const filteredPlans = useMemo(() => {
    const search = planSearch.trim().toLowerCase();
    if (!search) return plans;
    return plans.filter((plan) =>
      `${plan.name} ${plan.description ?? ""} ${plan.billing_interval}`.toLowerCase().includes(search)
    );
  }, [planSearch, plans]);

  function HiddenFields() {
    return (
      <>
        <input type="hidden" name="clientId" value={selectedClientId} />
        <input type="hidden" name="membershipPlanId" value={selectedPlanId} />
        <input type="hidden" name="startsOn" value={startsOn} />
        <input type="hidden" name="returnTo" value={returnTo} />
        {autoRenew ? <input type="hidden" name="autoRenew" value="on" /> : null}
      </>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-2">
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
                placeholder="Name, email, or phone"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <div className="mt-4 max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {filteredClients.map((client) => {
              const active = selectedClientId === client.id;
              const existing = existingMembershipsByClientId[client.id];
              return (
                <button
                  key={client.id}
                  type="button"
                  onClick={() => setSelectedClientId(client.id)}
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
                  {existing ? (
                    <p className="mt-3 rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
                      Existing membership: {existing.name_snapshot ?? "Membership"} ({existing.status.replaceAll("_", " ")})
                    </p>
                  ) : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
              <WalletCards className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm text-slate-500">Step 2</p>
              <h2 className="text-xl font-semibold text-slate-950">Choose membership</h2>
            </div>
          </div>

          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Search plan</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={planSearch}
                onChange={(event) => setPlanSearch(event.target.value)}
                placeholder="Plan name or description"
                className="w-full rounded-xl border border-slate-300 bg-white py-2.5 pl-10 pr-3 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
              />
            </div>
          </label>

          <div className="mt-4 max-h-[360px] space-y-3 overflow-y-auto pr-1">
            {filteredPlans.map((plan) => {
              const active = selectedPlanId === plan.id;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => {
                    setSelectedPlanId(plan.id);
                    setAutoRenew(plan.auto_renew_default ?? true);
                    setRecurringConsent(false);
                  }}
                  className={`w-full rounded-2xl border p-4 text-left transition ${
                    active
                      ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                      : "border-slate-200 bg-slate-50 hover:border-slate-300"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-slate-950">{plan.name}</p>
                      <p className="mt-1 text-sm text-slate-500">
                        {formatCurrency(plan.price)} / {billingIntervalLabel(plan.billing_interval)}
                      </p>
                    </div>
                    {active ? <CheckCircle2 className="h-5 w-5 text-[var(--brand-primary)]" /> : null}
                  </div>
                  {plan.description ? <p className="mt-3 text-sm leading-6 text-slate-600">{plan.description}</p> : null}
                  {plan.signup_fee ? (
                    <p className="mt-3 text-xs font-semibold text-amber-800">Signup fee: {formatCurrency(plan.signup_fee)}</p>
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
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Step 3</p>
            <h2 className="text-xl font-semibold text-slate-950">Review and finish</h2>
            <p className="mt-1 text-sm text-slate-500">
              Select the start date and choose the payment path without leaving this page.
            </p>
          </div>
        </div>

        {existingMembership ? (
          <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            This client already has {existingMembership.name_snapshot ?? "a membership"} with status {existingMembership.status.replaceAll("_", " ")}.
            Review the client record before selling another membership.
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 md:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Client</p>
            <p className="mt-1 font-semibold text-slate-950">{selectedClient ? clientName(selectedClient) : "Not selected"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Membership</p>
            <p className="mt-1 font-semibold text-slate-950">{selectedPlan ? selectedPlan.name : "Not selected"}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Recurring Price</p>
            <p className="mt-1 font-semibold text-slate-950">
              {selectedPlan ? `${formatCurrency(selectedPlan.price)} / ${billingIntervalLabel(selectedPlan.billing_interval)}` : "$0.00"}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Initial Due</p>
            <p className="mt-1 font-semibold text-slate-950">{formatCurrency(totalInitialDue)}</p>
          </div>
        </div>

        {selectedPlan ? (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Included benefits</p>
            {selectedBenefits.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
                {selectedBenefits.map((benefit) => (
                  <span key={benefit.id} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-700 shadow-sm">
                    {benefitLabel(benefit)}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-sm text-slate-500">No benefits are listed for this membership.</p>
            )}
          </div>
        ) : null}

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Start date</span>
            <input
              type="date"
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-[var(--brand-primary)]"
            />
          </label>

          <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={autoRenew}
              onChange={(event) => setAutoRenew(event.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-[var(--brand-primary)]"
            />
            Auto-renew this membership
          </label>
        </div>

        <label className="mt-5 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm leading-6 text-emerald-950">
          <input
            type="checkbox"
            checked={recurringConsent}
            onChange={(event) => setRecurringConsent(event.target.checked)}
            className="mt-1 h-4 w-4 rounded border-slate-300"
          />
          <span>
            The client authorizes the initial charge of {formatCurrency(totalInitialDue)} and recurring {selectedPlan ? billingIntervalLabel(selectedPlan.billing_interval).toLowerCase() : "membership"} charges of {formatCurrency(selectedPlan?.price ?? 0)} until cancelled under the studio&apos;s membership terms.
          </span>
        </label>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <form action={sellMembershipAction} className="rounded-3xl border border-slate-200 bg-slate-50 p-5">
            <HiddenFields />
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-[var(--brand-primary)] shadow-sm">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Stripe checkout</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Use when Stripe should collect payment and manage recurring billing.
                </p>
              </div>
            </div>
            <button
              type="submit"
              disabled={!ready}
              className="mt-5 w-full rounded-xl bg-[var(--brand-primary)] px-4 py-2.5 text-sm font-medium text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Start Checkout
            </button>
          </form>

          <form action={startTerminalMembershipEnrollmentAction} className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
            <HiddenFields />
            {recurringConsent ? <input type="hidden" name="recurringConsent" value="on" /> : null}
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-white p-3 text-emerald-700 shadow-sm">
                <CreditCard className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Card reader</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Collect the first period in person and save the card for renewals.
                </p>
              </div>
            </div>
            <button
              type="submit"
              disabled={!ready || !recurringConsent}
              className="mt-5 w-full rounded-xl bg-emerald-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue to Reader
            </button>
          </form>

          <form action={assignMembershipToClientAction} className="rounded-3xl border border-slate-200 bg-white p-5">
            <HiddenFields />
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-slate-950">Assign without charging</h3>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  Use for comped memberships, imported sales, or outside payments.
                </p>
              </div>
            </div>
            <button
              type="submit"
              disabled={!ready}
              className="mt-5 w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Assign Membership
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}
