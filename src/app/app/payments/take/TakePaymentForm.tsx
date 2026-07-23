"use client";

import { useActionState, useMemo, useState } from "react";
import {
  Banknote,
  CreditCard,
  Landmark,
  Search,
  Send,
  Smartphone,
  UserRound,
} from "lucide-react";
import { createPaymentAction } from "../actions";

type PaymentArrangementOption = {
  id: string;
  client_id: string;
  remaining_balance: number;
  first_due_date: string;
  package_name: string;
};

type MembershipOption = {
  id: string;
  client_id: string;
  name: string;
  price: number;
  current_period_start: string;
  current_period_end: string;
  status: string;
  auto_renew: boolean;
  cancel_at_period_end: boolean;
};

type ClientOption = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
};

const initialState = { error: "" };

function clientName(client: ClientOption) {
  return `${client.first_name} ${client.last_name}`.trim() || client.email || "Unnamed client";
}

export default function TakePaymentForm({
  clients,
  arrangements,
  memberships,
}: {
  clients: ClientOption[];
  arrangements: PaymentArrangementOption[];
  memberships: MembershipOption[];
}) {
  const [state, formAction, pending] = useActionState(createPaymentAction, initialState);
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [paymentAction, setPaymentAction] = useState("manual");
  const [method, setMethod] = useState("card");
  const [serviceType, setServiceType] = useState("general");
  const [arrangementId, setArrangementId] = useState("");
  const [clientMembershipId, setClientMembershipId] = useState("");
  const today = new Date().toISOString().slice(0, 10);

  const filteredClients = useMemo(() => {
    const value = search.trim().toLowerCase();
    if (!value) return clients;

    return clients.filter((client) =>
      `${client.first_name} ${client.last_name} ${client.email ?? ""}`
        .toLowerCase()
        .includes(value),
    );
  }, [clients, search]);

  const selectedClient =
    clients.find((client) => client.id === clientId) ?? null;
  const clientArrangements = arrangements.filter(
    (arrangement) => arrangement.client_id === clientId,
  );
  const selectedArrangement =
    clientArrangements.find((arrangement) => arrangement.id === arrangementId) ?? null;
  const clientMemberships = memberships.filter(
    (membership) => membership.client_id === clientId,
  );
  const selectedMembership =
    clientMemberships.find((membership) => membership.id === clientMembershipId) ?? null;

  return (
    <form action={formAction} className="space-y-6">
      <input
        type="hidden"
        name="entryMode"
        value={serviceType === "payment_arrangement" ? "arrangement_payment" : "standard"}
      />
      <input type="hidden" name="arrangementId" value={arrangementId} />
      <input type="hidden" name="clientMembershipId" value={clientMembershipId} />
      <input type="hidden" name="clientId" value={clientId} />
      <input type="hidden" name="status" value={paymentAction === "manual" ? "paid" : "pending"} />
      <input type="hidden" name="returnTo" value="/app/payments" />

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <UserRound className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Step 1</p>
            <h2 className="text-xl font-semibold text-slate-950">Choose the client</h2>
          </div>
        </div>

        <div className="relative mt-5">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or email"
            className="w-full rounded-xl border border-slate-300 bg-white py-3 pl-10 pr-3 text-sm outline-none focus:border-[var(--brand-primary)]"
          />
        </div>

        <div className="mt-4 max-h-72 space-y-2 overflow-y-auto pr-1">
          {filteredClients.map((client) => {
            const active = client.id === clientId;
            return (
              <button
                key={client.id}
                type="button"
                onClick={() => setClientId(client.id)}
                className={`w-full rounded-2xl border p-4 text-left transition ${
                  active
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                    : "border-slate-200 bg-slate-50 hover:border-slate-300"
                }`}
              >
                <p className="font-semibold text-slate-950">{clientName(client)}</p>
                <p className="mt-1 text-sm text-slate-500">{client.email || "No email on file"}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
            <Banknote className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Step 2</p>
            <h2 className="text-xl font-semibold text-slate-950">Enter payment details</h2>
            <p className="mt-1 text-sm text-slate-500">
              Record a membership renewal, general client payment, floor rental, event payment, or other service payment.
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Payment date</span>
            <input
              name="paymentDate"
              type="date"
              required
              defaultValue={today}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Payment for</span>
            <select
              name="serviceType"
              value={serviceType}
              onChange={(event) => {
                setServiceType(event.target.value);
                setArrangementId("");
                setClientMembershipId("");
                if (event.target.value === "payment_arrangement" || event.target.value === "membership") {
                  setPaymentAction("manual");
                }
              }}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            >
              <option value="general">General client payment</option>
              <option value="membership">Membership payment or renewal</option>
              <option value="payment_arrangement">Payment arrangement installment</option>
              <option value="floor_rental">Floor rental</option>
              <option value="event_registration">Event registration</option>
              <option value="other">Other service</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Amount</span>
            <input
              name="amount"
              type="number"
              inputMode="decimal"
              min="0.01"
              max="100000"
              step="0.01"
              required
              placeholder="0.00"
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Manual method</span>
            <select
              name="paymentMethod"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              disabled={paymentAction !== "manual"}
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm disabled:bg-slate-100"
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

        {serviceType === "membership" ? (
          <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-violet-950">Membership to renew</span>
              <select
                value={clientMembershipId}
                onChange={(event) => setClientMembershipId(event.target.value)}
                required
                className="w-full rounded-xl border border-violet-300 bg-white px-3 py-2.5 text-sm"
              >
                <option value="">Select a membership</option>
                {clientMemberships.map((membership) => (
                  <option key={membership.id} value={membership.id}>
                    {membership.name} — ${membership.price.toFixed(2)} — current period ends {membership.current_period_end}
                  </option>
                ))}
              </select>
            </label>
            {selectedMembership ? (
              <p className="mt-2 text-xs leading-5 text-violet-800">
                Payment will be applied to the open period. When the current period is already paid and expired, DanceFlow will create the next renewal period automatically.
              </p>
            ) : clientId ? (
              <p className="mt-2 text-xs text-amber-800">No active membership is available for this client.</p>
            ) : null}
          </div>
        ) : null}

        {serviceType === "payment_arrangement" ? (
          <label className="mt-5 block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Open payment arrangement</span>
            <select
              value={arrangementId}
              onChange={(event) => setArrangementId(event.target.value)}
              required
              className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
            >
              <option value="">Select an arrangement</option>
              {clientArrangements.map((arrangement) => (
                <option key={arrangement.id} value={arrangement.id}>
                  {arrangement.package_name} — ${arrangement.remaining_balance.toFixed(2)} remaining
                </option>
              ))}
            </select>
            {selectedArrangement ? (
              <p className="mt-2 text-xs text-slate-500">
                Next scheduled date: {selectedArrangement.first_due_date}
              </p>
            ) : null}
          </label>
        ) : null}

        <label className="mt-5 block">
          <span className="mb-2 block text-sm font-medium text-slate-700">Notes</span>
          <textarea
            name="notes"
            rows={3}
            maxLength={1200}
            placeholder="What this payment covers, reference number, or front-desk note"
            className="w-full rounded-xl border border-slate-300 px-3 py-2.5 text-sm"
          />
        </label>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <p className="text-sm text-slate-500">Step 3</p>
          <h2 className="text-xl font-semibold text-slate-950">Choose how to collect it</h2>
        </div>

        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {[
            {
              value: "manual",
              label: "Record collected payment",
              description: "Cash, check, Venmo, Zelle, ACH, or card already collected.",
              icon: Landmark,
            },
            {
              value: "terminal",
              label: "Card reader",
              description: "Create a pending payment and send it to the studio reader.",
              icon: CreditCard,
            },
            {
              value: "charge_now",
              label: "Online card checkout",
              description: "Open Stripe checkout for the selected client.",
              icon: Smartphone,
            },
            {
              value: "send_to_portal",
              label: "Send payment request",
              description: "Create a pending request for the client portal.",
              icon: Send,
            },
          ].map((option) => {
            const Icon = option.icon;
            const active = paymentAction === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  if ((serviceType === "payment_arrangement" || serviceType === "membership") && option.value !== "manual") return;
                  setPaymentAction(option.value);
                }}
                disabled={
                  (serviceType === "payment_arrangement" || serviceType === "membership") &&
                  option.value !== "manual"
                }
                className={`rounded-2xl border p-4 text-left transition ${
                  active
                    ? "border-[var(--brand-primary)] bg-[var(--brand-primary-soft)]"
                    : (serviceType === "payment_arrangement" || serviceType === "membership") &&
                        option.value !== "manual"
                      ? "cursor-not-allowed border-slate-200 bg-slate-100 opacity-50"
                      : "border-slate-200 bg-slate-50 hover:border-slate-300"
                }`}
              >
                <Icon className="h-5 w-5 text-[var(--brand-primary)]" />
                <p className="mt-3 font-semibold text-slate-950">{option.label}</p>
                <p className="mt-1 text-sm leading-6 text-slate-500">{option.description}</p>
              </button>
            );
          })}
        </div>

        <button
          type="submit"
          name="paymentAction"
          value={paymentAction}
          disabled={
            pending ||
            !selectedClient ||
            (serviceType === "payment_arrangement" && !selectedArrangement) ||
            (serviceType === "membership" && !selectedMembership)
          }
          className="mt-6 w-full rounded-xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto"
        >
          {pending
            ? "Processing..."
            : paymentAction === "manual"
              ? "Record payment"
              : paymentAction === "terminal"
                ? "Continue to card reader"
                : paymentAction === "charge_now"
                  ? "Continue to online checkout"
                  : "Create payment request"}
        </button>

        {state?.error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}
      </section>
    </form>
  );
}