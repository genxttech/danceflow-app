"use client";

import { useMemo, useState } from "react";
import { enrollClassAttendeeAction } from "../actions";
import InstructorClientSearchField from "../InstructorClientSearchField";
import type { BookableClientSearchResult } from "../actions";

type ClassOption = {
  id: string;
  title: string | null;
  startsAt: string;
  endsAt: string | null;
  instructorName: string | null;
};

type ClientOption = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  status: string | null;
};

type ClientPackageItemRow = {
  usage_type: string | null;
  quantity_remaining: number | null;
  is_unlimited: boolean | null;
};

type ClientPackageRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  active: boolean | null;
  client_package_items: ClientPackageItemRow[] | null;
};

type ClientMembershipRow = {
  id: string;
  client_id: string | null;
  name_snapshot: string | null;
  status: string;
};

function formatClassLabel(item: ClassOption) {
  const when = new Date(item.startsAt);
  const whenLabel = Number.isNaN(when.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(when);

  const title = item.title?.trim() || "Group Class";
  const instructor = item.instructorName ? ` with ${item.instructorName}` : "";
  return `${title}${instructor} — ${whenLabel}`;
}

export default function EnrollStudentForm({
  classes,
  clients,
  clientPackagesByClientId,
  clientMembershipsByClientId,
  instructorSearchMode,
  isBroadStaff,
}: {
  classes: ClassOption[];
  clients: ClientOption[];
  clientPackagesByClientId: Record<string, ClientPackageRow[]>;
  clientMembershipsByClientId: Record<string, ClientMembershipRow[]>;
  instructorSearchMode: boolean;
  isBroadStaff: boolean;
}) {
  const [appointmentId, setAppointmentId] = useState(classes[0]?.id ?? "");
  const [clientId, setClientId] = useState("");
  const [selectedClientLabel, setSelectedClientLabel] = useState("");
  const [billingType, setBillingType] = useState("package_credit");
  const [clientPackageId, setClientPackageId] = useState("");
  const [clientMembershipId, setClientMembershipId] = useState("");

  function selectSearchedClient(client: BookableClientSearchResult) {
    setClientId(client.id);
    setSelectedClientLabel(`${client.first_name ?? ""} ${client.last_name ?? ""}`.trim());
  }

  const availablePackages = useMemo(
    () => (clientId ? clientPackagesByClientId[clientId] ?? [] : []),
    [clientId, clientPackagesByClientId],
  );

  const availableMemberships = useMemo(
    () => (clientId ? clientMembershipsByClientId[clientId] ?? [] : []),
    [clientId, clientMembershipsByClientId],
  );

  if (classes.length === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm text-slate-600">
          There are no upcoming classes available to enroll a student into
          {instructorSearchMode ? " for you" : ""}. Use{" "}
          <a href="/app/schedule/new" className="font-medium underline">
            Create Class
          </a>{" "}
          to schedule one first.
        </p>
      </section>
    );
  }

  return (
    <form action={enrollClassAttendeeAction} className="space-y-5">
      <input type="hidden" name="returnTo" value={`/app/schedule/${appointmentId}`} />

      <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">Class</h3>

        <label htmlFor="appointmentId" className="mb-1.5 block text-sm font-medium">
          Upcoming class *
        </label>
        <select
          id="appointmentId"
          name="appointmentId"
          required
          value={appointmentId}
          onChange={(event) => setAppointmentId(event.target.value)}
          className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
        >
          {classes.map((item) => (
            <option key={item.id} value={item.id}>
              {formatClassLabel(item)}
            </option>
          ))}
        </select>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
        <h3 className="mb-4 text-lg font-semibold text-slate-900">Student</h3>

        <label htmlFor="clientId" className="mb-1.5 block text-sm font-medium">
          Client *
        </label>
        {instructorSearchMode ? (
          <InstructorClientSearchField
            fieldName="clientId"
            clientId={clientId}
            selectedClientLabel={selectedClientLabel}
            onSelect={selectSearchedClient}
            onClear={() => {
              setClientId("");
              setSelectedClientLabel("");
            }}
          />
        ) : (
          <select
            id="clientId"
            name="clientId"
            required
            value={clientId}
            onChange={(event) => {
              setClientId(event.target.value);
              setClientPackageId("");
              setClientMembershipId("");
            }}
            className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
          >
            <option value="">Select client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.first_name} {client.last_name}
              </option>
            ))}
          </select>
        )}
      </section>

      {isBroadStaff ? (
        <section className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm md:p-6">
          <h3 className="mb-1 text-lg font-semibold text-slate-900">Billing</h3>
          <p className="mb-4 text-sm text-slate-500">
            Choose how this student&apos;s enrollment is billed.
          </p>

          <label htmlFor="billingType" className="mb-1.5 block text-sm font-medium">
            Billing type
          </label>
          <select
            id="billingType"
            name="billingType"
            value={billingType}
            onChange={(event) => setBillingType(event.target.value)}
            className="mb-4 w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
          >
            <option value="package_credit">Package credit</option>
            <option value="membership">Membership</option>
            <option value="pay_as_you_go">Pay as you go</option>
            <option value="free_comped">Free / comped</option>
          </select>

          {billingType === "package_credit" ? (
            <>
              <label htmlFor="clientPackageId" className="mb-1.5 block text-sm font-medium">
                Package
              </label>
              <select
                id="clientPackageId"
                name="clientPackageId"
                value={clientPackageId}
                onChange={(event) => setClientPackageId(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
              >
                <option value="">
                  {availablePackages.length ? "Select a package" : "No active packages for this client"}
                </option>
                {availablePackages.map((pkg) => {
                  const classItem = (pkg.client_package_items ?? []).find(
                    (item) => item.usage_type === "group_class",
                  );
                  const remaining = classItem?.is_unlimited
                    ? "Unlimited"
                    : `${classItem?.quantity_remaining ?? 0} remaining`;
                  return (
                    <option key={pkg.id} value={pkg.id}>
                      {pkg.name_snapshot || "Package"} — {remaining}
                    </option>
                  );
                })}
              </select>
            </>
          ) : null}

          {billingType === "membership" ? (
            <>
              <label htmlFor="clientMembershipId" className="mb-1.5 block text-sm font-medium">
                Membership
              </label>
              <select
                id="clientMembershipId"
                name="clientMembershipId"
                value={clientMembershipId}
                onChange={(event) => setClientMembershipId(event.target.value)}
                className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
              >
                <option value="">
                  {availableMemberships.length
                    ? "Select a membership"
                    : "No active memberships for this client"}
                </option>
                {availableMemberships.map((membership) => (
                  <option key={membership.id} value={membership.id}>
                    {membership.name_snapshot || "Membership"}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </section>
      ) : (
        <section className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-600 md:p-6">
          Billing for this enrollment is automatically applied from the
          student&apos;s own eligible package. If none is available, an
          owner, admin, or front desk will need to complete this enrollment.
        </section>
      )}

      <button
        type="submit"
        className="w-full rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-semibold text-white hover:opacity-90 md:w-auto"
      >
        Enroll Student
      </button>
    </form>
  );
}
