import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import {
  assignMembershipToClientAction,
  sellMembershipAction,
  startMembershipPaymentMethodSetupAction,
} from "../actions";

type SearchParams = Promise<{
  error?: string;
  success?: string;
  clientId?: string;
}>;

type ClientRow = {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  status: string;
};

type MembershipPlanRow = {
  id: string;
  name: string;
  active: boolean;
  billing_interval: string;
  price: number;
  signup_fee: number | null;
};

type ActiveMembershipRow = {
  id: string;
  client_id: string;
  name_snapshot: string;
};

function formatCurrency(value: number | null) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(Number(value ?? 0));
}

function billingIntervalLabel(value: string) {
  if (value === "monthly") return "Monthly";
  if (value === "quarterly") return "Quarterly";
  if (value === "yearly") return "Yearly";
  return value;
}

function getErrorBanner(error?: string) {
  if (error === "missing_client") return "Select a client.";
  if (error === "missing_plan") return "Select a membership plan.";
  if (error === "missing_start") return "Choose a membership start date.";
  if (error === "invalid_start") return "Membership start date is invalid.";
  if (error === "client_not_found") return "Selected client was not found.";
  if (error === "plan_not_found") return "Selected membership plan was not found.";
  if (error === "plan_inactive") return "Selected membership plan is inactive.";
  if (error === "membership_lookup_failed") {
    return "Could not check the client’s current membership.";
  }
  if (error === "active_membership_exists") {
    return "This client already has an active membership.";
  }
  if (error === "assign_failed") {
    return "Could not assign membership without billing.";
  }
  if (error === "stripe_session_failed") {
    return "Could not start card-on-file setup.";
  }
  if (error === "membership_sale_failed") {
    return "Could not start membership checkout.";
  }
  return error ? decodeURIComponent(error) : "";
}

function getSuccessBanner(success?: string) {
  if (success === "membership_payment_method_saved") {
    return "Card on file saved successfully.";
  }
  return "";
}

function todayDateValue() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = `${now.getMonth() + 1}`.padStart(2, "0");
  const dd = `${now.getDate()}`.padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default async function SellMembershipPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const errorBanner = getErrorBanner(query.error);
  const successBanner = getSuccessBanner(query.success);
  const requestedClientId =
    typeof query.clientId === "string" ? query.clientId : "";

  const supabase = await createClient();
  const context = await getCurrentStudioContext();
  const studioId = context.studioId;

  const [
    { data: clients, error: clientsError },
    { data: plans, error: plansError },
    { data: activeMemberships, error: activeMembershipsError },
  ] = await Promise.all([
    supabase
  .from("clients")
  .select("id, first_name, last_name, email, status")
  .eq("studio_id", studioId)
  .neq("status", "archived")
  .order("first_name", { ascending: true }),

    supabase
      .from("membership_plans")
      .select("id, name, active, billing_interval, price, signup_fee")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("sort_order", { ascending: true })
      .order("name", { ascending: true }),

    supabase
      .from("client_memberships")
      .select("id, client_id, name_snapshot")
      .eq("studio_id", studioId)
      .in("status", ["active", "pending", "past_due", "unpaid"]),
  ]);

  if (clientsError) {
    throw new Error(`Failed to load clients: ${clientsError.message}`);
  }

  if (plansError) {
    throw new Error(`Failed to load membership plans: ${plansError.message}`);
  }

  if (activeMembershipsError) {
    throw new Error(
      `Failed to load active client memberships: ${activeMembershipsError.message}`
    );
  }

  const typedClients = ((clients ?? []) as ClientRow[]).filter(
  (client) => client.status !== "archived"
);
  const typedPlans = (plans ?? []) as MembershipPlanRow[];
  const typedActiveMemberships = (activeMemberships ?? []) as ActiveMembershipRow[];

  const membershipByClientId = new Map(
    typedActiveMemberships.map((membership) => [membership.client_id, membership])
  );

  const validInitialClientId = typedClients.some(
    (client) => client.id === requestedClientId
  )
    ? requestedClientId
    : "";

  const selectedClient =
    typedClients.find((client) => client.id === validInitialClientId) ?? null;

  const selectedClientMembership = selectedClient
    ? membershipByClientId.get(selectedClient.id) ?? null
    : null;

  const clientSelectDescription = selectedClientMembership
    ? `This client already has a membership: ${selectedClientMembership.name_snapshot}`
    : "Clients with an existing active or pending membership are disabled.";

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-3xl font-semibold tracking-tight">Sell Membership</h2>
          <p className="mt-2 text-slate-600">
            Charge the first cycle, save the card on file, and start recurring
            billing in one flow.
          </p>
        </div>

        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/memberships"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Back to Memberships
          </Link>
        </div>
      </div>

      {selectedClient ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-medium text-emerald-800">
                Membership workflow for client
              </p>
              <p className="text-lg font-semibold text-emerald-950">
                {selectedClient.first_name} {selectedClient.last_name}
              </p>
              {selectedClient.email ? (
                <p className="text-sm text-emerald-800">{selectedClient.email}</p>
              ) : null}
              {selectedClientMembership ? (
                <p className="mt-1 text-sm text-amber-700">
                  Existing membership: {selectedClientMembership.name_snapshot}
                </p>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              <Link
                href={`/app/clients/${selectedClient.id}`}
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
              >
                View Client
              </Link>
              <Link
                href="/app/memberships/sell"
                className="rounded-xl border border-emerald-300 bg-white px-3 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100"
              >
                Clear Selection
              </Link>
            </div>
          </div>
        </div>
      ) : null}

      {errorBanner ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorBanner}
        </div>
      ) : null}

      {successBanner ? (
        <div className="rounded-2xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {successBanner}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_0.9fr]">
        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">
              Membership Sale
            </h3>
            <p className="mt-2 text-sm text-slate-600">
              This is the standard studio workflow. It collects the first
              payment, saves the card on file, and starts recurring billing.
            </p>

            <form action={sellMembershipAction} className="mt-6 space-y-5">
              <input type="hidden" name="returnTo" value="/app/memberships/sell" />

              <div>
                <label htmlFor="clientId" className="mb-1 block text-sm font-medium">
                  Client
                </label>
                <select
                  id="clientId"
                  name="clientId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  defaultValue={validInitialClientId}
                >
                  <option value="">Select client</option>
                  {typedClients.map((client) => {
                    const activeMembership = membershipByClientId.get(client.id);

                    return (
                      <option
                        key={client.id}
                        value={client.id}
                        disabled={Boolean(activeMembership)}
                      >
                        {client.first_name} {client.last_name}
                        {client.email ? ` • ${client.email}` : ""}
                        {activeMembership
                          ? ` • Existing membership: ${activeMembership.name_snapshot}`
                          : ""}
                      </option>
                    );
                  })}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {clientSelectDescription}
                </p>
              </div>

              <div>
                <label
                  htmlFor="membershipPlanId"
                  className="mb-1 block text-sm font-medium"
                >
                  Membership Plan
                </label>
                <select
                  id="membershipPlanId"
                  name="membershipPlanId"
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  defaultValue=""
                >
                  <option value="">Select membership plan</option>
                  {typedPlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} • {formatCurrency(plan.price)} /{" "}
                      {billingIntervalLabel(plan.billing_interval)}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="startsOn" className="mb-1 block text-sm font-medium">
                  Start Date
                </label>
                <input
                  id="startsOn"
                  name="startsOn"
                  type="date"
                  defaultValue={todayDateValue()}
                  className="w-full rounded-xl border border-slate-300 px-3 py-2"
                />
              </div>

              <label className="flex items-start gap-3 rounded-xl border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  name="autoRenew"
                  defaultChecked
                  className="mt-1"
                />
                <div>
                  <p className="font-medium text-slate-900">Auto renew</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Leave enabled for standard recurring memberships.
                  </p>
                </div>
              </label>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800"
                >
                  Sell Membership
                </button>
              </div>
            </form>
          </div>

          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">Admin Tools</h3>
            <p className="mt-2 text-sm text-slate-600">
              Use these only for recovery cases or offline/manual workflows.
            </p>

            <div className="mt-6 space-y-6">
              <form
                action={startMembershipPaymentMethodSetupAction}
                className="space-y-4 rounded-2xl border bg-slate-50 p-5"
              >
                <input type="hidden" name="returnTo" value="/app/memberships/sell" />

                <div>
                  <p className="font-medium text-slate-900">Save Card on File</p>
                  <p className="mt-1 text-sm text-slate-600">
                    Save a card without selling a membership right now.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="setupClientId"
                    className="mb-1 block text-sm font-medium"
                  >
                    Client
                  </label>
                  <select
                    id="setupClientId"
                    name="clientId"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    defaultValue={validInitialClientId}
                  >
                    <option value="">Select client</option>
                    {typedClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.first_name} {client.last_name}
                        {client.email ? ` • ${client.email}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  type="submit"
                  className="rounded-xl border border-slate-300 px-4 py-2 text-slate-900 hover:bg-white"
                >
                  Save Card on File
                </button>
              </form>

              <form
                action={assignMembershipToClientAction}
                className="space-y-4 rounded-2xl border bg-slate-50 p-5"
              >
                <input type="hidden" name="returnTo" value="/app/memberships/sell" />

                <div>
                  <p className="font-medium text-slate-900">
                    Assign Membership Without Billing
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    Use only for exceptions such as complimentary, manual, or
                    migrated memberships.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="manualClientId"
                    className="mb-1 block text-sm font-medium"
                  >
                    Client
                  </label>
                  <select
                    id="manualClientId"
                    name="clientId"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    defaultValue={validInitialClientId}
                  >
                    <option value="">Select client</option>
                    {typedClients.map((client) => {
                      const activeMembership = membershipByClientId.get(client.id);

                      return (
                        <option
                          key={client.id}
                          value={client.id}
                          disabled={Boolean(activeMembership)}
                        >
                          {client.first_name} {client.last_name}
                          {client.email ? ` • ${client.email}` : ""}
                          {activeMembership
                            ? ` • Existing membership: ${activeMembership.name_snapshot}`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="manualPlanId"
                    className="mb-1 block text-sm font-medium"
                  >
                    Membership Plan
                  </label>
                  <select
                    id="manualPlanId"
                    name="membershipPlanId"
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                    defaultValue=""
                  >
                    <option value="">Select membership plan</option>
                    {typedPlans.map((plan) => (
                      <option key={plan.id} value={plan.id}>
                        {plan.name} • {formatCurrency(plan.price)} /{" "}
                        {billingIntervalLabel(plan.billing_interval)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="manualStartsOn"
                    className="mb-1 block text-sm font-medium"
                  >
                    Start Date
                  </label>
                  <input
                    id="manualStartsOn"
                    name="startsOn"
                    type="date"
                    defaultValue={todayDateValue()}
                    className="w-full rounded-xl border border-slate-300 px-3 py-2"
                  />
                </div>

                <label className="flex items-start gap-3 rounded-xl border bg-white p-4">
                  <input
                    type="checkbox"
                    name="autoRenew"
                    defaultChecked
                    className="mt-1"
                  />
                  <div>
                    <p className="font-medium text-slate-900">Auto renew</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Leave enabled only if that matches the manual arrangement.
                    </p>
                  </div>
                </label>

                <button
                  type="submit"
                  className="rounded-xl border border-slate-300 px-4 py-2 text-slate-900 hover:bg-white"
                >
                  Assign Without Billing
                </button>
              </form>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-slate-900">
              Available Plans
            </h3>

            <div className="mt-4 space-y-3">
              {typedPlans.length === 0 ? (
                <p className="text-sm text-slate-500">
                  No active membership plans available.
                </p>
              ) : (
                typedPlans.map((plan) => (
                  <div key={plan.id} className="rounded-xl border bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium text-slate-900">{plan.name}</p>
                        <p className="mt-1 text-sm text-slate-500">
                          {billingIntervalLabel(plan.billing_interval)}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="font-medium text-slate-900">
                          {formatCurrency(plan.price)}
                        </p>
                        <p className="mt-1 text-sm text-slate-500">
                          Signup fee:{" "}
                          {plan.signup_fee ? formatCurrency(plan.signup_fee) : "None"}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-900">
            Standard flow: select the membership, collect the first payment, save
            the card on file, and start recurring billing in one step.
          </div>
        </div>
      </div>
    </div>
  );
}