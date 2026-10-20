import {
  LVS_CHECKLIST,
  STAGE_STATE_LABELS,
  formatCents,
  nameKey,
  CONFIDANCE_NAME_KEY,
  canConfirmSubaccount,
  type PanelAudit,
  type PanelOverview,
  type PanelRequest,
  type StageState,
  type StudioPanel,
} from "@/lib/sms/twilioIsv/panel";
import { CREATE_PHRASE } from "@/lib/sms/twilioIsv/panelCommands";
import type { PanelMonthlyLimits } from "@/lib/billing/smsPanelMonthlyLimits";
import { ChevronDown } from "lucide-react";
import PanelMonthlyLimit from "./PanelMonthlyLimit";
import SenderIdentity from "./SenderIdentity";
import type { SenderOverviewRow } from "@/lib/sms/senderVerification";
import {
  panelAuthorizeFeeAction,
  panelCreateEntityAction,
  panelCreatePilotExceptionAction,
  panelCreateSubaccountAction,
  panelDecideLinkAction,
  panelDecideTierAction,
  panelSetSpendCapAction,
  panelWithdrawFeeAction,
} from "./panelActions";

/**
 * TW-4F supervised-pilot panel: legal businesses, location links, setup budget and owner fee approvals, the Twilio subaccount and the
 * registration path, per studio. One clear next action per studio; details on demand. Nothing on this panel submits a registration or sends SMS.
 */

const STATE_CLASS: Record<StageState, string> = {
  not_started: "border-slate-200 bg-slate-50 text-slate-600",
  configured: "border-sky-200 bg-sky-50 text-sky-800",
  approved: "border-violet-200 bg-violet-50 text-violet-800",
  submitted: "border-amber-200 bg-amber-50 text-amber-900",
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  attention: "border-rose-200 bg-rose-50 text-rose-800",
};

const input = "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm";
const primary = "rounded-xl bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-800";
const secondary = "rounded-xl border border-violet-300 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50";
const FEE_LABELS: Record<string, string> = { brand: "Brand registration", brand_low_volume: "Brand registration (Low-Volume Standard)", campaign_vetting: "Campaign vetting", number: "Phone number" };
const AUDIT_LABELS: Record<string, string> = {
  entity_created: "Legal business created", location_attested: "Owner attested a location", location_decided: "Location decision", spend_cap_set: "Setup budget set",
  spend_authorized: "Owner fee approval recorded", spend_reserved: "Fee reserved by a run", spend_withdrawn: "Fee approval withdrawn", subaccount_confirmed: "Subaccount creation confirmed",
  runner_subaccount: "Subaccount step", credit_pilot_exception: "Pilot exception recorded", credit_reserved: "Credit reserved", credit_captured: "Credit captured", credit_released: "Credit released",
};

function Pill({ state }: { state: StageState }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold ${STATE_CLASS[state]}`}>{STAGE_STATE_LABELS[state]}</span>;
}

/** Every disclosure on the panel shows a chevron that turns when it opens (named groups, so nested disclosures never turn each other's). */
const CHEVRON = {
  steps: "group-open/steps:rotate-180", section: "group-open/section:rotate-180", audit: "group-open/audit:rotate-180", blockers: "group-open/blockers:rotate-180",
  fee: "group-open/fee:rotate-180", lvs: "group-open/lvs:rotate-180",
} as const;
const SUMMARY = "flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden";
function Chevron({ group }: { group: keyof typeof CHEVRON }) {
  return <ChevronDown aria-hidden="true" className={`h-4 w-4 shrink-0 transition-transform ${CHEVRON[group]}`} />;
}

function Section({ title, state, open, children }: { title: string; state: StageState; open?: boolean; children: React.ReactNode }) {
  return (
    <details open={open} className="group/section rounded-xl border border-slate-200 p-3">
      <summary className={`${SUMMARY} justify-between text-sm font-semibold text-slate-900`}>
        <span className="flex items-center gap-1"><Chevron group="section" />{title}</span>
        <Pill state={state} />
      </summary>
      <div className="mt-3 space-y-3 text-sm text-slate-700">{children}</div>
    </details>
  );
}

export default function SmsSubaccountPanel({
  overview,
  panels,
  unavailable,
  notice,
  error,
  focusStudioId = null,
  now,
  requestKeys = {},
  monthlyLimits = null,
  senders = null,
}: {
  overview: PanelOverview | null;
  panels: StudioPanel[];
  unavailable: boolean;
  notice: string | null;
  error: string | null;
  /** The studio the last action was about: its card opens; every other card shows only its progress and next action. */
  focusStudioId?: string | null;
  /** Render clock and one-time Create-subaccount keys per studio (from panelRenderContext, produced once by the page). */
  now: number;
  requestKeys?: Record<string, string>;
  /** Monthly spending limits by legal business (read-only); null when they cannot be read in this environment. */
  monthlyLimits?: PanelMonthlyLimits | null;
  /** Sender readiness per linked studio (tw4_sender_overview); null when it cannot be read in this environment. */
  senders?: SenderOverviewRow[] | null;
}) {
  const pending = (overview?.requests ?? []).filter((r) => r.status === "pending");
  return (
    <section id="subaccount-panel" className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Supervised pilot (TW-4F)</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Subaccount onboarding</h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">
        One studio legal business, one Twilio subaccount. <strong>Configured</strong> = recorded here; <strong>Approved</strong> = a person approved it;{" "}
        <strong>Submitted</strong> = sent to Twilio and waiting; <strong>Active</strong> = in force. Nothing on this panel submits a registration or sends a text.
      </p>
      {notice ? <p role="status" className="mt-3 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-800">{error}</p> : null}
      {unavailable ? (
        <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">The subaccount onboarding data is not available in this environment yet.</p>
      ) : (
        <>
          {pending.length > 0 ? <LocationRequests requests={pending} overview={overview!} /> : null}
          <div className="mt-4 space-y-4">
            {panels.length === 0 ? <p className="text-sm text-slate-500">No studio has submitted a texting setup yet.</p> : null}
            {panels.map((panel) => <StudioCard key={panel.studioId} panel={panel} overview={overview!} expanded={panels.length === 1 || panel.studioId === focusStudioId} now={now} requestKey={requestKeys[panel.studioId] ?? ""} monthlyLimits={monthlyLimits} senders={senders} />)}
          </div>
        </>
      )}
    </section>
  );
}

function LocationRequests({ requests, overview }: { requests: PanelRequest[]; overview: PanelOverview }) {
  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3" data-testid="location-requests">
      <h3 className="text-sm font-semibold text-amber-950">Location requests waiting for you ({requests.length})</h3>
      <p className="mt-1 text-xs text-amber-900">
        An owner attested that a location belongs to their legal business. Approve only after verifying it yourself (registry, formation or franchise documents). The matching name and EIN last four are supporting checks, never proof.
      </p>
      <ul className="mt-3 space-y-3">
        {requests.map((r) => {
          const candidate = overview.entities.find((e) => e.id === r.candidateEntityId) ?? null;
          return (
            <li key={r.id} className="rounded-xl border border-amber-200 bg-white p-3 text-sm">
              <p className="font-semibold text-slate-900">{r.studioName}</p>
              <p className="text-slate-700">Claims: {r.claimedLegalName} (EIN …{r.claimedEinLast4}), attested {new Date(r.attestedAt).toLocaleDateString()}</p>
              <p className="text-xs text-slate-600">{candidate ? `Name and EIN last four match ${candidate.legalName}.` : "No legal business on file matches this name and EIN last four: it cannot be approved."}</p>
              <form action={panelDecideLinkAction} className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
                <input type="hidden" name="requestId" value={r.id} />
                <input type="hidden" name="entityId" value={candidate?.id ?? ""} />
                <label className="text-xs font-medium text-slate-800">
                  What you verified (approve) or why not (reject)
                  <input name="note" required minLength={3} maxLength={300} className={input} />
                </label>
                <label className="flex items-center gap-2 pb-2 text-xs text-slate-800"><input type="checkbox" name="verified" /> I verified it</label>
                <div className="flex gap-2">
                  <button type="submit" name="decision" value="approve" disabled={!candidate} className={`${primary} disabled:opacity-40`}>Approve link</button>
                  <button type="submit" name="decision" value="reject" className={secondary}>Reject</button>
                </div>
              </form>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StudioCard({ panel, overview, expanded, now, requestKey, monthlyLimits, senders }: { senders: SenderOverviewRow[] | null; panel: StudioPanel; overview: PanelOverview; expanded: boolean; now: number; requestKey: string; monthlyLimits: PanelMonthlyLimits | null }) {
  const stage = (key: StudioPanel["stages"][number]["key"]) => panel.stages.find((s) => s.key === key)!;
  const entity = panel.entity;
  const audit: PanelAudit[] = overview.audit.filter((a) => a.studioId === panel.studioId || (entity && entity.studios.some((s) => s.studioId === a.studioId))).slice(0, 15);
  // the open section is the one the next action belongs to
  const focus = !entity ? "entity" : entity.spendCapCents === 0 ? "budget" : entity.account?.status !== "active" ? "subaccount" : "budget";
  return (
    <article className="rounded-2xl border border-slate-200 p-4" data-testid="studio-panel" data-studio={panel.studioName}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-950">{panel.studioName}</h3>
          {panel.pilot ? <p className="text-xs font-semibold text-fuchsia-800">ConfiDance pilot: $150 non-spendable ceiling, separate owner approval before every fee.</p> : null}
        </div>
        <ol className="flex flex-wrap gap-1.5" aria-label="Progress">
          {panel.stages.map((s) => (
            <li key={s.key} className="flex items-center gap-1 text-xs text-slate-600">{s.title}: <Pill state={s.state} /></li>
          ))}
        </ol>
      </div>
      <p className="mt-3 rounded-xl bg-violet-50 px-3 py-2 text-sm text-violet-950" data-testid="next-action"><strong>Next:</strong> {panel.nextAction}</p>
      {panel.blockers.length > 1 ? (
        <details className="group/blockers mt-2 text-xs text-slate-600">
          <summary className={SUMMARY}><Chevron group="blockers" />All blocking conditions ({panel.blockers.length})</summary>
          <ul className="mt-1 list-disc pl-5">{panel.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </details>
      ) : null}

      <details open={expanded} className="group/steps mt-3" data-testid="studio-steps">
      <summary className={`${SUMMARY} text-sm font-semibold text-violet-800`}><Chevron group="steps" />Steps, approvals and evidence</summary>
      <div className="mt-3 space-y-2">
        <Section title="Legal business" state={stage("entity").state} open={focus === "entity"}>
          <p>{stage("entity").summary}</p>
          {entity ? (
            <ul className="text-xs text-slate-600">
              {entity.studios.map((s) => <li key={s.studioId}>{s.name}: {s.linkKind} location, verified: {s.verificationNote}</li>)}
            </ul>
          ) : panel.onboarding && panel.onboarding.state !== "draft" && panel.onboarding.legalName ? (
            <form action={panelCreateEntityAction} className="grid gap-2">
              <input type="hidden" name="studioId" value={panel.studioId} />
              <p className="text-xs text-slate-600">From the owner&apos;s submitted setup: {panel.onboarding.legalName}, EIN …{panel.onboarding.einLast4}.</p>
              <label className="text-xs font-medium text-slate-800">
                What you verified (official record; never the EIN)
                <input name="verificationNote" required minLength={10} maxLength={300} placeholder="e.g. Oregon SOS registry entry checked 2026-10-20" className={input} />
              </label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="verified" /> I verified this legal business against an official record</label>
              <button type="submit" className={`${primary} w-fit`}>Create legal business</button>
            </form>
          ) : null}
        </Section>

        <Section title="Setup budget and fee approvals" state={stage("budget").state} open={focus === "budget"}>
          <p>{stage("budget").summary}</p>
          {entity ? <PanelMonthlyLimit limit={monthlyLimits?.[entity.id] ?? null} /> : null}
          {entity ? <BudgetForms panel={panel} overview={overview} /> : null}
        </Section>
        {entity && senders ? <SenderIdentity studioId={panel.studioId} row={senders.find((r) => r.studioId === panel.studioId) ?? null} /> : null}


        <Section title="Twilio subaccount" state={stage("subaccount").state} open={focus === "subaccount"}>
          <p>{stage("subaccount").summary}</p>
          {entity && requestKey && canConfirmSubaccount(entity, now) ? (
            <form action={panelCreateSubaccountAction} className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <input type="hidden" name="studioId" value={panel.studioId} />
              <input type="hidden" name="requestKey" value={requestKey} />
              <label className="text-xs font-medium text-slate-800">
                Type {CREATE_PHRASE} to create {entity.legalName}&apos;s subaccount (no fee; no registration is submitted)
                <input name="phrase" required autoComplete="off" className={input} />
              </label>
              <button type="submit" className={primary}>Create subaccount</button>
            </form>
          ) : null}
        </Section>

        <Section title="Registration path" state={stage("tier").state}>
          <p>{stage("tier").summary}</p>
          {panel.onboarding && panel.onboarding.b1Status === null ? <TierForm panel={panel} /> : null}
          {panel.onboarding?.tierDecisions.length ? (
            <ul className="text-xs text-slate-600">
              {panel.onboarding.tierDecisions.map((d) => (
                <li key={d.decidedAt + d.tier}>{new Date(d.decidedAt).toLocaleString()}: {d.tier.replaceAll("_", " ")} ({d.reason}){d.eligibility ? " with eligibility checklist" : ""}</li>
              ))}
            </ul>
          ) : null}
        </Section>

        <Section title="Twilio registration" state={stage("registration").state}>
          <p>{stage("registration").summary}</p>
          <p className="text-xs text-slate-500">Run, confirm and check the registration steps in the registration runner below (open a runner window first). Step-by-step evidence appears there.</p>
        </Section>

        <details className="group/audit rounded-xl border border-slate-200 p-3">
          <summary className={`${SUMMARY} text-sm font-semibold text-slate-900`}><Chevron group="audit" />Audit evidence ({audit.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-600" data-testid="panel-audit">
            {audit.length === 0 ? <li>No events yet.</li> : audit.map((a, i) => (
              <li key={`${a.at}-${i}`}>{new Date(a.at).toLocaleString()}: {AUDIT_LABELS[a.action] ?? a.action} ({a.actorType}){a.note ? `: ${a.note}` : ""}</li>
            ))}
          </ul>
        </details>
      </div>
      </details>
    </article>
  );
}

function BudgetForms({ panel, overview }: { panel: StudioPanel; overview: PanelOverview }) {
  const entity = panel.entity!;
  const isConfiDance = nameKey(entity.legalName) === CONFIDANCE_NAME_KEY;
  const open = entity.spend.filter((s) => s.status === "authorized" || s.status === "reserved");
  const pilotRemaining = entity.pilot ? entity.pilot.ceilingCents - entity.pilot.usedCents - entity.pilot.authorizedCents : 0;
  return (
    <div className="space-y-3">
      <form action={panelSetSpendCapAction} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <input type="hidden" name="entityId" value={entity.id} />
        <input type="hidden" name="studioId" value={panel.studioId} />
        <label className="text-xs font-medium text-slate-800">Cumulative setup budget ($){isConfiDance ? " (max 150 for the pilot)" : ""}
          <input name="capDollars" inputMode="decimal" required defaultValue={(entity.spendCapCents / 100).toFixed(2)} className={input} />
        </label>
        <label className="text-xs font-medium text-slate-800">Type the amount again
          <input name="confirmCap" inputMode="decimal" required autoComplete="off" className={input} />
        </label>
        <button type="submit" className={secondary}>Set budget</button>
      </form>

      {isConfiDance && !entity.pilot ? (
        <form action={panelCreatePilotExceptionAction} className="grid gap-2 rounded-xl border border-fuchsia-200 p-3">
          <input type="hidden" name="entityId" value={entity.id} />
          <input type="hidden" name="studioId" value={panel.studioId} />
          <p className="text-xs font-semibold text-fuchsia-900">ConfiDance pilot ceiling (one time, founder-authorized)</p>
          <label className="text-xs font-medium text-slate-800">Ceiling ($, at most 150)<input name="ceilingDollars" defaultValue="150.00" className={input} /></label>
          <label className="text-xs font-medium text-slate-800">Founder&apos;s written authorization<input name="approvalRef" required minLength={10} maxLength={200} className={input} /></label>
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" name="understood" /> Non-spendable, cumulative, never resets; each fee still needs its own owner approval</label>
          <button type="submit" className={`${secondary} w-fit`}>Record pilot ceiling</button>
        </form>
      ) : null}
      {entity.pilot ? (
        <p className="text-xs text-fuchsia-900">Pilot ceiling: {formatCents(entity.pilot.usedCents)} used, {formatCents(entity.pilot.authorizedCents)} approved but not yet reserved, {formatCents(Math.max(0, pilotRemaining))} left of {formatCents(entity.pilot.ceilingCents)}. SMS usage never draws on it.</p>
      ) : null}

      {open.length > 0 ? (
        <ul className="space-y-1 text-xs" data-testid="fee-approvals">
          {open.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <Pill state={s.status === "reserved" ? "submitted" : "approved"} />
              <span>{FEE_LABELS[s.kind] ?? s.kind} {formatCents(s.amountCents)} ({s.funding === "pilot" ? "pilot ceiling" : "prepaid credit"}): {s.approvalRef}</span>
              {s.status === "authorized" ? (
                <form action={panelWithdrawFeeAction} className="flex items-center gap-1">
                  <input type="hidden" name="spendEventId" value={s.id} />
                  <input type="hidden" name="studioId" value={panel.studioId} />
                  <input name="note" required minLength={3} maxLength={300} placeholder="reason" className="rounded-lg border border-slate-300 px-2 py-1" />
                  <button type="submit" className="text-rose-700 underline">Withdraw</button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <details className="group/fee rounded-xl border border-slate-200 p-3">
        <summary className={`${SUMMARY} text-xs font-semibold text-slate-900`}><Chevron group="fee" />Record an owner fee approval</summary>
        <p className="mt-2 text-xs text-slate-600">One approval authorizes exactly one operation at the published price. It is reserved only when that step runs.</p>
        <div className="mt-2 space-y-2">
          {(["brand", "campaign_vetting", "number"] as const).map((row) => {
            // the brand fee is priced for the location's registration path (the database refuses the other path's kind)
            const kind = row === "brand" && panel.tier === "low_volume_standard" ? "brand_low_volume" : row;
            const price = overview.prices[kind];
            const lvsBrand = kind === "brand_low_volume";
            return (
              <form key={kind} action={panelAuthorizeFeeAction} className="grid gap-2 rounded-lg border border-slate-100 p-2 sm:grid-cols-[1fr_1.4fr_auto_auto] sm:items-end">
                <input type="hidden" name="entityId" value={entity.id} />
                <input type="hidden" name="studioId" value={panel.studioId} />
                <input type="hidden" name="kind" value={kind} />
                <input type="hidden" name="amountCents" value={price ?? ""} />
                <div className="text-xs">
                  <p className="font-semibold text-slate-900">{FEE_LABELS[kind]}</p>
                  <p className="text-slate-600">{price ? formatCents(price) : lvsBrand ? "No Low-Volume Standard price published yet" : "No published price"}</p>
                  <select name="funding" defaultValue={entity.pilot ? "pilot" : "credit"} className="mt-1 rounded-lg border border-slate-300 px-2 py-1">
                    <option value="credit">Prepaid credit</option>
                    {entity.pilot ? <option value="pilot">Pilot ceiling</option> : null}
                  </select>
                </div>
                <label className="text-xs font-medium text-slate-800">Owner&apos;s written approval (who, when, where)
                  <input name="approvalRef" required minLength={10} maxLength={120} className={input} />
                </label>
                <label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" name="ownerApproved" /> Owner approved this operation and amount</label>
                <button type="submit" disabled={!price} className={`${secondary} disabled:opacity-40`}>Record approval</button>
              </form>
            );
          })}
        </div>
      </details>
    </div>
  );
}

function TierForm({ panel }: { panel: StudioPanel }) {
  return (
    <form action={panelDecideTierAction} className="grid gap-2 rounded-xl border border-slate-200 p-3">
      <input type="hidden" name="studioId" value={panel.studioId} />
      <fieldset className="flex flex-wrap gap-4 text-xs">
        <legend className="font-medium text-slate-800">Registration path</legend>
        <label className="flex items-center gap-1"><input type="radio" name="tier" value="standard" defaultChecked={panel.tier === "standard"} /> Standard (Mixed campaign, secondary vetting)</label>
        <label className="flex items-center gap-1"><input type="radio" name="tier" value="low_volume_standard" defaultChecked={panel.tier === "low_volume_standard"} /> Low-Volume Standard (Low Volume Mixed)</label>
      </fieldset>
      <details className="group/lvs text-xs">
        <summary className={`${SUMMARY} font-medium text-slate-800`}><Chevron group="lvs" />Low-Volume Standard eligibility checklist (all required)</summary>
        <div className="mt-2 space-y-1">
          {LVS_CHECKLIST.map((item) => (
            <label key={item.key} className="flex items-start gap-2"><input type="checkbox" name={`elig_${item.key}`} className="mt-0.5" /> {item.label}</label>
          ))}
        </div>
      </details>
      <label className="text-xs font-medium text-slate-800">Documented reason
        <input name="reason" required minLength={10} maxLength={300} className={input} />
      </label>
      <button type="submit" className={`${secondary} w-fit`}>Save registration path</button>
    </form>
  );
}
