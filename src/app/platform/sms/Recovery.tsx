import type { DeferredRetirement, RecoveryOverview, RegistrationGap } from "@/lib/sms/provisioning/recoveryStore";
import ExposureConsolidated from "./ExposureConsolidated";
import NumberLedger from "./NumberLedger";
import { retireDeferredAction, retryRegistrationAction } from "./recoveryActions";

/**
 * TW-4F F4: platform-administrator recovery panel: DanceFlow-borne provider exposure, provider-confirmed resources missing from the recurring-fee inventory
 * (with the audited retry), number cancellations whose ledger retirement was deferred (with the guarded retry) and the per-studio number ledgers.
 * Platform-admin only; nothing here is shown to a studio, charges anything, releases a held fee or asks an owner to authorize or pay.
 */

const input = "mt-1 w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-xs";
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "—");
const name = (names: Record<string, string>, id: string) => names[id] ?? id;

function Unavailable({ what }: { what: string }) {
  return (
    <p role="alert" className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="recovery-unavailable">
      {what} could not be read. Do not assume there is nothing to recover.
    </p>
  );
}

function GapRow({ gap, names }: { gap: RegistrationGap; names: Record<string, string> }) {
  return (
    <li className="rounded-lg border border-slate-200 p-2 text-xs" data-testid="gap-row" data-kind={gap.kind}>
      <p className="font-semibold text-slate-900">{name(names, gap.studioId)}: {gap.kind === "number" ? `phone number ${gap.e164 ?? ""}` : "campaign"}</p>
      <p className="break-all text-slate-600">{gap.providerSid ?? "?"}, confirmed by the provider {when(gap.observedAt)}{gap.lastFailureAt ? `; registration failed ${when(gap.lastFailureAt)}` : ""}</p>
      {gap.lastRetry ? (
        <p className="text-slate-600" data-testid="gap-last-retry">Last retry {when(gap.lastRetry.at)}: {gap.lastRetry.outcome ?? "?"}{gap.lastRetry.code ? ` (${gap.lastRetry.code})` : ""}, by administrator {gap.lastRetry.by ?? "?"}</p>
      ) : null}
      <form action={retryRegistrationAction} className="mt-2 grid gap-1">
        <input type="hidden" name="studioId" value={gap.studioId} />
        <input type="hidden" name="kind" value={gap.kind} />
        <label className="font-medium text-slate-800">What you checked (10-300 characters, recorded with your name)
          <input name="note" required minLength={10} maxLength={300} className={input} />
        </label>
        <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> I checked the inventory; register it from the ledger&apos;s own provider-confirmed facts</label>
        <button type="submit" className="w-fit rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800">Retry registration</button>
      </form>
    </li>
  );
}

function DeferredRow({ item, names }: { item: DeferredRetirement; names: Record<string, string> }) {
  const reasons = [
    item.blockers.leaseHeld ? "a run holds the studio" : null,
    item.blockers.operationUnresolved ? "a number operation is unresolved" : null,
    item.blockers.senderReleaseRequired ? `the sender row for this number must be released first (now ${item.senderStatus ?? "?"})` : null,
  ].filter(Boolean);
  return (
    <li className="rounded-lg border border-slate-200 p-2 text-xs" data-testid="deferred-row" data-ready={item.ready ? "1" : "0"}>
      <p className="font-semibold text-slate-900">{name(names, item.studioId)}: {item.e164 ?? item.phoneNumberSid}</p>
      <p className="break-all text-slate-600">{item.phoneNumberSid}, cancelled in the recurring-fee lifecycle {when(item.cancelledAt)}; the number ledger still holds {item.operations} live operation{item.operations === 1 ? "" : "s"}. Rent stays held until it is retired.</p>
      {reasons.length ? <p className="text-amber-900" data-testid="deferred-blockers">Blocked: {reasons.join("; ")}.</p> : null}
      {item.ready ? (
        <form action={retireDeferredAction} className="mt-2 grid gap-1">
          <input type="hidden" name="studioId" value={item.studioId} />
          <input type="hidden" name="phoneNumberSid" value={item.phoneNumberSid} />
          <label className="font-medium text-slate-800">Why it can be retired now (10-300 characters, recorded with your name)
            <input name="note" required minLength={10} maxLength={300} className={input} />
          </label>
          <label className="flex items-center gap-2 text-slate-800"><input type="checkbox" name="confirm" required /> The number is cancelled at the provider and its sender row is released</label>
          <button type="submit" className="w-fit rounded-lg bg-violet-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-800">Retire from the number ledger</button>
        </form>
      ) : null}
    </li>
  );
}

export default function Recovery({ overview, studioNames, notice, error }: { overview: RecoveryOverview; studioNames: Record<string, string>; notice: string | null; error: string | null }) {
  const ledgers = Object.entries(overview.numberLedgers);
  return (
    <section id="sms-recovery" className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm" data-testid="sms-recovery">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform administrators only</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Provider exposure and recovery</h2>
      {notice ? <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">{error}</p> : null}

      <h3 className="mt-4 text-sm font-semibold text-slate-900">DanceFlow-borne provider exposure</h3>
      <div className="mt-2"><ExposureConsolidated exposure={overview.exposure} /></div>

      <h3 className="mt-5 text-sm font-semibold text-slate-900">Not in the recurring-fee inventory</h3>
      <p className="mt-1 text-xs text-slate-600">Provider-confirmed numbers and campaigns whose registration failed. Their provider cost is exposed and the location stays unready until they are registered.</p>
      <div className="mt-2">
        {overview.gaps === "unavailable" ? <Unavailable what="The registration gaps" /> : overview.gaps.length === 0 ? <p className="text-xs text-slate-600">None.</p> : (
          <ul className="grid gap-2">{overview.gaps.map((g) => <GapRow key={`${g.kind}:${g.operationId}`} gap={g} names={studioNames} />)}</ul>
        )}
      </div>

      <h3 className="mt-5 text-sm font-semibold text-slate-900">Deferred number retirements</h3>
      <p className="mt-1 text-xs text-slate-600">Numbers the lifecycle shows cancelled (with evidence) while the number ledger still holds them, because a run was busy at the time.</p>
      <div className="mt-2">
        {overview.deferred === "unavailable" ? <Unavailable what="The deferred retirements" /> : overview.deferred.length === 0 ? <p className="text-xs text-slate-600">None.</p> : (
          <ul className="grid gap-2">{overview.deferred.map((d) => <DeferredRow key={`${d.studioId}:${d.phoneNumberSid}`} item={d} names={studioNames} />)}</ul>
        )}
      </div>

      {ledgers.length ? (
        <>
          <h3 className="mt-5 text-sm font-semibold text-slate-900">Number ledgers</h3>
          <div className="mt-2 grid gap-2">
            {ledgers.map(([studioId, ledger]) => <NumberLedger key={studioId} studioId={studioId} studioName={name(studioNames, studioId)} ledger={ledger} />)}
          </div>
        </>
      ) : null}
    </section>
  );
}
