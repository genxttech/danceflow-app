"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { enrollClassAttendeeAction } from "../actions";
import InstructorClientSearchField from "../InstructorClientSearchField";
import type { BookableClientSearchResult } from "../actions";
import type { EligibleFundingSource } from "./page";

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
  eligibleFundingSourcesByClientId,
  instructorSearchMode,
  isBroadStaff,
}: {
  classes: ClassOption[];
  clients: ClientOption[];
  clientPackagesByClientId: Record<string, ClientPackageRow[]>;
  clientMembershipsByClientId: Record<string, ClientMembershipRow[]>;
  eligibleFundingSourcesByClientId: Record<string, EligibleFundingSource[]>;
  instructorSearchMode: boolean;
  isBroadStaff: boolean;
}) {
  const [appointmentId, setAppointmentId] = useState(classes[0]?.id ?? "");
  const [clientId, setClientId] = useState("");
  const [selectedClientLabel, setSelectedClientLabel] = useState("");
  const [billingType, setBillingType] = useState("package_credit");
  const [clientPackageId, setClientPackageId] = useState("");
  const [clientMembershipId, setClientMembershipId] = useState("");
  const [showManualBilling, setShowManualBilling] = useState(false);
  const [submitError, setSubmitError] = useState("");

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

  const eligibleSources = useMemo(
    () => (clientId ? eligibleFundingSourcesByClientId[clientId] ?? [] : []),
    [clientId, eligibleFundingSourcesByClientId],
  );

  // GC-2 item C: one valid funding source -> preselect it; several -> a
  // compact explicit chooser; none -> fall back to the manual controls
  // (package/PAYG/free-comped), never silently leaving an unfunded
  // membership enrollment selected.
  useEffect(() => {
    if (!clientId) {
      setShowManualBilling(false);
      return;
    }

    if (eligibleSources.length === 1) {
      const only = eligibleSources[0];
      setShowManualBilling(false);
      if (only.type === "package") {
        setBillingType("package_credit");
        setClientPackageId(only.id);
        setClientMembershipId("");
      } else {
        setBillingType("membership");
        setClientMembershipId(only.id);
        setClientPackageId("");
      }
      return;
    }

    if (eligibleSources.length === 0) {
      setShowManualBilling(true);
      setBillingType("pay_as_you_go");
      setClientPackageId("");
      setClientMembershipId("");
    }
  }, [clientId, eligibleSources]);

  // PR #70 review correction: never let the form submit
  // billingType='membership' with no concrete membership selected -- the
  // native `required` attribute on the manual membership <select> already
  // blocks this, but this is a second, explicit guard (in case that field
  // isn't the one currently rendered, or JS interacts with it unexpectedly)
  // and gives a clearer message than the browser's own validation tooltip.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (billingType === "membership" && !clientMembershipId) {
      event.preventDefault();
      setSubmitError("Select a specific membership before billing this enrollment to Membership.");
      return;
    }
    setSubmitError("");
  }

  function selectEligibleSource(source: EligibleFundingSource) {
    if (source.type === "package") {
      setBillingType("package_credit");
      setClientPackageId(source.id);
      setClientMembershipId("");
    } else {
      setBillingType("membership");
      setClientMembershipId(source.id);
      setClientPackageId("");
    }
  }

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
    <form action={enrollClassAttendeeAction} onSubmit={handleSubmit} className="space-y-5">
      <input type="hidden" name="returnTo" value={`/app/schedule/${appointmentId}`} />

      {submitError ? (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {submitError}
        </div>
      ) : null}

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

          {!clientId ? (
            <p className="text-sm text-slate-500">Select a client to see their eligible funding.</p>
          ) : !showManualBilling && eligibleSources.length === 1 ? (
            <div>
              <input type="hidden" name="billingType" value={billingType} />
              <input type="hidden" name="clientPackageId" value={clientPackageId} />
              <input type="hidden" name="clientMembershipId" value={clientMembershipId} />
              <p className="mb-3 text-sm text-slate-500">
                This student has one funding source that covers group classes.
              </p>
              <div className="flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <div>
                  <p className="font-medium text-slate-900">{eligibleSources[0].label}</p>
                  <p className="text-sm text-slate-600">{eligibleSources[0].remainingLabel}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowManualBilling(true)}
                  className="text-sm font-medium text-[var(--brand-primary)] underline"
                >
                  Change
                </button>
              </div>
            </div>
          ) : !showManualBilling && eligibleSources.length > 1 ? (
            <div>
              <input type="hidden" name="billingType" value={billingType} />
              <input type="hidden" name="clientPackageId" value={clientPackageId} />
              <input type="hidden" name="clientMembershipId" value={clientMembershipId} />
              <p className="mb-3 text-sm text-slate-500">
                This student has more than one funding source that covers group classes. Choose one.
              </p>
              <div className="grid gap-2">
                {eligibleSources.map((source) => {
                  const selected =
                    (source.type === "package" && billingType === "package_credit" && clientPackageId === source.id) ||
                    (source.type === "membership" && billingType === "membership" && clientMembershipId === source.id);
                  return (
                    <label
                      key={`${source.type}-${source.id}`}
                      className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 ${
                        selected ? "border-[var(--brand-primary)] bg-[var(--brand-muted)]" : "border-slate-200"
                      }`}
                    >
                      <span>
                        <span className="font-medium text-slate-900">{source.label}</span>
                        <span className="ml-2 text-sm text-slate-600">{source.remainingLabel}</span>
                      </span>
                      <input
                        type="radio"
                        name="eligibleFundingSourceChoice"
                        checked={selected}
                        onChange={() => selectEligibleSource(source)}
                      />
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={() => setShowManualBilling(true)}
                className="mt-3 text-sm font-medium text-[var(--brand-primary)] underline"
              >
                Bill manually instead
              </button>
            </div>
          ) : (
            <>
              <p className="mb-4 text-sm text-slate-500">
                {eligibleSources.length === 0
                  ? "No membership or package covers this class for this student — choose how to bill manually."
                  : "Choose how this student's enrollment is billed."}
              </p>

              {eligibleSources.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowManualBilling(false)}
                  className="mb-4 text-sm font-medium text-[var(--brand-primary)] underline"
                >
                  Back to suggested funding
                </button>
              ) : null}

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
                      if (!classItem) return null;
                      const remaining = classItem.is_unlimited
                        ? "Unlimited"
                        : `${classItem.quantity_remaining ?? 0} remaining`;
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
                    required
                    value={clientMembershipId}
                    onChange={(event) => setClientMembershipId(event.target.value)}
                    className="w-full rounded-xl border border-slate-300 px-3 py-3 text-sm"
                  >
                    <option value="" disabled>
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
                  {availableMemberships.length === 0 ? (
                    <p className="mt-1.5 text-xs text-slate-500">
                      This client has no active membership. Choose Package credit, Pay as you go, or Free / comped
                      instead.
                    </p>
                  ) : null}
                </>
              ) : null}
            </>
          )}
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
