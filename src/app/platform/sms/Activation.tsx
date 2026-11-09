import { activationDetailReason, activationItemLabel, ki1Blocking, type ActivationCheck, type ActivationOverview } from "@/lib/sms/activation";
import ActivationForms, { SuspendForm } from "./ActivationForms";

/**
 * TW-4F J4: platform-administrator SMS activation console (manual release, owner decision D8). For each location from "campaign_pending" onwards: its
 * state, EVERY checklist item the database reports (an unknown item is shown with a generic label and its raw detail, never hidden), the ledger's
 * identifiers (read-only) and the actions. Platform-admin only; nothing here is shown to a studio, and there is no override of any checklist item.
 */

export type ActivationStudio = { studioId: string; name: string; state: string | null };
type Reads = { compliance: { enabled: boolean; reason: string | null }; sender: { enabled: boolean; reason: string | null } };

export const KI1_BLOCKING_NOTE = "KI-1 (pilot ceiling double capture) must be re-decided by the owner before ConfiDance can be activated";

function Ki1Note() {
  return (
    <div role="alert" className="mt-2 rounded-lg border-2 border-rose-400 bg-rose-50 px-3 py-2 text-xs text-rose-950" data-testid="activation-ki1-blocking">
      <p className="font-semibold">BLOCKING: {KI1_BLOCKING_NOTE}.</p>
      <p className="mt-1">No flag, switch or admin action can lift this: only the owner&apos;s re-decision followed by a later migration can. Mark ready and activate stay refused until then; suspend stays available.</p>
    </div>
  );
}

function Ledger({ ledger }: { ledger: ActivationCheck["ledger"] }) {
  const rows: [string, string | null][] = [
    ["Subaccount", ledger.accountSid], ["Messaging Service", ledger.messagingServiceSid], ["Campaign", ledger.campaignSid],
    ["Phone number SID", ledger.phoneNumberSid], ["Phone number", ledger.e164], ["Sender row", ledger.senderId],
  ];
  return (
    <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs" data-testid="activation-ledger">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="break-all font-mono text-slate-800">{value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Checklist({ items }: { items: ActivationCheck["items"] }) {
  if (items.length === 0) return <p role="alert" className="mt-2 text-xs text-rose-900">The database reported no checklist items. Do not treat this location as ready.</p>;
  return (
    <ul className="mt-2 grid gap-1 text-xs" data-testid="activation-checklist">
      {items.map((item, index) => (
        <li key={`${item.id}:${index}`} className={`rounded-lg border px-2 py-1 ${item.ok ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`} data-testid="activation-item" data-item={item.id} data-ok={item.ok ? "1" : "0"}>
          <p className="font-medium text-slate-900">{item.ok ? "Met" : "Not met"}: {activationItemLabel(item.id)}</p>
          <p className="text-slate-700">{activationDetailReason(item.detail, item.ok)} <code className="break-all text-slate-500">{item.id}: {item.detail || "?"}</code></p>
        </li>
      ))}
    </ul>
  );
}

function StudioCard({ studio, check, reads }: { studio: ActivationStudio; check: ActivationCheck | "unavailable" | undefined; reads: Reads }) {
  if (!check || check === "unavailable") {
    return (
      <li className="rounded-lg border border-slate-200 p-3 text-xs" data-testid="activation-studio" data-studio={studio.studioId}>
        <p className="font-semibold text-slate-900">{studio.name} <span className="font-normal text-slate-600">({studio.state ?? "?"})</span></p>
        <p role="alert" className="mt-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900" data-testid="activation-unavailable">
          The activation checklist could not be read. Do not assume this location is ready.
        </p>
        {/* the emergency stop never depends on the checklist read */}
        {studio.state === "active" ? <div className="mt-2"><SuspendForm studioId={studio.studioId} /></div> : null}
      </li>
    );
  }
  const blocked = ki1Blocking(check.items);
  return (
    <li className="rounded-lg border border-slate-200 p-3 text-xs" data-testid="activation-studio" data-studio={studio.studioId} data-ready={check.ready ? "1" : "0"}>
      <p className="font-semibold text-slate-900">
        {studio.name} <span className="font-normal text-slate-600">state: {check.state ?? studio.state ?? "?"}</span>{" "}
        <span className={check.ready ? "text-emerald-800" : "text-amber-900"} data-testid="activation-ready">{check.ready ? "Checklist: ready" : "Checklist: not ready"}</span>
      </p>
      {blocked ? <Ki1Note /> : null}
      <Checklist items={check.items} />
      <h4 className="mt-3 text-xs font-semibold text-slate-900">Ledger identifiers (read-only, used by every action)</h4>
      <Ledger ledger={check.ledger} />
      <ActivationForms studioId={studio.studioId} check={check} reads={reads} ki1Blocked={blocked} listState={studio.state} />
    </li>
  );
}

export default function Activation({ studios, overview, reads, notice, error, listError = false }: {
  studios: ActivationStudio[]; overview: ActivationOverview; reads: Reads; notice: string | null; error: string | null;
  /** The location list itself could not be read: say so, never "no location". */
  listError?: boolean;
}) {
  return (
    <section id="sms-activation" className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm" data-testid="sms-activation">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Platform administrators only</p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">SMS activation</h2>
      <p className="mt-1 text-xs text-slate-600">
        Manual release only: a location becomes active only when an administrator activates it here and the database confirms every checklist item at that moment.
        Nothing activates automatically. The only provider contact is the read-only compliance and sender reads.
      </p>
      {notice ? <p role="status" className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">{notice}</p> : null}
      {error ? <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900">{error}</p> : null}
      {listError ? (
        <p role="alert" className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-900" data-testid="activation-list-error">
          The location list could not be read. Do not assume no location is active; an active location may need to be suspended. Reload the page.
        </p>
      ) : studios.length === 0 ? (
        <p className="mt-3 text-xs text-slate-600">No location is at the campaign, ready, active or suspended stage.</p>
      ) : (
        <ul className="mt-3 grid gap-3">
          {studios.map((s) => <StudioCard key={s.studioId} studio={s} check={overview[s.studioId]} reads={reads} />)}
        </ul>
      )}
    </section>
  );
}
