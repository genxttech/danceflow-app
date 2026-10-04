"use client";

import { useEffect, useRef, useState } from "react";
import { enrollClassAttendeeAction } from "@/app/app/schedule/actions";
import {
  getRosterFundingOptionsAction,
  searchRosterClientsAction,
  type RosterClientResult,
  type RosterFundingOptions,
} from "@/app/app/schedule/groupClassRosterActions";
import RosterSubmitButton from "./RosterSubmitButton";

type BillingChoice = "package_credit" | "membership" | "pay_as_you_go" | "free_comped";

const BILLING_LABELS: Record<BillingChoice, string> = {
  package_credit: "Package credit",
  membership: "Membership",
  pay_as_you_go: "Pay as you go",
  free_comped: "Comped (no charge)",
};

const inputClass =
  "w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100";

/**
 * GC-S1D-1: "Add dancer" for ONE class occurrence, in the class context. Progressive disclosure: collapsed until opened;
 * search a dancer, confirm the funding (automatic where exactly one eligible source exists), submit. The submit goes to
 * the existing enrollClassAttendeeAction (-> enroll_class_attendee), so duplicate prevention, capacity, cancelled-class
 * refusal and funding eligibility stay database-authoritative. A refusal returns to this class page with a fixed message.
 * Enrollment only: attendance and payment are separate workflows. There is deliberately no series scope here.
 */
export default function AddDancerPanel({
  appointmentId,
  returnTo,
  isBroadStaff,
  full,
  defaultOpen = false,
}: {
  appointmentId: string;
  returnTo: string;
  isBroadStaff: boolean;
  full: boolean;
  /** Reopened after a refusal so the owner can correct the dancer or funding and retry. */
  defaultOpen?: boolean;
}) {
  const [searchText, setSearchText] = useState("");
  const [results, setResults] = useState<RosterClientResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<RosterClientResult | null>(null);
  const [options, setOptions] = useState<RosterFundingOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [billing, setBilling] = useState<BillingChoice>("package_credit");
  const [packageId, setPackageId] = useState("");
  const [membershipId, setMembershipId] = useState("");
  const [manual, setManual] = useState(false);
  const [localError, setLocalError] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const trimmed = searchText.trim();
  const canSearch = !selected && trimmed.length >= 2;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!canSearch) return;
    timer.current = setTimeout(() => {
      setSearching(true);
      searchRosterClientsAction(appointmentId, trimmed)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [appointmentId, trimmed, canSearch]);

  function applyEligible(type: "package" | "membership", id: string) {
    setManual(false);
    if (type === "package") {
      setBilling("package_credit");
      setPackageId(id);
      setMembershipId("");
    } else {
      setBilling("membership");
      setMembershipId(id);
      setPackageId("");
    }
  }

  function choose(client: RosterClientResult) {
    if (client.alreadyEnrolled) return;
    setSelected(client);
    setResults([]);
    setLocalError("");
    setOptions(null);
    setManual(false);
    setPackageId("");
    setMembershipId("");
    if (!isBroadStaff) {
      setOptions({ mode: "auto" });
      return;
    }
    setLoadingOptions(true);
    getRosterFundingOptionsAction(appointmentId, client.id)
      .then((result) => {
        setOptions(result);
        if (result.mode !== "choose") return;
        if (result.eligible.length === 1) {
          applyEligible(result.eligible[0].type, result.eligible[0].id);
        } else if (result.eligible.length === 0) {
          // Nothing on file to draw from: say so and default to the visible, changeable manual choice.
          setBilling("pay_as_you_go");
          setManual(true);
        }
      })
      .catch(() => setOptions({ mode: "choose", eligible: [], packages: [], memberships: [] }))
      .finally(() => setLoadingOptions(false));
  }

  function clearSelection() {
    setSelected(null);
    setOptions(null);
    setSearchText("");
    setLocalError("");
  }

  function validateBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (!selected) {
      event.preventDefault();
      setLocalError("Choose a dancer first.");
      return;
    }
    if (isBroadStaff && billing === "membership" && !membershipId) {
      event.preventDefault();
      setLocalError("Select a specific membership before billing this enrollment to Membership.");
      return;
    }
    setLocalError("");
  }

  if (full) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        This class is full. {isBroadStaff ? "Raise Maximum students in Edit class to add more dancers." : "Ask front desk to raise Maximum students to add more dancers."}
      </p>
    );
  }

  const chooseOptions = options && options.mode === "choose" ? options : null;
  const eligible = chooseOptions?.eligible ?? [];
  const showFundingBlock = isBroadStaff && selected && !loadingOptions && chooseOptions;

  return (
    <details open={defaultOpen} className="group rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-indigo-800 [&::-webkit-details-marker]:hidden">
        + Add dancer
      </summary>

      <form action={enrollClassAttendeeAction} onSubmit={validateBeforeSubmit} className="mt-4 space-y-4">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <input type="hidden" name="errorReturnTo" value={returnTo} />
        <input type="hidden" name="clientId" value={selected?.id ?? ""} />
        {isBroadStaff ? (
          <>
            <input type="hidden" name="billingType" value={billing} />
            <input type="hidden" name="clientPackageId" value={billing === "package_credit" ? packageId : ""} />
            <input type="hidden" name="clientMembershipId" value={billing === "membership" ? membershipId : ""} />
          </>
        ) : null}

        {localError ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{localError}</p>
        ) : null}

        <div>
          <label htmlFor="rosterDancerSearch" className="mb-1 block text-sm font-medium text-slate-800">Dancer</label>
          {selected ? (
            <div className="flex items-center justify-between rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
              <span className="font-medium text-slate-900">{selected.name}</span>
              <button type="button" onClick={clearSelection} className="text-xs font-semibold text-indigo-700 underline">Change</button>
            </div>
          ) : (
            <>
              <input
                id="rosterDancerSearch"
                type="search"
                autoComplete="off"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Search by first or last name"
                className={inputClass}
              />
              {trimmed.length > 0 && trimmed.length < 2 ? <p className="mt-1 text-xs text-slate-500">Type at least 2 letters.</p> : null}
              {canSearch && searching ? <p className="mt-1 text-xs text-slate-500">Searching…</p> : null}
              {canSearch && !searching && results.length === 0 ? <p className="mt-1 text-xs text-slate-500">No matching dancers.</p> : null}
              {results.length > 0 ? (
                <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white text-sm">
                  {results.map((client) => (
                    <li key={client.id}>
                      <button
                        type="button"
                        onClick={() => choose(client)}
                        disabled={client.alreadyEnrolled}
                        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        <span>{client.name}</span>
                        {client.alreadyEnrolled ? <span className="text-xs">Already enrolled</span> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        {selected && !isBroadStaff ? (
          <p className="text-xs text-slate-600">
            Billing is applied automatically from the dancer&apos;s eligible package or membership. If more than one applies, ask
            front desk to complete the enrollment.
          </p>
        ) : null}

        {selected && isBroadStaff && loadingOptions ? <p className="text-xs text-slate-500">Checking funding…</p> : null}

        {showFundingBlock ? (
          <fieldset className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Funding</legend>

            {eligible.length === 1 && !manual ? (
              <p className="text-slate-800">
                Bills to <span className="font-medium">{eligible[0].label}</span>{" "}
                <span className="text-slate-500">({eligible[0].remainingLabel})</span>{" "}
                <button type="button" onClick={() => setManual(true)} className="ml-1 text-xs font-semibold text-indigo-700 underline">Change</button>
              </p>
            ) : null}

            {eligible.length > 1 && !manual ? (
              <div className="space-y-1">
                <p className="text-xs text-slate-600">This dancer has more than one eligible source. Choose one:</p>
                {eligible.map((source) => {
                  const active = source.type === "package" ? billing === "package_credit" && packageId === source.id : billing === "membership" && membershipId === source.id;
                  return (
                    <label key={`${source.type}:${source.id}`} className="flex items-center gap-2">
                      <input type="radio" name="rosterFundingChoice" checked={active} onChange={() => applyEligible(source.type, source.id)} />
                      <span>{source.label} <span className="text-slate-500">({source.remainingLabel})</span></span>
                    </label>
                  );
                })}
                <button type="button" onClick={() => setManual(true)} className="text-xs font-semibold text-indigo-700 underline">Bill another way</button>
              </div>
            ) : null}

            {eligible.length === 0 && manual ? (
              <p className="text-xs text-slate-600">No eligible package or membership on file. Choose how to bill this enrollment:</p>
            ) : null}

            {manual ? (
              <div className="space-y-2">
                <select
                  aria-label="Billing"
                  value={billing}
                  onChange={(event) => {
                    setBilling(event.target.value as BillingChoice);
                    setPackageId("");
                    setMembershipId("");
                  }}
                  className={inputClass}
                >
                  {(Object.keys(BILLING_LABELS) as BillingChoice[]).map((key) => (
                    <option key={key} value={key}>{BILLING_LABELS[key]}</option>
                  ))}
                </select>
                {billing === "package_credit" ? (
                  <select aria-label="Package" value={packageId} onChange={(event) => setPackageId(event.target.value)} className={inputClass}>
                    <option value="">No package selected</option>
                    {(chooseOptions?.packages ?? []).map((pkg) => (
                      <option key={pkg.id} value={pkg.id}>{pkg.label}</option>
                    ))}
                  </select>
                ) : null}
                {billing === "membership" ? (
                  <select aria-label="Membership" required value={membershipId} onChange={(event) => setMembershipId(event.target.value)} className={inputClass}>
                    <option value="">Select a membership</option>
                    {(chooseOptions?.memberships ?? []).map((membership) => (
                      <option key={membership.id} value={membership.id}>{membership.label}</option>
                    ))}
                  </select>
                ) : null}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          <RosterSubmitButton
            label="Add to class"
            pendingLabel="Adding…"
            disabled={!selected || loadingOptions}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          />
          <a href={`/app/schedule/enroll-student?appointmentId=${appointmentId}`} className="text-xs font-medium text-slate-600 underline">
            Open the full enroll form
          </a>
        </div>
      </form>
    </details>
  );
}
