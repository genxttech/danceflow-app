"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { enrollClassAttendeeAction } from "@/app/app/schedule/actions";
import {
  applySeriesRosterAction,
  previewSeriesRosterAction,
  type SeriesRosterRequest,
} from "@/app/app/schedule/groupClassSeriesRosterActions";
import {
  interpretSeriesApply,
  seriesAddPanelState,
  seriesRosterApplyLabel,
  seriesRosterExpectedCount,
  type SeriesRosterResult,
} from "@/lib/schedule/groupClassSeriesRoster";
import {
  getRosterFundingOptionsAction,
  searchRosterClientsAction,
  type RosterClientResult,
  type RosterFundingOptions,
} from "@/app/app/schedule/groupClassRosterActions";
import RosterSubmitButton from "./RosterSubmitButton";
import SeriesRosterPreview from "./SeriesRosterPreview";

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
 * Enrollment only: attendance and payment are separate workflows.
 *
 * GC-S1D-2: broad staff on a series class also choose a scope after picking the dancer and funding: "This class" (the
 * default, the unchanged path above) or "This and following classes", which shows a compact database-computed preview and
 * only then enrolls (atomically: if any class can't take the dancer, nobody is enrolled). The assigned instructor never
 * sees the scope choice; the database enforces that as well.
 */
export default function AddDancerPanel({
  appointmentId,
  returnTo,
  isBroadStaff,
  full,
  seriesScope = false,
  timeZone = "America/New_York",
  defaultOpen = false,
}: {
  appointmentId: string;
  returnTo: string;
  isBroadStaff: boolean;
  full: boolean;
  /** Broad staff on a series occurrence: offer "This and following classes". */
  seriesScope?: boolean;
  timeZone?: string;
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
  const [scope, setScope] = useState<"single" | "series">("single");
  const [busy, setBusy] = useState<"review" | "apply" | null>(null);
  const [preview, setPreview] = useState<{ key: string; result: SeriesRosterResult } | null>(null);
  const [seriesError, setSeriesError] = useState("");
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A preview is only valid for the exact dancer, funding and scope it was computed for.
  const effectiveScope = seriesScope ? scope : "single";
  const previewKey = [
    selected?.id ?? "",
    billing,
    billing === "package_credit" ? packageId : "",
    billing === "membership" ? membershipId : "",
    effectiveScope,
  ].join("|");
  const currentPreview = preview && preview.key === previewKey ? preview.result : null;
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
    // A dancer already in this class can still be added to the following classes (series scope only).
    if (client.alreadyEnrolled && !seriesScope) return;
    setSelected(client);
    setScope(client.alreadyEnrolled ? "series" : "single");
    setSeriesError("");
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
    setSeriesError("");
    setScope("single");
  }

  function seriesRequest(): SeriesRosterRequest | null {
    if (!selected) return null;
    return {
      kind: "enroll",
      appointmentId,
      clientId: selected.id,
      billingType: billing,
      clientPackageId: billing === "package_credit" && packageId ? packageId : null,
      clientMembershipId: billing === "membership" && membershipId ? membershipId : null,
    };
  }

  async function reviewSeries() {
    const request = seriesRequest();
    if (!request) {
      setLocalError("Choose a dancer first.");
      return;
    }
    if (billing === "membership" && !membershipId) {
      setLocalError("Select a specific membership before billing this enrollment to Membership.");
      return;
    }
    setLocalError("");
    setSeriesError("");
    setBusy("review");
    try {
      const outcome = await previewSeriesRosterAction(request);
      if (outcome.status === "ok") setPreview({ key: previewKey, result: outcome.result });
      else setSeriesError(outcome.message);
    } catch {
      setSeriesError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function applySeries() {
    const request = seriesRequest();
    if (!request || !currentPreview || currentPreview.outcome !== "ready") return;
    setSeriesError("");
    setBusy("apply");
    try {
      const outcome = await applySeriesRosterAction(request, seriesRosterExpectedCount(currentPreview, "enroll"));
      const step = interpretSeriesApply(outcome, "enroll", returnTo);
      if (step.type === "error") {
        setSeriesError(step.message);
      } else if (step.type === "done") {
        clearSelection();
        setPreview(null);
        router.push(step.url);
      } else {
        // Changed, blocked or nothing to do: nothing was enrolled; show the fresh state instead of guessing.
        setPreview({ key: previewKey, result: step.result });
      }
    } catch {
      setSeriesError("Something went wrong. Nothing was changed. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  function validateBeforeSubmit(event: React.FormEvent<HTMLFormElement>) {
    if (effectiveScope === "series") {
      // Series scope never posts the single-class form: Enter or a stray submit goes to the review step.
      event.preventDefault();
      void reviewSeries();
      return;
    }
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

  const addState = seriesAddPanelState({ full, seriesScope, isBroadStaff });
  if (!addState.showAddControl) {
    return (
      <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{addState.fullNotice}</p>
    );
  }

  const chooseOptions = options && options.mode === "choose" ? options : null;
  const eligible = chooseOptions?.eligible ?? [];
  const showFundingBlock = isBroadStaff && selected && !loadingOptions && chooseOptions;

  return (
    <div className="space-y-3">
      {addState.fullNotice ? (
        <p role="note" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">{addState.fullNotice}</p>
      ) : null}
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
                        disabled={client.alreadyEnrolled && !seriesScope}
                        className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        <span>{client.name}</span>
                        {client.alreadyEnrolled ? (
                          <span className="text-xs">{seriesScope ? "In this class · add to following" : "Already enrolled"}</span>
                        ) : null}
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

        {seriesScope && selected && !loadingOptions ? (
          <fieldset className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 text-sm">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Which classes?</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="rosterScope"
                value="single"
                checked={scope === "single"}
                disabled={selected.alreadyEnrolled}
                onChange={() => setScope("single")}
              />
              <span className={selected.alreadyEnrolled ? "text-slate-400" : "text-slate-800"}>This class</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="rosterScope" value="series" checked={scope === "series"} onChange={() => setScope("series")} />
              <span className="text-slate-800">This and following classes</span>
            </label>
            {scope === "single" && addState.singleNote ? (
              <p role="alert" className="pt-1 text-xs font-medium text-amber-800">{addState.singleNote}</p>
            ) : null}
            {scope === "series" ? (
              <p className="pt-1 text-xs text-slate-600">
                {selected.alreadyEnrolled ? `${selected.name} is already in this class. ` : ""}
                The same funding is used for every class. Cancelled and ended classes are skipped. If any class can&apos;t take{" "}
                {selected.name}, nobody is enrolled.
              </p>
            ) : null}
          </fieldset>
        ) : null}

        {effectiveScope === "series" && currentPreview && selected ? (
          <SeriesRosterPreview result={currentPreview} kind="enroll" name={selected.name} timeZone={timeZone} />
        ) : null}

        {seriesError ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{seriesError}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-3">
          {effectiveScope === "series" ? (
            <>
              <button
                type="button"
                onClick={() => void reviewSeries()}
                disabled={!selected || loadingOptions || busy !== null}
                aria-busy={busy === "review"}
                className={
                  currentPreview?.outcome === "ready"
                    ? "rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    : "rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                }
              >
                {busy === "review" ? "Checking classes…" : currentPreview ? "Review again" : "Review classes"}
              </button>
              {currentPreview?.outcome === "ready" ? (
                <button
                  type="button"
                  onClick={() => void applySeries()}
                  disabled={busy !== null}
                  aria-busy={busy === "apply"}
                  className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {busy === "apply" ? "Enrolling…" : seriesRosterApplyLabel("enroll", seriesRosterExpectedCount(currentPreview, "enroll"))}
                </button>
              ) : null}
            </>
          ) : (
            <RosterSubmitButton
              label="Add to class"
              pendingLabel="Adding…"
              disabled={!selected || loadingOptions || addState.singleDisabled}
              className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            />
          )}
          <a href={`/app/schedule/enroll-student?appointmentId=${appointmentId}`} className="text-xs font-medium text-slate-600 underline">
            Open the full enroll form
          </a>
        </div>
      </form>
    </details>
    </div>
  );
}
