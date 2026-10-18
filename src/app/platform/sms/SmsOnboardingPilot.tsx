import { Fragment } from "react";
import type { PlatformOnboardingRow } from "@/lib/sms/onboarding/client";
import type { RunnerStatus } from "@/lib/sms/twilioIsv/store";
import { STATE_LABELS, type OnboardingDisplayState } from "@/lib/sms/onboarding/stateMachine";
import { runSmsOnboardingAction, setSmsOnboardingAccessAction, setSmsRunnerWindowAction } from "./actions";
import SmsCampaignPackage from "./SmsCampaignPackage";
import SmsStepEvidence from "./SmsStepEvidence";

const RUNNABLE_STATES = new Set(["submitted_for_checks", "profile_review", "brand_pending"]);
const ATTENTION_STATES = new Set(["needs_info", "blocked", "exception", "suspended"]);

type StudioOption = { id: string; name: string | null; slug?: string | null; public_name?: string | null };

/** TW-4A: pilot switch for self-service SMS onboarding (default OFF for every studio) and a read-only status list. */
export default function SmsOnboardingPilot({
  studios,
  rows,
  unavailable,
  notice,
  error,
  runnerNotice = null,
  runnerError = null,
  evidence = {},
  origin = "https://www.idanceflow.com",
}: {
  studios: StudioOption[];
  rows: PlatformOnboardingRow[];
  unavailable: boolean;
  notice: boolean;
  error: string | null;
  runnerNotice?: string | null;
  runnerError?: string | null;
  /** Read-only run evidence per studio id (ledger, verdicts, confirmations); absent when nothing has run or it could not be loaded. */
  evidence?: Record<string, RunnerStatus>;
  /** Public origin used to build the studio links in the campaign package. */
  origin?: string;
}) {
  return (
    <section id="onboarding-pilot" className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Self-service onboarding (TW-4A)</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Pilot access</h2>
      <p className="mt-1 text-sm text-slate-600">
        Studios cannot see the Texting setup page until you switch it on for them. Nothing here contacts Twilio.
      </p>
      {notice ? <p role="status" className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">Saved.</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">{error}</p> : null}
      {runnerNotice ? <p role="status" className="mt-3 rounded-xl bg-sky-50 px-3 py-2 text-sm font-medium text-sky-900">{runnerNotice}</p> : null}
      {runnerError ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">{runnerError}</p> : null}
      {unavailable ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">The onboarding tables are not available in this environment yet.</p>
      ) : (
        <>
          <form action={setSmsOnboardingAccessAction} className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <label className="text-sm font-medium text-slate-800">
              Studio
              <select name="studioId" required className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="">Choose…</option>
                {studios.map((studio) => (
                  <option key={studio.id} value={studio.id}>{studio.name ?? studio.id}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Reason
              <input name="reason" required minLength={3} maxLength={500} placeholder="e.g. ConfiDance pilot" className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" />
            </label>
            <label className="flex items-center gap-2 pb-2 text-sm text-slate-800">
              <input type="checkbox" name="enabled" defaultChecked /> Enabled
            </label>
            <button type="submit" className="rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800">Save</button>
          </form>
          <form action={setSmsRunnerWindowAction} className="mt-5 grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-[1fr_6rem_1fr_auto] sm:items-end" aria-label="Runner window">
            <label className="text-sm font-medium text-slate-800">
              Runner window for
              <select name="studioId" required className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
                <option value="">Choose…</option>
                {studios.map((studio) => (
                  <option key={studio.id} value={studio.id}>{studio.name ?? studio.id}</option>
                ))}
              </select>
            </label>
            <label className="text-sm font-medium text-slate-800">
              Hours
              <input name="hours" type="number" min={0} max={72} defaultValue={24} required className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" />
            </label>
            <label className="text-sm font-medium text-slate-800">
              Reason
              <input name="reason" required minLength={3} maxLength={300} placeholder="e.g. ConfiDance brand submission" className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" />
            </label>
            <button type="submit" className="rounded-xl border border-violet-300 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50">Set window</button>
            <p className="text-xs text-slate-500 sm:col-span-4">Running the brand steps does nothing outside an open window (0 hours closes it). Checking brand status needs no window.</p>
          </form>
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="py-2 pr-4">Studio</th>
                  <th className="py-2 pr-4">Access</th>
                  <th className="py-2 pr-4">Setup state</th>
                  <th className="py-2 pr-4">Submitted</th>
                  <th className="py-2 pr-4">EIN on file</th>
                  <th className="py-2 pr-4">Registration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.length === 0 ? (
                  <tr><td colSpan={6} className="py-3 text-slate-500">No studio has pilot access yet.</td></tr>
                ) : (
                  rows.map((row) => (
                    <Fragment key={row.studioId}>
                    <tr>
                      <td className="py-2 pr-4 font-medium text-slate-900">{row.studioName}</td>
                      <td className="py-2 pr-4">{row.accessEnabled ? "On" : row.state ? "Off (setup paused)" : "Off"}</td>
                      <td className="py-2 pr-4">
                        {STATE_LABELS[(row.state ?? "not_started") as OnboardingDisplayState] ?? row.state}
                        {row.state && ATTENTION_STATES.has(row.state) ? <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">Needs attention</span> : null}
                      </td>
                      <td className="py-2 pr-4">{row.submittedAt ? new Date(row.submittedAt).toLocaleDateString() : "—"}</td>
                      <td className="py-2 pr-4">{row.einStored ? "Yes" : "No"}</td>
                      <td className="py-2 pr-4">
                        {row.accessEnabled && row.state && RUNNABLE_STATES.has(row.state) ? (
                          <form action={runSmsOnboardingAction} className="flex flex-wrap items-center gap-2">
                            <input type="hidden" name="studioId" value={row.studioId} />
                            {row.state === "brand_pending" ? (
                              <>
                                <input type="hidden" name="intent" value="refresh" />
                                <button type="submit" className="rounded-lg border border-violet-300 px-3 py-1 text-xs font-semibold text-violet-800 hover:bg-violet-50">Check brand status</button>
                              </>
                            ) : (
                              <>
                                <label className="flex items-center gap-1 text-xs text-slate-700">
                                  <input type="checkbox" name="confirmFee" /> I confirm the Twilio brand fee
                                </label>
                                <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-rose-200 bg-rose-50 px-2 py-1">
                                  <legend className="px-1 text-[11px] font-semibold uppercase tracking-wide text-rose-800">Irreversible submissions (each run)</legend>
                                  <label className="flex items-center gap-1 text-xs text-slate-800">
                                    <input type="checkbox" name="confirmSubmitProfile" /> Submit the business profile for Twilio review
                                  </label>
                                  <label className="flex items-center gap-1 text-xs text-slate-800">
                                    <input type="checkbox" name="confirmSubmitTrustProduct" /> Submit the A2P trust product
                                  </label>
                                  <label className="flex items-center gap-1 text-xs text-slate-800">
                                    Type SUBMIT
                                    <input name="submitPhrase" autoComplete="off" aria-label="Type SUBMIT to confirm the submissions ticked" className="w-24 rounded border border-slate-300 px-1 py-0.5 text-xs" />
                                  </label>
                                </fieldset>
                                <button type="submit" className="rounded-lg bg-violet-700 px-3 py-1 text-xs font-semibold text-white hover:bg-violet-800">Run next steps</button>
                              </>
                            )}
                          </form>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                    {evidence[row.studioId] || row.accessEnabled ? (
                      <tr>
                        <td colSpan={6} className="space-y-2 pb-3">
                          {evidence[row.studioId] ? <SmsStepEvidence status={evidence[row.studioId]!} /> : null}
                          {row.accessEnabled ? (
                            <SmsCampaignPackage studioName={studios.find((studio) => studio.id === row.studioId)?.name ?? row.studioName} publicName={studios.find((studio) => studio.id === row.studioId)?.public_name ?? null} slug={studios.find((studio) => studio.id === row.studioId)?.slug ?? null} origin={origin} />
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                    </Fragment>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
